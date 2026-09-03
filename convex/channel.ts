import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { api } from "./_generated/api";

// ─── Seed: ensure default channel exists ──────────────────

export const ensureChannel = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();

    if (existing) return existing._id;

    const channelId = await ctx.db.insert("channels", {
      slug: "main",
      name: "PixelShop",
      status: "standby",
      segmentSeconds: 10,
      offline: false,
      items: [],
      pending: [],
    });

    return channelId;
  },
});

// ─── Channel snapshot (for the live page) ─────────────────

export const getChannel = query({
  args: {},
  handler: async (ctx) => {
    const channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();

    if (!channel) return null;

    // Fetch schedule entries
    const scheduleDocs = await ctx.db
      .query("schedule")
      .withIndex("by_channel_start", (q) => q.eq("channelId", channel._id))
      .take(200);

    // Enrich schedule with item + clip data
    const schedule = await Promise.all(
      scheduleDocs.map(async (entry) => {
        const item = await ctx.db.get(entry.itemId);
        const clip = await ctx.db.get(entry.clipId);
        return {
          id: `${entry.clipId}@${entry.startAt}`,
          startAt: entry.startAt,
          duration: entry.durationMs / 1000,
          item: item ? {
            id: item._id,
            itemNumber: item.itemNumber,
            title: item.title,
            url: item.url,
            image: item.image,
            price: item.price,
            generationDone: item.generationDone,
            newestClipAt: item.newestClipAt,
            endless: false, // MVP: no endless generation
          } : null,
          clip: clip ? {
            id: clip._id,
            videoUrl: clip.videoUrl,
            duration: clip.durationMs / 1000,
            dialogue: clip.dialogue,
            source: clip.source,
            question: clip.questionId ? undefined : undefined,
            askedBy: clip.askedBy,
          } : null,
        };
      })
    );

    // Fetch rotation items (ready)
    const itemDocs = await ctx.db
      .query("items")
      .withIndex("by_status", (q) => q.eq("channelId", channel._id).eq("status", "ready"))
      .take(200);

    const rotation = itemDocs.map((item) => ({
      id: item._id,
      itemNumber: item.itemNumber,
      title: item.title,
      url: item.url,
      image: item.image,
      price: item.price,
      generationDone: item.generationDone,
      playbackSeconds: item.playbackSeconds ?? 0,
      newestClipAt: item.newestClipAt ?? 0,
    }));

    // Fetch pending items (queued or working)
    const pendingDocs = await ctx.db
      .query("items")
      .withIndex("by_status", (q) =>
        q.eq("channelId", channel._id).eq("status", "queued")
      )
      .take(50);

    const workingDocs = await ctx.db
      .query("items")
      .withIndex("by_status", (q) =>
        q.eq("channelId", channel._id).eq("status", "working")
      )
      .take(50);

    const pending = [...pendingDocs, ...workingDocs].map((item) => ({
      id: item._id,
      itemNumber: item.itemNumber,
      title: item.title,
      url: item.url,
      image: item.image,
    }));

    // Fetch recent chat (last 200)
    const chatDocs = await ctx.db
      .query("chat")
      .withIndex("by_channel_created", (q) => q.eq("channelId", channel._id))
      .order("desc")
      .take(200);

    const chat = chatDocs.reverse().map((c) => ({
      id: c._id,
      user: c.sender,
      text: c.text,
      role: c.role,
    }));

    return {
      serverNow: Date.now(),
      offline: channel.offline,
      segmentSeconds: channel.segmentSeconds,
      schedule,
      rotation,
      pending,
      chat,
    };
  },
});

// ─── Submit product ───────────────────────────────────────

export const submitProduct = mutation({
  args: {
    url: v.string(),
    title: v.optional(v.string()),
    price: v.optional(v.string()),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Ensure channel exists
    let channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();

    if (!channel) {
      const channelId = await ctx.db.insert("channels", {
        slug: "main",
        name: "PixelShop",
        status: "standby",
        segmentSeconds: 10,
        offline: false,
        items: [],
        pending: [],
      });
      channel = await ctx.db.get(channelId);
    }

    const channelId = channel!._id;

    // Generate item number: PX-<count>
    const existingItems = await ctx.db
      .query("items")
      .withIndex("by_channel", (q) => q.eq("channelId", channelId))
      .collect();
    const itemNumber = `PX-${1000 + existingItems.length + 1}`;

    const itemId = await ctx.db.insert("items", {
      channelId,
      url: args.url,
      title: args.title ?? "Processing…",
      price: args.price,
      image: args.image,
      itemNumber,
      status: "queued",
      generationDone: false,
      playbackSeconds: 0,
    });

    // Add to channel pending list
    await ctx.db.patch(channelId, {
      pending: [...channel!.pending, itemId],
      status: channel!.status === "offline" ? "offline" : "live",
    });

    return { itemId, itemNumber };
  },
});

// ─── Send chat message ───────────────────────────────────

export const sendChat = mutation({
  args: {
    sender: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();

    if (!channel) throw new Error("Channel not found");

    await ctx.db.insert("chat", {
      channelId: channel._id,
      sender: args.sender,
      text: args.text,
      role: "viewer" as const,
    });
  },
});

// ─── Get item status (for polling) ───────────────────────

export const getItem = query({
  args: { itemId: v.id("items") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.itemId);
    if (!item) return null;
    return {
      id: item._id,
      itemNumber: item.itemNumber,
      title: item.title,
      url: item.url,
      image: item.image,
      price: item.price,
      status: item.status,
      error: item.error,
    };
  },
});
