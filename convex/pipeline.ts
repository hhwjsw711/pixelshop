import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import * as cheerio from "cheerio";
import { fal } from "@fal-ai/client";

// ─── Query: last schedule end time ─────────────────────────
// Used by the pipeline to append new clips after existing schedule.

export const getLastScheduleEnd = query({
  args: {},
  handler: async (ctx) => {
    const channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();
    if (!channel) return 0;

    const last = await ctx.db
      .query("schedule")
      .withIndex("by_channel_start", (q) => q.eq("channelId", channel._id))
      .order("desc")
      .first();

    return last ? last.startAt + last.durationMs : 0;
  },
});

// ─── Mutations (called by the action to update DB) ─────────

export const updateItemDetails = mutation({
  args: {
    itemId: v.id("items"),
    title: v.string(),
    price: v.optional(v.string()),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, {
      title: args.title,
      price: args.price,
      image: args.image,
    });
  },
});

export const markItemWorking = mutation({
  args: { itemId: v.id("items") },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.itemId, { status: "working" });
  },
});

export const addClipToSchedule = mutation({
  args: {
    itemId: v.id("items"),
    videoUrl: v.string(),
    dialogue: v.string(),
    clipIndex: v.number(),
    durationMs: v.number(),
    startAt: v.number(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");

    const clipId = await ctx.db.insert("clips", {
      channelId: item.channelId,
      itemId: args.itemId,
      videoUrl: args.videoUrl,
      durationMs: args.durationMs,
      dialogue: args.dialogue,
      source: "normal",
      status: "ready",
      retryCount: 0,
      clipIndex: args.clipIndex,
    });

    await ctx.db.insert("schedule", {
      channelId: item.channelId,
      itemId: args.itemId,
      clipId,
      startAt: args.startAt,
      durationMs: args.durationMs,
    });

    await ctx.db.patch(args.itemId, {
      newestClipAt: Date.now(),
    });

    return clipId;
  },
});

export const finalizeItem = mutation({
  args: { itemId: v.id("items") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");

    await ctx.db.patch(args.itemId, {
      status: "ready",
      generationDone: true,
    });

    // Add to channel rotation, remove from pending
    const channel = await ctx.db.get(item.channelId);
    if (channel) {
      await ctx.db.patch(item.channelId, {
        items: [...channel.items, args.itemId],
        pending: channel.pending.filter((id) => id !== args.itemId),
      });
    }
  },
});

export const failItem = mutation({
  args: {
    itemId: v.id("items"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) throw new Error("Item not found");

    await ctx.db.patch(args.itemId, {
      status: "failed",
      error: args.error,
    });

    // Remove from pending
    const channel = await ctx.db.get(item.channelId);
    if (channel) {
      await ctx.db.patch(item.channelId, {
        pending: channel.pending.filter((id) => id !== args.itemId),
      });
    }
  },
});

// ─── Pipeline Action ───────────────────────────────────────
// Orchestrates: scrape → OpenAI script → fal H3 video gen → Convex updates

const CLIP_DURATION = 10; // seconds per clip
const CLIP_DURATION_MS = 10000;
const TURBO_T2V = "minimax/h3-max-turbo/text-to-video";

interface ScriptClip {
  videoPrompt: string;
  dialogue: string;
}

const SYSTEM_PROMPT = `You are the scriptwriter for PixelShop, an AI shopping channel where an AI host presents products in generated video clips. Each clip is 10 seconds. You will receive product information and write 3 consecutive clips that form a complete product presentation.

Each clip has:
- videoPrompt: A visual description for the AI video model. Describe what the camera sees: the setting, the product, the host's actions. Include the spoken line in double quotes using this format: The host says, "line here" and continues without another word. Keep the full prompt under 420 characters. End with: Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.
- dialogue: The exact spoken line (shown as subtitle), extracted from the videoPrompt without quotes.

The 3 clips should follow this arc:
1. Introduction: Host introduces the product with excitement
2. Feature highlight: Host demonstrates or describes key features
3. Call to action: Host urges viewers to buy now

Return ONLY a JSON object with a "clips" array, no markdown fences:
{"clips": [{"videoPrompt": "...", "dialogue": "..."}]}`;

const FALLBACK_CLIPS: ScriptClip[] = [
  {
    videoPrompt: `A bright modern TV shopping studio with colorful lights. A charismatic host stands next to a product on a pedestal and gestures toward it with excitement. The host says, "Welcome to PixelShop! Today we have something amazing for you." and continues without another word. Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.`,
    dialogue: "Welcome to PixelShop! Today we have something amazing for you.",
  },
  {
    videoPrompt: `Close-up of a product on a pedestal in a bright TV shopping studio. A host gestures toward the product features with enthusiasm. The host says, "Look at this incredible design and quality." and continues without another word. Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.`,
    dialogue: "Look at this incredible design and quality.",
  },
  {
    videoPrompt: `A host in a TV shopping studio points toward a glowing BUY NOW button overlay. The host says, "Don't wait — buy now before it's gone!" and continues without another word. Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.`,
    dialogue: "Don't wait — buy now before it's gone!",
  },
];

// ─── Helper: scrape product page ────────────────────────────

async function scrapeProduct(
  url: string,
): Promise<{ title?: string; price?: string; image?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return {};
    const html = await response.text();
    const $ = cheerio.load(html);

    const rawTitle =
      $('meta[property="og:title"]').attr("content")?.trim() ||
      $("title").text().trim() ||
      "";
    // Clean up Amazon-style titles: "Amazon.com: Product Name : Category"
    let title: string | undefined = rawTitle.replace(/^Amazon\.com\s*:\s*/i, "").replace(/\s*:\s*\w+\s*$/, "").trim();
    if (title.length > 100) title = title.slice(0, 97) + "...";
    if (!title) title = undefined;

    const image =
      $('meta[property="og:image"]').attr("content")?.trim() ||
      $('meta[name="twitter:image"]').attr("content")?.trim() ||
      undefined;

    // Price: try structured data first, then visible price elements, filter out non-price text
    const rawPrice =
      $('[itemprop="price"]').attr("content")?.trim() ||
      $('meta[property="product:price:amount"]').attr("content")?.trim() ||
      "";
    let price: string | undefined;
    if (rawPrice && /^[\$£€¥¥\d.,\s]+/.test(rawPrice)) {
      price = rawPrice.slice(0, 20);
    } else {
      // Try visible price elements, but filter out non-price text
      const priceText = $('[class*="price"], [id*="price"], [data-price]').first().text().trim();
      if (/^[\$£€¥¥]?[\d,]+\.?\d{0,2}/.test(priceText)) {
        price = priceText.slice(0, 20);
      }
    }

    return { title, price, image };
  } catch {
    return {};
  }
}

// ─── Helper: generate script via OpenAI ─────────────────────

async function generateScript(
  title: string,
  price: string | undefined,
  url: string,
): Promise<ScriptClip[]> {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error("No OpenAI key");

    const userPrompt = `Product: ${title}${price ? `\nPrice: ${price}` : ""}\nURL: ${url}\n\nWrite 3 clips for this product presentation.`;

    // Use fetch directly — OpenAI SDK is incompatible with Convex's action runtime
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
        max_tokens: 1200,
        temperature: 0.8,
      }),
    });

    if (!response.ok) throw new Error(`OpenAI API error: ${response.status}`);

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("No response from OpenAI");

    const parsed = JSON.parse(content);
    const clips = parsed.clips;
    if (!Array.isArray(clips) || clips.length === 0)
      throw new Error("Invalid script format");

    return clips
      .map((c: { videoPrompt?: string; dialogue?: string }) => ({
        videoPrompt:
          typeof c.videoPrompt === "string"
            ? c.videoPrompt.slice(0, 500)
            : FALLBACK_CLIPS[0].videoPrompt,
        dialogue:
          typeof c.dialogue === "string"
            ? c.dialogue.slice(0, 200)
            : FALLBACK_CLIPS[0].dialogue,
      }))
      .slice(0, 3);
  } catch {
    return FALLBACK_CLIPS;
  }
}

// ─── The pipeline action ───────────────────────────────────

export const runPipeline = action({
  args: { itemId: v.id("items") },
  handler: async (ctx, args): Promise<void> => {
    // Check FAL_KEY — essential for video generation
    if (!process.env.FAL_KEY) {
      await ctx.runMutation(api.pipeline.failItem, {
        itemId: args.itemId,
        error: "FAL_KEY not set. Run: npx convex env set FAL_KEY <key>",
      });
      return;
    }

    fal.config({ credentials: process.env.FAL_KEY });

    try {
      // 1. Get item details
      const item = await ctx.runQuery(api.channel.getItem, {
        itemId: args.itemId,
      });
      if (!item) throw new Error("Item not found");

      let title = item.title;
      let price = item.price;
      let image = item.image;

      // 2. Scrape URL if title is still placeholder
      if (title === "Processing…") {
        const scraped = await scrapeProduct(item.url);
        if (scraped.title) title = scraped.title;
        if (scraped.price) price = scraped.price;
        if (scraped.image) image = scraped.image;
        if (title === "Processing…") title = "Untitled Product";

        await ctx.runMutation(api.pipeline.updateItemDetails, {
          itemId: args.itemId,
          title,
          price,
          image,
        });
      }

      // 3. Mark item as working
      await ctx.runMutation(api.pipeline.markItemWorking, {
        itemId: args.itemId,
      });

      // 4. Generate script (OpenAI → fallback clips on failure)
      const clips = await generateScript(title, price, item.url);

      // 5. Calculate schedule start: 3s from now, or after existing schedule
      const lastEndAt = await ctx.runQuery(api.pipeline.getLastScheduleEnd, {});
      let scheduleStart = Math.max(Date.now() + 3000, lastEndAt + 1000);

      // 6. Generate videos with fal H3, add each to schedule as ready
      let successCount = 0;
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        try {
          const result = await fal.subscribe(TURBO_T2V, {
            input: {
              prompt: clip.videoPrompt,
              duration: CLIP_DURATION,
              resolution: "768P",
              aspect_ratio: "16:9",
              prompt_expansion_mode: "balanced",
            },
            pollInterval: 500,
          });

          const data = result.data as { video?: { url?: string } };
          const rawUrl = data?.video?.url;
          if (!rawUrl) throw new Error("No video in fal response");

          // Ensure startAt is never in the past: if generation took longer
          // than expected, push the start time forward
          const actualStart = Math.max(scheduleStart, Date.now() + 2000);

          await ctx.runMutation(api.pipeline.addClipToSchedule, {
            itemId: args.itemId,
            videoUrl: rawUrl,
            dialogue: clip.dialogue,
            clipIndex: i,
            durationMs: CLIP_DURATION_MS,
            startAt: actualStart,
          });

          scheduleStart = actualStart + CLIP_DURATION_MS;
          successCount++;
        } catch (e) {
          console.error(`Clip ${i} generation failed:`, e);
          // Continue with next clip
        }
      }

      // 7. Finalize or fail
      if (successCount === 0) {
        await ctx.runMutation(api.pipeline.failItem, {
          itemId: args.itemId,
          error: "All clips failed to generate",
        });
        return;
      }

      await ctx.runMutation(api.pipeline.finalizeItem, {
        itemId: args.itemId,
      });
    } catch (e) {
      console.error("Pipeline failed:", e);
      try {
        await ctx.runMutation(api.pipeline.failItem, {
          itemId: args.itemId,
          error: e instanceof Error ? e.message : "Pipeline failed",
        });
      } catch {
        // If even failItem fails, nothing more we can do
      }
    }
  },
});
