import { query, mutation, internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { v } from "convex/values";

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

    // Fetch schedule entries — recent past (5 min) + all future
    // 5-min window keeps PAST PRODUCTS visible long enough for viewers
    // to see what just aired, while limiting DB reads.
    const now = Date.now();
    const scheduleDocs = (await ctx.db
      .query("schedule")
      .withIndex("by_channel_start", (q) =>
        q.eq("channelId", channel._id).gte("startAt", now - 300_000)
      )
      .order("asc")
      .take(50)).reverse();

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

// --- URL validation (SSRF protection) ---

const BLOCKED_HOST_PATTERNS =
  /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.|::1|fe80:|localhost)/i;

function validateProductUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  if (BLOCKED_HOST_PATTERNS.test(parsed.hostname.toLowerCase())) return null;
  return parsed.href;
}

export const submitProduct = mutation({
  args: {
    url: v.string(),
    title: v.optional(v.string()),
    price: v.optional(v.string()),
    image: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // --- SSRF: validate URL on the backend ---
    const validatedUrl = validateProductUrl(args.url);
    if (!validatedUrl) throw new Error("Invalid product URL");

    // --- Rate limit: max 5 queued/working items in the last 10 minutes ---
    const tenMinAgo = Date.now() - 600_000;
    const ch = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();
    if (ch) {
      const recentQueued = await ctx.db
        .query("items")
        .withIndex("by_status", (q) =>
          q.eq("channelId", ch._id).eq("status", "queued"),
        )
        .filter((q) => q.gt(q.field("_creationTime"), tenMinAgo))
        .take(10);
      const recentWorking = await ctx.db
        .query("items")
        .withIndex("by_status", (q) =>
          q.eq("channelId", ch._id).eq("status", "working"),
        )
        .filter((q) => q.gt(q.field("_creationTime"), tenMinAgo))
        .take(10);
      if (recentQueued.length + recentWorking.length >= 5) {
        throw new Error("Too many submissions. Please wait a few minutes.");
      }
    }

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

    if (!channel) throw new Error("Failed to create channel");
    const channelId = channel._id;

    // Generate item number: PX-<max+1> (avoids collision after deletion)
    const allItems = await ctx.db
      .query("items")
      .withIndex("by_channel", (q) => q.eq("channelId", channelId))
      .collect();
    const maxNum = allItems.reduce((max, it) => {
      const n = parseInt(it.itemNumber.replace("PX-", ""), 10);
      return isNaN(n) ? max : Math.max(max, n);
    }, 1000);
    const itemNumber = `PX-${maxNum + 1}`;

    const itemId = await ctx.db.insert("items", {
      channelId,
      url: validatedUrl,
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
      pending: [...channel.pending, itemId],
      status: channel.status === "offline" ? "offline" : "live",
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

    const sender = args.sender.trim().slice(0, 30);
    const text = args.text.trim().slice(0, 300);
    if (!text) throw new Error("Empty message");

    await ctx.db.insert("chat", {
      channelId: channel._id,
      sender,
      text,
      role: "viewer" as const,
    });
  },
});

// ─── Seed mock data (P1 testing) ────────────────────────
// Inserts 3 mock items with clips + schedule entries for playback testing.
// Uses public sample MP4s (Big Buck Bunny / Sintel clips from Google storage).

const MOCK_VIDEOS = [
  { url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/720/Big_Buck_Bunny_720_10s_2MB.mp4", title: "Big Buck Bunny", price: "$19.99", dialogue: "Welcome to PixelShop! Today's first feature — Big Buck Bunny, the classic animated short. A story of revenge and justice in the forest.", image: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Big_buck_bunny_poster_big.jpg/320px-Big_buck_bunny_poster_big.jpg" },
  { url: "https://test-videos.co.uk/vids/jellyfish/mp4/h264/720/Jellyfish_720_10s_1MB.mp4", title: "Jellyfish Showcase", price: "$24.99", dialogue: "Our second feature — Jellyfish in crystal-clear 720p. A mesmerizing underwater showcase for the PixelShop player.", image: undefined as string | undefined },
  { url: "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4", title: "Bunny Encore (360p)", price: "$9.99", dialogue: "And now, an encore presentation at 360p — a perfect demo of the PixelShop player's smooth resolution transitions.", image: undefined as string | undefined },
];

export const seedMockData = mutation({
  args: {},
  handler: async (ctx) => {
    // Ensure channel
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
      channel = await ctx.db.get(channelId)!;
    }

    // Check if already seeded
    const existingClips = await ctx.db
      .query("clips")
      .withIndex("by_channel_status", (q) => q.eq("channelId", channel!._id))
      .first();
    if (existingClips) {
      return { seeded: false, message: "Mock data already exists" };
    }

    const now = Date.now();
    // Start schedule 5 seconds from now to allow client to load
    let scheduleStart = now + 5000;
    const itemIds: Id<"items">[] = [];

    for (let i = 0; i < MOCK_VIDEOS.length; i++) {
      const mv = MOCK_VIDEOS[i];

      // Create item
      const itemId = await ctx.db.insert("items", {
        channelId: channel!._id,
        url: mv.url,
        title: mv.title,
        price: mv.price,
        image: mv.image,
        itemNumber: `PX-${1000 + i + 1}`,
        status: "ready",
        generationDone: true,
        playbackSeconds: 0,
      });
      itemIds.push(itemId);

      // Create one clip per item (10s each)
      const clipId = await ctx.db.insert("clips", {
        channelId: channel!._id,
        itemId,
        videoUrl: mv.url,
        durationMs: 10000,
        dialogue: mv.dialogue,
        source: "normal",
        status: "ready",
        retryCount: 0,
        clipIndex: 0,
      });

      // Add to schedule
      await ctx.db.insert("schedule", {
        channelId: channel!._id,
        itemId,
        clipId,
        startAt: scheduleStart,
        durationMs: 10000,
      });

      scheduleStart += 10000; // next clip starts after this one
    }

    // Update channel
    await ctx.db.patch(channel!._id, {
      items: itemIds,
      pending: [],
      status: "live",
    });

    return { seeded: true, clipCount: MOCK_VIDEOS.length, startsAt: now + 5000 };
  },
});

export const clearMockData = mutation({
  args: { adminKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.adminKey !== process.env.ADMIN_SECRET) {
      throw new Error("Unauthorized: admin key required");
    }
    const channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();
    if (!channel) return { cleared: false };

    // Delete schedule entries in batches
    let deletedSchedule = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await ctx.db
        .query("schedule")
        .withIndex("by_channel_start", (q) => q.eq("channelId", channel._id))
        .take(50);
      if (batch.length === 0) { hasMore = false; break; }
      for (const s of batch) await ctx.db.delete(s._id);
      deletedSchedule += batch.length;
    }

    // Delete clips
    let deletedClips = 0;
    let moreClips = true;
    while (moreClips) {
      const batch = await ctx.db
        .query("clips")
        .withIndex("by_channel_status", (q) => q.eq("channelId", channel._id))
        .take(50);
      if (batch.length === 0) { moreClips = false; break; }
      for (const c of batch) await ctx.db.delete(c._id);
      deletedClips += batch.length;
      if (batch.length < 50) moreClips = false;
    }

    // Delete items
    let deletedItems = 0;
    let moreItems = true;
    while (moreItems) {
      const batch = await ctx.db
        .query("items")
        .withIndex("by_channel", (q) => q.eq("channelId", channel._id))
        .take(50);
      if (batch.length === 0) { moreItems = false; break; }
      for (const it of batch) await ctx.db.delete(it._id);
      deletedItems += batch.length;
      if (batch.length < 50) moreItems = false;
    }

    await ctx.db.patch(channel._id, {
      items: [],
      pending: [],
      status: "standby",
    });

    return { cleared: true, deletedSchedule, deletedClips, deletedItems };
  },
});

// ─── Delete a single item + its clips + schedule entries ──

export const deleteItem = mutation({
  args: {
    itemId: v.id("items"),
    adminKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.adminKey !== process.env.ADMIN_SECRET) {
      throw new Error("Unauthorized: admin key required");
    }
    const item = await ctx.db.get(args.itemId);
    if (!item) return { deleted: false, reason: "not found" };

    // Delete schedule entries for this item (batch to avoid read limit)
    let deletedSchedule = 0;
    let hasMore = true;
    while (hasMore) {
      const batch = await ctx.db
        .query("schedule")
        .withIndex("by_channel_start", (q) => q.eq("channelId", item.channelId))
        .take(100);
      if (batch.length === 0) { hasMore = false; break; }
      for (const s of batch) {
        if (s.itemId === args.itemId) await ctx.db.delete(s._id);
      }
      deletedSchedule += batch.filter((s) => s.itemId === args.itemId).length;
      if (batch.length < 100) hasMore = false;
    }

    // Delete clips for this item
    const clips = await ctx.db
      .query("clips")
      .withIndex("by_item", (q) => q.eq("itemId", args.itemId))
      .collect();
    for (const c of clips) await ctx.db.delete(c._id);

    // Remove from channel items + pending arrays
    const channel = await ctx.db.get(item.channelId);
    if (channel) {
      await ctx.db.patch(channel._id, {
        items: channel.items.filter((id) => id !== args.itemId),
        pending: channel.pending.filter((id) => id !== args.itemId),
      });
    }

    // Delete the item itself
    await ctx.db.delete(args.itemId);

    return {
      deleted: true,
      deletedSchedule,
      deletedClips: clips.length,
    };
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

// ─── Rotate schedule (cron-triggered) ─────────────────────
// When the schedule is about to end, re-queue rotation items' clips.
// Round-robin: starts from the next item after the last played one.
// Adds enough cycles to cover at least 2 minutes of future content.

export const rotateSchedule = internalMutation({
  args: {},
  handler: async (ctx) => {
    const channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();
    if (!channel) return { rotated: false, reason: "no channel" };

    const now = Date.now();

    // ── Clean up expired schedule entries (endAt < now) ──
    // Prevents the schedule table from growing unbounded.
    // Also accumulates playback seconds per item before deletion.
    // Uses the by_channel_start index: old entries have small startAt.
    // We query a batch of entries ordered ascending and delete those
    // whose (startAt + durationMs) < now. Stop at first non-expired.
    let cleaned = 0;
    const playbackDelta = new Map<string, number>(); // itemId → seconds to add
    let cleanupDone = false;
    while (!cleanupDone) {
      const batch = await ctx.db
        .query("schedule")
        .withIndex("by_channel_start", (q) => q.eq("channelId", channel._id))
        .order("asc")
        .take(50);
      if (batch.length === 0) { cleanupDone = true; break; }
      let allExpired = true;
      for (const entry of batch) {
        if (entry.startAt + entry.durationMs < now) {
          // Accumulate playback seconds before deleting
          const seconds = entry.durationMs / 1000;
          playbackDelta.set(entry.itemId, (playbackDelta.get(entry.itemId) ?? 0) + seconds);
          await ctx.db.delete(entry._id);
          cleaned++;
        } else {
          allExpired = false;
          break;
        }
      }
      if (!allExpired || batch.length < 50) { cleanupDone = true; }
    }

    // Apply accumulated playback seconds to items
    for (const [itemId, seconds] of playbackDelta) {
      const item = await ctx.db.get(itemId as Id<"items">);
      if (item) {
        await ctx.db.patch(itemId as Id<"items">, {
          playbackSeconds: (item.playbackSeconds ?? 0) + seconds,
        });
      }
    }

    // Get the last schedule entry
    const lastEntry = await ctx.db
      .query("schedule")
      .withIndex("by_channel_start", (q) => q.eq("channelId", channel._id))
      .order("desc")
      .first();
    if (!lastEntry) return { rotated: false, reason: "no schedule", cleaned };

    const lastEndAt = lastEntry.startAt + lastEntry.durationMs;

    // Only rotate if schedule ends within 60 seconds (or already ended)
    if (lastEndAt > now + 60_000) return { rotated: false, reason: "not ending soon" };

    // Get rotation items
    const rotationIds = channel.items;
    if (rotationIds.length === 0) return { rotated: false, reason: "no rotation items" };

    // Round-robin: find the next item after the last played one
    const lastIndex = rotationIds.findIndex((id) => id === lastEntry.itemId);
    let nextIndex = lastIndex >= 0 ? (lastIndex + 1) % rotationIds.length : 0;

    // Add rotation cycles until we have at least 2 minutes of future content
    let scheduleStart = Math.max(lastEndAt, now + 2000);
    let added = 0;
    const targetEnd = now + 120_000; // 2 minutes from now
    let safety = 0;

    while (scheduleStart < targetEnd && safety < 100) {
      const itemId = rotationIds[nextIndex % rotationIds.length];

      // Get this item's ready clips, ordered by clipIndex
      const allClips = await ctx.db
        .query("clips")
        .withIndex("by_item", (q) => q.eq("itemId", itemId))
        .collect();
      const readyClips = allClips
        .filter((c) => c.status === "ready")
        .sort((a, b) => a.clipIndex - b.clipIndex);

      for (const clip of readyClips) {
        await ctx.db.insert("schedule", {
          channelId: channel._id,
          itemId,
          clipId: clip._id,
          startAt: scheduleStart,
          durationMs: clip.durationMs,
        });
        scheduleStart += clip.durationMs;
        added++;
      }

      nextIndex++;
      safety++;
    }

    // Ensure channel is live
    if (channel.status !== "live") {
      await ctx.db.patch(channel._id, { status: "live" });
    }

    return { rotated: true, added, cleaned };
  },
});

// --- Recover stuck items (cron-triggered every 5 min) ---
// Marks items stuck in "working" for >5 min as failed so the UI shows an error
// instead of spinning forever.

export const recoverStuckItems = internalMutation({
  args: {},
  handler: async (ctx) => {
    const fiveMinAgo = Date.now() - 300_000;
    const channel = await ctx.db
      .query("channels")
      .withIndex("by_slug", (q) => q.eq("slug", "main"))
      .first();
    if (!channel) return { recovered: 0 };
    const stuck = await ctx.db
      .query("items")
      .withIndex("by_status", (q) => q.eq("channelId", channel._id).eq("status", "working"))
      .filter((q) => q.lt(q.field("_creationTime"), fiveMinAgo))
      .collect();
    for (const item of stuck) {
      await ctx.db.patch(item._id, {
        status: "failed",
        error: "Generation timed out",
      });
      // Remove from pending
      const channel = await ctx.db.get(item.channelId);
      if (channel) {
        await ctx.db.patch(item.channelId, {
          pending: channel.pending.filter((id) => id !== item._id),
        });
      }
    }
    return { recovered: stuck.length };
  },
});

