import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// 鈹€鈹€鈹€ Schema 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 5 tables per the design doc:
//   channels  鈥?single channel for MVP
//   items     鈥?products submitted by users
//   clips     鈥?generated video segments
//   schedule  鈥?time-ordered playback entries
//   chat      鈥?live chat messages

export default defineSchema({
  // 鈹€鈹€ Channel 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  channels: defineTable({
    slug: v.string(),
    name: v.string(),
    status: v.union(
      v.literal("offline"),
      v.literal("live"),
      v.literal("standby"),
    ),
    segmentSeconds: v.number(),      // default 10
    offline: v.boolean(),
    items: v.array(v.id("items")),     // ready items (rotation)
    pending: v.array(v.id("items")),   // generating items
  }).index("by_slug", ["slug"]),

  // 鈹€鈹€ Items (products) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  items: defineTable({
    channelId: v.id("channels"),
    url: v.string(),
    title: v.string(),
    price: v.optional(v.string()),
    image: v.optional(v.string()),
    itemNumber: v.string(),
    status: v.union(
      v.literal("queued"),
      v.literal("working"),
      v.literal("ready"),
      v.literal("failed"),
    ),
    generationDone: v.boolean(),
    newestClipAt: v.optional(v.number()),  // ms timestamp of latest clip
    error: v.optional(v.string()),
    firstFrameUrl: v.optional(v.string()), // first frame for clip 1
    lastFrameUrl: v.optional(v.string()),  // last frame of latest clip (for continuity)
    playbackSeconds: v.optional(v.number()), // accumulated air time
  }).index("by_channel", ["channelId"])
    .index("by_status", ["channelId", "status"]),

  // 鈹€鈹€ Clips (generated video segments) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  clips: defineTable({
    channelId: v.id("channels"),
    itemId: v.id("items"),
    videoUrl: v.optional(v.string()),       // set when clip is ready
    durationMs: v.number(),                   // e.g. 10000
    dialogue: v.string(),                     // subtitle text + audio prompt
    source: v.union(
      v.literal("normal"),
      v.literal("question"),
    ),
    questionId: v.optional(v.string()),
    askedBy: v.optional(v.string()),
    status: v.union(
      v.literal("queued"),
      v.literal("ready"),
      v.literal("playing"),
      v.literal("done"),
      v.literal("failed"),
    ),
    retryCount: v.number(),
    clipIndex: v.number(),  // 0, 1, 2... position within item
  }).index("by_item", ["itemId"])
    .index("by_channel_status", ["channelId", "status"]),

  // 鈹€鈹€ Schedule (playback time-axis) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  schedule: defineTable({
    channelId: v.id("channels"),
    itemId: v.id("items"),
    clipId: v.id("clips"),
    startAt: v.number(),    // ms timestamp (server time)
    durationMs: v.number(),
  }).index("by_channel_start", ["channelId", "startAt"]),

  // 鈹€鈹€ Chat 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  chat: defineTable({
    channelId: v.id("channels"),
    sender: v.string(),
    text: v.string(),
    role: v.union(
      v.literal("viewer"),
      v.literal("host"),
    ),
    queueInClipId: v.optional(v.id("clips")),
  }).index("by_channel_created", ["channelId"]),
});
