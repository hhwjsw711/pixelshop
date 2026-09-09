import { action, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import * as cheerio from "cheerio";
import { fal } from "@fal-ai/client";

// ─── Firecrawl scrape endpoint ───────────────────────────
const FIRECRAWL_SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

// ─── AgentMail API ───────────────────────────────────────
const AGENTMAIL_BASE_URL = "https://api.agentmail.to/v0";

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

    // --- S3 fix: re-read latest schedule end inside the mutation ---
    // Convex mutations are serialized, so this read is always fresh.
    // The action's getLastScheduleEnd query may be stale (action stale-read).
    const lastEntry = await ctx.db
      .query("schedule")
      .withIndex("by_channel_start", (q) => q.eq("channelId", item.channelId))
      .order("desc")
      .first();
    const realLastEnd = lastEntry ? lastEntry.startAt + lastEntry.durationMs : 0;
    const actualStart = Math.max(args.startAt, realLastEnd + 1000, Date.now() + 1000);

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
      startAt: actualStart,
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
      // Deduplicate: only add if not already in items array
      if (!channel.items.includes(args.itemId)) {
        await ctx.db.patch(item.channelId, {
          items: [...channel.items, args.itemId],
          pending: channel.pending.filter((id) => id !== args.itemId),
        });
      } else {
        // Already in rotation, just remove from pending
        await ctx.db.patch(item.channelId, {
          pending: channel.pending.filter((id) => id !== args.itemId),
        });
      }
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

const TURBO_T2V = "minimax/h3-max-turbo/text-to-video";
const TURBO_I2V = "minimax/h3-max-turbo/image-to-video";
const MIN_DURATION = 5;
const MAX_DURATION = 10;

interface ScriptClip {
  videoPrompt: string;
  dialogue: string;
  durationSec: number; // 5-10 seconds, calculated from word count
}

// ─── Smart duration: match video length to dialogue word count ─────────
// Formula: ceil(words / 2.8), clamped to [5, 10]
// ~2.8 words/second is natural English speaking pace for AI video hosts
function smartDuration(dialogue: string): number {
  const words = dialogue.trim().split(/\s+/).length;
  return Math.max(MIN_DURATION, Math.min(MAX_DURATION, Math.ceil(words / 2.8)));
}

// ─── Channel persona ────────────────────────────────────
// Defines the host character and studio setting for visual consistency.
// Used in every videoPrompt to give the AI video model a consistent anchor.
const HOST_PERSONA = "Max Flex, an original fictional American shopping television host, 35 years old, neatly styled dark hair, clean shaven, energetic friendly face, fitted charcoal blazer, white v-neck shirt, blue sneaker trainers. Enthusiastic professional salesman voice with a warm American accent. He is charismatic, high-energy and genuinely excited about every product.";
const STUDIO_SETTING = "Photorealistic modern 2020s AI shopping television studio, dark backdrop with neon pink and cyan accent lights, glossy black floor, floating product pedestal with spotlight. One presenter only. Wide horizontal 16:9 composition. No generated text, captions, logos, watermarks or prices on screen.";

const SYSTEM_PROMPT = `You are the scriptwriter for PixelShop, an AI shopping channel where Max Flex presents products in generated video clips. You will receive product information and write 3 consecutive clips that form a complete product presentation.

The host is: ${HOST_PERSONA}
The studio is: ${STUDIO_SETTING}

Each clip has:
- videoPrompt: A visual description for the AI video model. Start every prompt with the studio setting and host description, then describe what happens. Include the spoken line in double quotes using this format: The host says, "line here" and continues without another word. Keep the full prompt under 450 characters. End with: Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.
- dialogue: The exact spoken line (shown as subtitle), extracted from the videoPrompt without quotes. Must be 8-25 words for natural pacing.
- durationSec: The video duration in seconds, calculated as ceil(word_count / 2.8), clamped to [5, 10]. Include this for each clip.

The 3 clips should follow this arc:
1. Introduction: Max introduces the product with excitement (10-25 words)
2. Feature highlight: Max demonstrates or describes key features (10-25 words)
3. Call to action: Max urges viewers to buy now (8-20 words)

NEVER repeat dialogue lines from previous clips. Each clip must have unique wording.

Return ONLY a JSON object with a "clips" array, no markdown fences:
{"clips": [{"videoPrompt": "...", "dialogue": "...", "durationSec": 5}]}`;

const FALLBACK_CLIPS: ScriptClip[] = [
  {
    videoPrompt: `${STUDIO_SETTING} ${HOST_PERSONA} Max stands next to a product on a pedestal and gestures toward it with excitement. The host says, "Welcome to PixelShop! Today we have something amazing for you." and continues without another word. Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.`,
    dialogue: "Welcome to PixelShop! Today we have something amazing for you.",
    durationSec: 5,
  },
  {
    videoPrompt: `${STUDIO_SETTING} ${HOST_PERSONA} Close-up of a product on a pedestal. Max gestures toward the product features with enthusiasm. The host says, "Look at this incredible design and quality." and continues without another word. Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.`,
    dialogue: "Look at this incredible design and quality.",
    durationSec: 5,
  },
  {
    videoPrompt: `${STUDIO_SETTING} ${HOST_PERSONA} Max points toward a glowing BUY NOW button overlay. The host says, "Don't wait — buy now before it's gone!" and continues without another word. Sound: ambient studio audio; the only spoken words are the exact quoted line, delivered clearly in English; all other voices are wordless.`,
    dialogue: "Don't wait — buy now before it's gone!",
    durationSec: 5,
  },
];

// ─── Helper: scrape product page ────────────────────────────

// --- SSRF protection for scrapeProduct ---

const BLOCKED_HOST_RE =
  /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.|::1|fe80:|localhost)/i;

function isSafeUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    if (BLOCKED_HOST_RE.test(u.hostname.toLowerCase())) return false;
    return true;
  } catch {
    return false;
  }
}

// ─── Helper: send notification email via AgentMail ──────

async function sendNotificationEmail(
  inboxId: string,
  to: string,
  subject: string,
  html: string,
  text: string,
): Promise<boolean> {
  const key = process.env.AGENTMAIL_API_KEY;
  if (!key || !inboxId) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      `${AGENTMAIL_BASE_URL}/inboxes/${inboxId}/messages/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ to, subject, html, text }),
        signal: controller.signal,
      },
    );
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

// ─── HTML email template for product-live notifications ──────

function buildProductLiveEmail(data: {
  title: string;
  price?: string;
  image?: string;
  url: string;
  itemNumber: string;
  clipCount: number;
  totalDuration: number;
}): string {
  const priceBlock = data.price
    ? `<tr><td style="padding:0 0 8px"><span style="font-size:28px;font-weight:800;color:#ffd24a;letter-spacing:-0.02em">${data.price}</span></td></tr>`
    : "";
  const imageBlock = data.image
    ? `<tr><td style="padding:0 0 20px"><img src="${data.image}" alt="${data.title}" style="width:100%;max-width:480px;border-radius:12px;border:1px solid #ffffff15" /></td></tr>`
    : "";
  const durSec = Math.round(data.totalDuration / 1000);

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;min-height:100vh">
<tr><td align="center" style="padding:32px 16px">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#141019;border-radius:16px;border:1px solid #ffffff10;overflow:hidden">
  <tr><td style="padding:24px 32px 0;text-align:center">
    <span style="font-size:22px;font-weight:800;letter-spacing:-0.03em;color:#ff2d78">PIXELSHOP</span>
    <span style="font-size:10px;font-weight:500;letter-spacing:0.25em;color:#38e8ff;opacity:0.7;margin-left:8px">AI SHOPPING NETWORK</span>
  </td></tr>
  <tr><td style="padding:4px 32px 24px;text-align:center">
    <p style="font-size:11px;font-weight:600;letter-spacing:0.15em;color:#ff2d78;margin:0">● YOU'RE ON AIR</p>
  </td></tr>
  <tr><td style="padding:0 32px">
    <table width="100%" cellpadding="0" cellspacing="0">
      ${imageBlock}
      <tr><td style="padding:0 0 6px"><span style="font-size:11px;font-weight:700;letter-spacing:0.1em;color:#ffd24a;background:#ffd24a15;padding:3px 8px;border-radius:4px">ITEM ${data.itemNumber}</span></td></tr>
      <tr><td style="padding:0 0 8px"><h2 style="font-size:20px;font-weight:700;color:#ffffff;margin:0;line-height:1.3">${data.title}</h2></td></tr>
      ${priceBlock}
      <tr><td style="padding:0 0 16px"><p style="font-size:13px;color:#9ca3af;margin:0">${data.clipCount} clips generated &middot; ${durSec}s total runtime &middot; now airing in rotation</p></td></tr>
    </table>
  </td></tr>
  <tr><td style="padding:0 32px 32px" align="center">
    <a href="https://fearless-otter-334.convex.site" style="display:inline-block;background:linear-gradient(180deg,#ff2d78,#c2185b);color:#ffffff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 40px;border-radius:10px;box-shadow:0 4px 20px rgba(255,45,120,0.3)">WATCH ON PIXELSHOP →</a>
    <p style="font-size:11px;color:#6b7280;margin:16px 0 0"><a href="${data.url}" style="color:#6b7280;text-decoration:underline">View original product page</a></p>
  </td></tr>
  <tr><td style="padding:16px 32px 24px;border-top:1px solid #ffffff08">
    <p style="font-size:10px;color:#4b5563;margin:0;text-align:center;line-height:1.6">PixelShop — The AI Shopping Network<br>Product submitted at ${new Date().toISOString()} UTC</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

// ─── Helper: Firecrawl product scrape (primary) ──────────

async function firecrawlScrape(
  url: string,
): Promise<{ title?: string; price?: string; image?: string; description?: string }> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return {};
  if (!isSafeUrl(url)) return {};

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(FIRECRAWL_SCRAPE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        url,
        formats: ["product"],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return {};
    const payload = (await response.json()) as {
      success?: boolean;
      data?: {
        product?: {
          title?: string;
          brand?: string;
          description?: string;
          variants?: Array<{
            price?: { formatted?: string };
            images?: Array<{ url?: string }>;
            availability?: { inStock?: boolean };
          }>;
        };
      };
    };

    const product = payload.data?.product;
    if (!product) return {};

    const title = product.title?.trim().slice(0, 100) || undefined;
    const description = product.description?.trim().slice(0, 500) || undefined;

    // First variant's price and image
    const variant = product.variants?.[0];
    const price = variant?.price?.formatted?.slice(0, 20) || undefined;
    const image = variant?.images?.[0]?.url || undefined;

    return { title, price, image, description };
  } catch {
    return {};
  }
}

// ─── Helper: cheerio scrape (fallback when Firecrawl unavailable) ──

async function cheerioScrape(
  url: string,
): Promise<{ title?: string; price?: string; image?: string }> {
  // SSRF: reject non-http(s) and private network URLs
  if (!isSafeUrl(url)) return {};
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
    let title: string | undefined = rawTitle.replace(/^Amazon\.com\s*:\s*/i, "").replace(/\s*:\s*\w+\s*$/, "").trim();
    if (title.length > 100) title = title.slice(0, 97) + "...";
    if (!title) title = undefined;

    const image =
      $('meta[property="og:image"]').attr("content")?.trim() ||
      $('meta[name="twitter:image"]').attr("content")?.trim() ||
      undefined;

    const rawPrice =
      $('[itemprop="price"]').attr("content")?.trim() ||
      $('meta[property="product:price:amount"]').attr("content")?.trim() ||
      "";
    let price: string | undefined;
    if (rawPrice && /^[\$£€¥¥\d.,\s]+/.test(rawPrice)) {
      price = rawPrice.slice(0, 20);
    } else {
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

// ─── Unified scrape: Firecrawl first, cheerio fallback ────

async function scrapeProduct(
  url: string,
): Promise<{ title?: string; price?: string; image?: string; description?: string }> {
  // Try Firecrawl product format first (structured, handles JS rendering)
  const firecrawlResult = await firecrawlScrape(url);
  if (firecrawlResult.title) return firecrawlResult;

  // Fallback to cheerio
  return cheerioScrape(url);
}

// ─── Query: recent clip dialogues (for anti-repetition context) ────

export const getRecentDialogues = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();
    if (!channel) return [];

    const ready = await ctx.db
      .query("clips")
      .withIndex("by_channel_status", (q) =>
        q.eq("channelId", channel._id).eq("status", "ready"),
      )
      .order("desc")
      .take(args.limit ?? 5);

    return ready.map((c) => c.dialogue);
  },
});

// ─── Helper: generate script via OpenAI ─────────────────────

async function generateScript(
  title: string,
  price: string | undefined,
  url: string,
  history: string[],
  description?: string,
): Promise<ScriptClip[]> {
  try {
    if (!process.env.OPENAI_API_KEY) throw new Error("No OpenAI key");

    const historyBlock =
      history.length > 0
        ? `\n\nPrevious dialogue lines (do NOT repeat these exact lines):\n${history.map((h, i) => `${i + 1}. "${h}"`).join("\n")}`
        : "";
    const descBlock = description ? `\nDescription: ${description}` : "";

    const userPrompt = `Product: ${title}${price ? `\nPrice: ${price}` : ""}${descBlock}\nURL: ${url}${historyBlock}\n\nWrite 3 clips for this product presentation.`;

    // Use fetch directly — OpenAI SDK is incompatible with Convex's action runtime
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

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
        max_tokens: 1500,
        temperature: 0.85,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

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
      .map(
        (c: { videoPrompt?: string; dialogue?: string; durationSec?: number }) => ({
          videoPrompt:
            typeof c.videoPrompt === "string"
              ? c.videoPrompt.slice(0, 500)
              : FALLBACK_CLIPS[0].videoPrompt,
          dialogue:
            typeof c.dialogue === "string"
              ? c.dialogue.slice(0, 200)
              : FALLBACK_CLIPS[0].dialogue,
          durationSec:
            typeof c.durationSec === "number" &&
            c.durationSec >= MIN_DURATION &&
            c.durationSec <= MAX_DURATION
              ? Math.round(c.durationSec)
              : smartDuration(c.dialogue ?? ""),
        }),
      )
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

    // Idempotency: skip if item is already working or ready
    const existingItem = await ctx.runQuery(api.channel.getItem, {
      itemId: args.itemId,
    });
    if (existingItem?.status === "working" || existingItem?.status === "ready") {
      return; // Already processed or in progress
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
      let productDescription: string | undefined;
      if (title === "Processing…") {
        const scraped = await scrapeProduct(item.url);
        if (scraped.title) title = scraped.title;
        if (scraped.price) price = scraped.price;
        if (scraped.image) image = scraped.image;
        if (scraped.description) productDescription = scraped.description;
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

      // 4. Fetch recent dialogue lines (anti-repetition context)
      let history: string[] = [];
      try {
        history = await ctx.runQuery(api.pipeline.getRecentDialogues, { limit: 5 });
      } catch {
        // Degrade gracefully — no history is better than failing the pipeline
      }

      // 5. Generate script (OpenAI → fallback clips on failure)
      const clips = await generateScript(title, price, item.url, history, productDescription);

      // 6. Calculate schedule start: 3s from now, or after existing schedule
      const lastEndAt = await ctx.runQuery(api.pipeline.getLastScheduleEnd, {});
      let scheduleStart = Math.max(Date.now() + 3000, lastEndAt + 1000);

      // 7. Generate videos with fal H3, add each to schedule as ready
      let successCount = 0;
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        let clipSuccess = false;
        const actualDurationMs = clip.durationSec * 1000;

        // H4: retry each clip up to 2 times with 500ms backoff
        // First clip uses I2V with product image if available; rest use T2V
        const endpoint = i === 0 && image ? TURBO_I2V : TURBO_T2V;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const input: Record<string, unknown> = {
              prompt: clip.videoPrompt,
              duration: clip.durationSec,
              resolution: "768P",
              aspect_ratio: "16:9",
              prompt_expansion_mode: "disabled",
            };
            if (i === 0 && image) {
              input.image_url = image;
            }

            const result = await fal.subscribe(endpoint, {
              input,
              pollInterval: 1000,
            });

            const data = result.data as { video?: { url?: string } };
            const rawUrl = data?.video?.url;
            if (!rawUrl) throw new Error("No video in fal response");

            // Use fal CDN URL directly — no server-side proxy needed since
            // the player uses pure <video> + onEnded (no canvas CORS).
            const videoUrl = rawUrl;

            // startAt is passed as a hint; the mutation will re-read the
            // actual last schedule end to prevent stale-read overlaps.
            const hintStart = Math.max(scheduleStart, Date.now() + 2000);

            await ctx.runMutation(api.pipeline.addClipToSchedule, {
              itemId: args.itemId,
              videoUrl: videoUrl,
              dialogue: clip.dialogue,
              clipIndex: i,
              durationMs: actualDurationMs,
              startAt: hintStart,
            });

            // Use actual duration (not fixed constant) to avoid schedule gaps
            scheduleStart = hintStart + actualDurationMs;
            successCount++;
            clipSuccess = true;
            break; // success, no more retries
          } catch (e) {
            console.error(`Clip ${i} attempt ${attempt + 1} failed:`, e);
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        }

        if (!clipSuccess) {
          console.error(`Clip ${i} failed after 2 attempts, skipping`);
        }
      }

      // 8. Finalize or fail
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

      // 9. Send notification email via AgentMail (fire-and-forget)
      //    Notifies the admin that a new product is live on the channel.
      try {
        const inboxId = process.env.AGENTMAIL_INBOX_ID;
        const notifyTo = process.env.AGENTMAIL_NOTIFY_TO;
        if (inboxId && notifyTo) {
          const totalDurationMs = clips.reduce((sum, c) => sum + c.durationSec * 1000, 0);
          const html = buildProductLiveEmail({
            title,
            price: price ?? undefined,
            image: image ?? undefined,
            url: item.url,
            itemNumber: item.itemNumber,
            clipCount: successCount,
            totalDuration: totalDurationMs,
          });
          const plainText = `"${title}" is now live on PixelShop!${price ? `\nPrice: ${price}` : ""}\nURL: ${item.url}\n\nWatch it at https://fearless-otter-334.convex.site`;
          await sendNotificationEmail(
            inboxId,
            notifyTo,
            `You're on air! ${item.itemNumber} — ${title}`,
            html,
            plainText,
          );
        }
      } catch {
        // Email is best-effort — don't fail the pipeline
      }
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
