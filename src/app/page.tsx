"use client";

import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useEffect, useRef, useState, useCallback } from "react";

// ─── Types (matching Convex return) ───────────────────────

type ChannelData = {
  serverNow: number;
  offline: boolean;
  segmentSeconds: number;
  schedule: ScheduleEntry[];
  rotation: RotationItem[];
  pending: PendingItem[];
  chat: ChatMessage[];
};

type ScheduleEntry = {
  id: string;
  startAt: number;
  duration: number;
  item: {
    id: string;
    itemNumber: string;
    title: string;
    url: string;
    image?: string;
    price?: string;
    generationDone: boolean;
    newestClipAt?: number;
    endless: boolean;
  } | null;
  clip: {
    id: string;
    videoUrl?: string;
    duration: number;
    dialogue: string;
    source: "normal" | "question";
    askedBy?: string;
  } | null;
};

type RotationItem = {
  id: string;
  itemNumber: string;
  title: string;
  url: string;
  image?: string;
  price?: string;
  generationDone: boolean;
  playbackSeconds: number;
  newestClipAt: number;
};

type PendingItem = {
  id: string;
  itemNumber: string;
  title: string;
  url: string;
  image?: string;
};

type ChatMessage = {
  id: string;
  user: string;
  text: string;
  role: "viewer" | "host";
};

// ─── Helper: find current schedule position ──────────────

function findPosition(schedule: ScheduleEntry[], now: number) {
  for (let i = 0; i < schedule.length; i++) {
    const entry = schedule[i];
    const endAt = entry.startAt + entry.duration * 1000;
    if (now >= entry.startAt && now < endAt) {
      return { entry, index: i, offsetMs: now - entry.startAt };
    }
  }
  return null;
}

function findNext(schedule: ScheduleEntry[], now: number) {
  for (const entry of schedule) {
    if (entry.startAt > now) return entry;
  }
  return null;
}

// ─── Standby messages ────────────────────────────────────

const STANDBY_MSGS = [
  "warming up the studio lights…",
  "polishing the display pedestal…",
  "rolling the teleprompter…",
  "adjusting the shoulder pads…",
  "cueing the phone lines…",
  "rehearsing the big reveal…",
  "testing the applause sign…",
  "brewing coffee for the crew…",
];

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function standbyMsg(id: string, t: number) {
  return STANDBY_MSGS[(hashStr(id) + Math.floor(t / 6000)) % STANDBY_MSGS.length];
}

// ─── Color for chat usernames ────────────────────────────

const CHAT_COLORS = ["#ff2d78", "#ffd24a", "#38e8ff", "#8b5cf6", "#22c55e", "#f97316"];

function userColor(name: string) {
  return CHAT_COLORS[hashStr(name) % CHAT_COLORS.length];
}

// ─── Main Page ────────────────────────────────────────────

export default function HomePage() {
  const channel = useQuery(api.channel.getChannel, {});

  // Ensure channel exists on first load
  const ensureChannel = useMutation(api.channel.ensureChannel);
  useEffect(() => {
    ensureChannel({});
  }, [ensureChannel]);

  if (!channel) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="animate-spin h-8 w-8 rounded-full border-2 border-pink border-t-transparent" />
      </main>
    );
  }

  return <ChannelView data={channel} />;
}

// ─── Channel View ────────────────────────────────────────

function ChannelView({ data }: { data: ChannelData }) {
  const [muted, setMuted] = useState(true);
  const [selectedItem, setSelectedItem] = useState<RotationItem | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);

  // Mock data controls (P1 testing)
  const seedMock = useMutation(api.channel.seedMockData);
  const clearMock = useMutation(api.channel.clearMockData);

  const skewRef = useRef(0);
  const [now, setNow] = useState(0);

  // Update clock
  useEffect(() => {
    if (data.serverNow) {
      skewRef.current = data.serverNow - Date.now();
    }
    const interval = setInterval(() => {
      setNow(Date.now() + skewRef.current);
    }, 250);
    return () => clearInterval(interval);
  }, [data.serverNow]);

  const position = findPosition(data.schedule, now);
  const currentEntry = position?.entry ?? null;
  const nextEntry = findNext(data.schedule, now);
  const rotation = data.rotation ?? [];
  const pending = data.pending ?? [];

  return (
    <main className="flex flex-1 flex-col lg:h-screen lg:overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="chrome-text text-2xl tracking-tight font-bold">PIXELSHOP</span>
          <span className="hidden sm:inline font-mono text-[10px] tracking-[0.3em] text-cyan/80">
            THE AI SHOPPING NETWORK
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-xs sm:gap-4">
          <button
            onClick={() => setShowSubmit(true)}
            className="font-bold rounded-md bg-gradient-to-b from-gold to-[#b8860b] px-3 py-1.5 text-[11px] tracking-wide text-black hover:brightness-110"
          >
            + SELL
          </button>
          {/* Mock data controls (P1 testing — remove in production) */}
          {data.schedule.length === 0 && (
            <button
              onClick={() => seedMock({})}
              className="font-bold rounded-md bg-cyan/80 px-3 py-1.5 text-[11px] tracking-wide text-black hover:brightness-110"
            >
              SEED DEMO
            </button>
          )}
          {data.schedule.length > 0 && (
            <button
              onClick={() => clearMock({})}
              className="font-bold rounded-md bg-white/10 px-3 py-1.5 text-[11px] tracking-wide text-zinc-400 hover:bg-white/20"
            >
              CLEAR
            </button>
          )}
          {currentEntry && (
            <span className="flex items-center gap-2 rounded-md bg-pink px-3 py-1.5 text-white font-bold">
              <span className="h-2 w-2 rounded-full bg-white animate-blink" />
              LIVE
            </span>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 flex-col lg:flex-row gap-4 px-4 pb-4 min-h-0">
        {/* Right: Player + Ticker */}
        <div className="flex flex-col gap-3 min-w-0 lg:order-2 lg:flex-1">
          <Player
            entry={currentEntry}
            nextEntry={nextEntry}
            muted={muted}
            onToggleMute={() => setMuted((m) => !m)}
            pendingCount={pending.length}
            hasCurrent={data.schedule.length > 0}
            offline={data.offline}
            loaded={!!data.serverNow}
            skewRef={skewRef}
          />
          {/* Ticker */}
          {rotation.length > 0 && <Ticker rotation={rotation} pending={pending} />}
        </div>

        {/* Left: Product List */}
        <aside className="hidden lg:flex w-80 flex-col gap-3 min-h-0 lg:order-1">
          <SubmitBox offline={data.offline} onSubmitted={() => {}} />
          <ProductList
            rotation={rotation}
            pending={pending}
            currentId={currentEntry?.item?.id ?? null}
            loaded={!!data.serverNow}
            offline={data.offline}
            onSelect={setSelectedItem}
          />
        </aside>

        {/* Chat */}
        <ChatPanel offline={data.offline} chat={data.chat ?? []} />
      </div>

      {/* Mobile submit modal */}
      {showSubmit && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm lg:hidden"
          onClick={() => setShowSubmit(false)}
        >
          <div className="w-full max-w-md pb-4" onClick={(e) => e.stopPropagation()}>
            <SubmitBox offline={data.offline} onSubmitted={() => setShowSubmit(false)} />
          </div>
        </div>
      )}

      {/* Item detail modal */}
      {selectedItem && (
        <ItemModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </main>
  );
}

// ─── Player Component ────────────────────────────────────
//
// Dual-video buffer with canvas transition:
//   A plays current clip → B preloads next clip
//   On switch: canvas captures A's last frame → B plays → fade in
//   250ms clock in ChannelView drives entry changes

function Player({
  entry,
  nextEntry,
  muted,
  onToggleMute,
  pendingCount,
  hasCurrent,
  offline,
  loaded,
  skewRef,
}: {
  entry: ScheduleEntry | null;
  nextEntry: ScheduleEntry | null;
  muted: boolean;
  onToggleMute: () => void;
  pendingCount: number;
  hasCurrent: boolean;
  offline: boolean;
  loaded: boolean;
  skewRef: React.RefObject<number>;
}) {
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeVideo, setActiveVideo] = useState<0 | 1>(0);
  const [showCanvas, setShowCanvas] = useState(false);
  const [started, setStarted] = useState(false);
  const entryId = entry?.id ?? null;

  // Track which video url each slot should have
  const slotUrl = useRef<{ A: string | null; B: string | null }>({ A: null, B: null });

  // Preload next clip into the inactive video element whenever nextEntry changes
  useEffect(() => {
    if (!nextEntry?.clip?.videoUrl) return;
    const inactiveEl = activeVideo === 0 ? videoB.current : videoA.current;
    const inactiveSlot = activeVideo === 0 ? "B" : "A";
    if (!inactiveEl) return;
    const url = nextEntry.clip.videoUrl;
    if (slotUrl.current[inactiveSlot] !== url) {
      slotUrl.current[inactiveSlot] = url;
      inactiveEl.src = url;
      inactiveEl.load();
    }
  }, [nextEntry?.clip?.videoUrl, activeVideo]);

  // Handle entry switch: capture canvas frame, swap videos, play new
  useEffect(() => {
    if (!entry || !entryId || !entry.clip?.videoUrl) return;

    const newUrl = entry.clip.videoUrl;
    const activeEl = activeVideo === 0 ? videoA.current : videoB.current;
    const inactiveEl = activeVideo === 0 ? videoB.current : videoA.current;
    const activeSlot = activeVideo === 0 ? "A" : "B";
    const inactiveSlot = activeVideo === 0 ? "B" : "A";

    if (!activeEl || !inactiveEl) return;

    // If the active video already has this URL (e.g. first load), just play
    // Otherwise we need to swap to the inactive one (which should have preloaded)
    let targetEl: HTMLVideoElement;
    let targetSlot: "A" | "B";
    let needSwap: boolean;

    if (slotUrl.current[activeSlot] === newUrl) {
      // Active video already has the right URL — just play it
      targetEl = activeEl;
      targetSlot = activeSlot;
      needSwap = false;
    } else if (slotUrl.current[inactiveSlot] === newUrl) {
      // Inactive video has preloaded the right URL — swap to it
      targetEl = inactiveEl;
      targetSlot = inactiveSlot;
      needSwap = true;
    } else {
      // Neither has it — load into inactive and swap
      slotUrl.current[inactiveSlot] = newUrl;
      inactiveEl.src = newUrl;
      inactiveEl.load();
      targetEl = inactiveEl;
      targetSlot = inactiveSlot;
      needSwap = true;
    }

    const playNew = () => {
      // Capture last frame from the old active video to canvas (if it was playing)
      if (needSwap && activeEl.readyState >= 2 && canvasRef.current) {
        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          canvas.width = activeEl.videoWidth || 1280;
          canvas.height = activeEl.videoHeight || 720;
          try {
            ctx.drawImage(activeEl, 0, 0, canvas.width, canvas.height);
            setShowCanvas(true);
          } catch {}
        }
      }

      // Align currentTime to server clock
      const offset = (Date.now() + skewRef.current - entry.startAt) / 1000;
      if (offset > 0.3 && targetEl.duration && offset < targetEl.duration - 0.3) {
        targetEl.currentTime = offset;
      }

      targetEl.muted = muted;
      targetEl.play().catch(() => {});

      if (needSwap) {
        // Swap active
        setActiveVideo(targetSlot === "A" ? 0 : 1);
        // Hide canvas after new video starts rendering
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setShowCanvas(false);
          });
        });
      }
    };

    if (targetEl.readyState >= 3) {
      // Already buffered — play immediately
      playNew();
    } else {
      // Wait for canplay
      targetEl.muted = true; // start muted to allow autoplay
      const handler = () => {
        targetEl.removeEventListener("canplay", handler);
        playNew();
      };
      targetEl.addEventListener("canplay", handler);
      // If the URL was just set, load() was already called above
      if (targetEl.src !== newUrl) {
        targetEl.src = newUrl;
        targetEl.load();
      }
      // Safety timeout: if canplay doesn't fire in 3s, play anyway
      setTimeout(() => {
        targetEl.removeEventListener("canplay", handler);
        if (slotUrl.current[targetSlot] === newUrl) {
          playNew();
        }
      }, 3000);
    }

    setStarted(true);
  }, [entryId]); // eslint-disable-line

  // Update mute on active video
  useEffect(() => {
    const active = activeVideo === 0 ? videoA.current : videoB.current;
    if (active) active.muted = muted;
  }, [muted, activeVideo]);

  const hasVideo = entry?.clip?.videoUrl;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-2xl border border-white/10 bg-black shadow-[0_0_60px_rgba(255,45,120,0.15)]">
      {entry && hasVideo ? (
        <>
          {/* Background blur from item image */}
          {entry.item?.image && (
            <img
              src={entry.item.image}
              alt=""
              className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
            />
          )}

          {/* Canvas transition frame (shown briefly during video swap) */}
          <canvas
            ref={canvasRef}
            className={`absolute inset-0 h-full w-full object-contain z-20 transition-opacity duration-100 ${
              showCanvas ? "opacity-100" : "opacity-0 pointer-events-none"
            }`}
          />

          {/* Dual video elements */}
          {[0, 1].map((i) => (
            <video
              key={i}
              ref={i === 0 ? videoA : videoB}
              playsInline
              preload="auto"
              muted={i !== activeVideo || muted}
              className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-100 ${
                i === activeVideo && !showCanvas ? "z-10 opacity-100" : "z-0 opacity-0 pointer-events-none"
              }`}
            />
          ))}

          {/* Live badge + countdown */}
          <div className="absolute left-4 top-4 z-20 flex items-center gap-2 font-mono text-[11px] tracking-widest">
            {(!entry.item?.generationDone ||
              (Date.now() + skewRef.current - (entry.item?.newestClipAt ?? 0) < 300000)) && (
              <span className="rounded bg-pink px-2 py-1 font-bold text-white">
                ● LIVE
              </span>
            )}
          </div>

          {/* Mute toggle */}
          <div className="absolute right-4 top-4 z-20 flex gap-2">
            <button
              onClick={onToggleMute}
              className="rounded-lg bg-black/60 px-3 py-1.5 font-mono text-xs text-white backdrop-blur hover:bg-black/80"
            >
              {muted ? "🔇 UNMUTE" : "🔊 MUTE"}
            </button>
          </div>

          {/* Subtitles */}
          {entry.clip?.dialogue && (
            <Subtitles dialogue={entry.clip.dialogue} startAt={entry.startAt} duration={entry.duration} skewRef={skewRef} />
          )}

          {/* Question badge */}
          {entry.clip?.source === "question" && entry.clip.askedBy && (
            <div className="absolute inset-x-2 bottom-[5.6rem] z-20 sm:inset-x-auto sm:left-4 sm:bottom-44 sm:max-w-md">
              <div className="rounded-lg border border-cyan/40 bg-black/70 px-3 py-2 backdrop-blur">
                <p className="font-mono text-[10px] tracking-widest text-cyan">
                  📩 VIEWER QUESTION — {entry.clip.askedBy}
                </p>
              </div>
            </div>
          )}

          {/* Item info bar */}
          <div className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/60 to-transparent p-2.5 pt-10 sm:p-4 sm:pt-14">
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  {entry.item && (
                    <span className="rounded bg-gold px-1.5 py-0.5 font-mono text-[9px] font-bold text-black sm:px-2 sm:text-[11px]">
                      ITEM {entry.item.itemNumber}
                    </span>
                  )}
                  <span className="hidden sm:inline font-mono text-[11px] tracking-widest text-cyan">
                    TODAY&apos;S SPECIAL VALUE
                  </span>
                </div>
                {entry.item && (
                  <h2 className="mt-0.5 truncate text-sm text-white sm:mt-1 sm:text-2xl">
                    {entry.item.title}
                  </h2>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 sm:gap-4">
                {entry.item?.price && (
                  <span className="chrome-text text-lg sm:text-3xl">{entry.item.price}</span>
                )}
                {entry.item && (
                  <a
                    href={entry.item.url}
                    target="_blank"
                    rel="nofollow noopener noreferrer"
                    className="animate-blink rounded-lg bg-gradient-to-b from-pink to-[#c2185b] px-3 py-1.5 text-xs text-white shadow-[0_0_25px_rgba(255,45,120,0.5)] hover:brightness-110 sm:rounded-xl sm:px-5 sm:py-2.5 sm:text-base"
                  >
                    BUY NOW
                  </a>
                )}
              </div>
            </div>
          </div>
        </>
      ) : (
        <Standby
          loaded={loaded}
          pendingCount={pendingCount}
          hasCurrent={hasCurrent}
          offline={offline}
        />
      )}
    </div>
  );
}

// ─── Subtitles ───────────────────────────────────────────

function Subtitles({
  dialogue,
  startAt,
  duration,
  skewRef,
}: {
  dialogue: string;
  startAt: number;
  duration: number;
  skewRef: React.RefObject<number>;
}) {
  const words = dialogue.split(/\s+/);
  const halves = words.length <= 14
    ? [dialogue]
    : [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")];

  const [half, setHalf] = useState(0);
  useEffect(() => {
    if (halves.length < 2) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() + skewRef.current - startAt;
      setHalf(elapsed > (duration * 1000) / 2 ? 1 : 0);
    }, 300);
    return () => clearInterval(interval);
  }, [halves.length, startAt, duration, skewRef]);

  return (
    <div className="pointer-events-none absolute inset-x-2 bottom-[3.4rem] z-20 flex justify-center sm:inset-x-4 sm:bottom-28">
      <p className="max-w-2xl rounded bg-black/75 px-2 py-1 text-center font-mono text-[10px] leading-snug text-white sm:px-3 sm:py-1.5 sm:text-sm">
        {halves[Math.min(half, halves.length - 1)]}
      </p>
    </div>
  );
}

// ─── Standby ─────────────────────────────────────────────

function Standby({
  loaded,
  pendingCount,
  hasCurrent,
  offline,
}: {
  loaded: boolean;
  pendingCount: number;
  hasCurrent: boolean;
  offline: boolean;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
      <div className="animate-standby flex h-24 w-full max-w-md overflow-hidden rounded-lg opacity-80">
        {["#ff2d78", "#ffd24a", "#38e8ff", "#8b5cf6", "#22c55e", "#f97316", "#e5e7eb"].map((c) => (
          <div key={c} className="flex-1" style={{ background: c }} />
        ))}
      </div>
      <p className="text-2xl tracking-widest text-white font-bold">PLEASE STAND BY</p>
      <p className="font-mono text-xs text-zinc-500 text-center px-6">
        {offline
          ? "PixelShop is currently offline — we'll be back soon."
          : loaded
          ? pendingCount > 0
            ? `${pendingCount} segment${pendingCount > 1 ? "s" : ""} in production at the AI studio…`
            : hasCurrent
            ? "The studio is rolling the next shot…"
            : "Nothing on air yet. Submit a product to start the show!"
          : "Tuning in…"}
      </p>
    </div>
  );
}

// ─── Ticker ──────────────────────────────────────────────

function Ticker({ rotation, pending }: { rotation: RotationItem[]; pending: PendingItem[] }) {
  const items = rotation.slice(0, 10).reverse().map(
    (e) => `${e.itemNumber} ${e.title.toUpperCase()}${e.price ? ` — ${e.price}` : ""}`
  );
  const base = items.length > 0
    ? items
    : ["SUBMIT YOUR PRODUCT — GO LIVE IN MINUTES"];

  if (pending.length > 0) {
    base.push(`${pending.length} NEW SEGMENT${pending.length > 1 ? "S" : ""} IN PRODUCTION`);
  }

  const text = base.map((e) => `AS SEEN ON PIXELSHOP ▸ ${e}`).join("  ★  ") + "  ★  ";

  return (
    <div className="overflow-hidden rounded-xl border border-gold/30 bg-panel/70">
      <div className="animate-ticker flex w-max whitespace-nowrap py-2 font-mono text-xs tracking-widest text-gold">
        <span className="px-4">{text}</span>
        <span className="px-4">{text}</span>
      </div>
    </div>
  );
}

// ─── Submit Box ──────────────────────────────────────────

function SubmitBox({
  offline,
  onSubmitted,
}: {
  offline: boolean;
  onSubmitted: () => void;
}) {
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [image, setImage] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "working" | "ready" | "failed">("idle");
  const [error, setError] = useState<string | null>(null);
  const [itemNumber, setItemNumber] = useState<string | null>(null);

  const submitProduct = useMutation(api.channel.submitProduct);
  const runPipeline = useAction(api.pipeline.runPipeline);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || status === "submitting") return;
    setError(null);
    setStatus("submitting");

    try {
      const normalized = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      const result = await submitProduct({
        url: normalized,
        title: title.trim() || undefined,
        price: price.trim() || undefined,
        image: image.trim() || undefined,
      });
      setItemNumber(result.itemNumber);
      setUrl("");
      setTitle("");
      setPrice("");
      setImage("");
      setStatus("working");
      onSubmitted();

      // Fire the pipeline — don't await; it runs in the background
      runPipeline({ itemId: result.itemId }).catch(() => {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setStatus("failed");
    }
  };

  const busy = status === "submitting" || status === "working";

  return (
    <div className="rounded-2xl border border-pink/30 bg-panel/70 p-4 backdrop-blur">
      <p className="font-bold text-sm tracking-wide text-gold">PUT YOUR PRODUCT ON TV</p>
      <p className="mt-1 text-xs text-zinc-500">
        {offline ? "PixelShop is currently offline - we'll be back soon." : "Paste a product URL - our AI studio plans a full segment and airs it live."}
      </p>
      <form onSubmit={handleSubmit} className="mt-3 flex flex-col gap-2">
        <input
          type="text"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="store.com/your-product"
          disabled={busy}
          className="w-full rounded-lg bg-black/30 border border-pink/30 px-3 py-2.5 text-sm outline-none placeholder:text-zinc-600 focus:border-pink focus:ring-2 focus:ring-pink/30 disabled:opacity-60"
        />
        {/* Optional fields for manual fallback */}
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer hover:text-zinc-400">Manual details (optional)</summary>
          <div className="mt-2 flex flex-col gap-2">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Product title"
              disabled={busy}
              className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-pink/50"
            />
            <input
              type="text"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="Price (e.g. $29.99)"
              disabled={busy}
              className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-pink/50"
            />
            <input
              type="text"
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder="Image URL"
              disabled={busy}
              className="rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-sm outline-none focus:border-pink/50"
            />
          </div>
        </details>
        <button
          type="submit"
          disabled={busy}
          className="font-bold rounded-lg bg-gradient-to-b from-pink to-[#c2185b] px-4 py-2.5 text-sm tracking-wide text-white shadow-[0_0_20px_rgba(255,45,120,0.35)] hover:brightness-110 active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? "ON IT…" : "PUT IT ON TV"}
        </button>
      </form>
      {status === "working" && itemNumber && (
        <p className="mt-3 flex items-center gap-2 text-xs text-zinc-500">
          <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-pink border-t-transparent" />
          {itemNumber} — preparing the studio…
        </p>
      )}
      {status === "ready" && itemNumber && (
        <p className="mt-3 text-xs">
          <span className="font-bold text-gold">YOU&apos;RE ON AIR! 📺</span>{" "}
          <span className="text-zinc-500">{itemNumber} just joined the rotation.</span>
        </p>
      )}
      {status === "failed" && error && (
        <p className="mt-3 text-xs text-[#ff8a8a]">
          <span className="font-semibold">Couldn&apos;t air that one: </span>
          {error}
        </p>
      )}
    </div>
  );
}

// ─── Product List ────────────────────────────────────────

function ProductList({
  rotation,
  pending,
  currentId,
  loaded,
  offline,
  onSelect,
}: {
  rotation: RotationItem[];
  pending: PendingItem[];
  currentId: string | null;
  loaded: boolean;
  offline: boolean;
  onSelect: (item: RotationItem) => void;
}) {
  const current = rotation.find((e) => e.id === currentId);
  const upcoming = rotation.filter((e) => e.id !== currentId).reverse().slice(0, 10);

  return (
    <div className="flex-1 min-h-0 max-h-[calc(100vh-16rem)] overflow-y-auto rounded-2xl border border-white/10 bg-panel/60 backdrop-blur">
      <section>
        <SectionLabel label="CURRENT PRODUCT" />
        {!current && (
          <p className="px-4 py-6 text-center text-xs text-zinc-600">
            {loaded ? "Nothing on air yet — be the first sponsor!" : "Tuning in…"}
          </p>
        )}
        {current && (
          <ProductRow item={current} highlight onClicValue={() => onSelect(current)} />
        )}
      </section>

      {(upcoming.length > 0 || pending.length > 0) && (
        <section>
          <SectionLabel label="UP NEXT" />
          {upcoming.map((item) => (
            <ProductRow key={item.id} item={item} onClicValue={() => onSelect(item)} />
          ))}
          {pending.map((item) => (
            <div key={item.id} className="flex items-center gap-3 px-4 py-2.5">
              <ProductImage src={item.image} alt={item.title} dim />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-zinc-400">{item.title}</p>
                <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-cyan/80">
                  <span className="inline-block h-2 w-2 shrink-0 animate-spin rounded-full border border-cyan border-t-transparent" />
                  <span className="truncate">{item.itemNumber} · in production…</span>
                </p>
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function ProductRow({
  item,
  highlight,
  onClicValue,
}: {
  item: RotationItem;
  highlight?: boolean;
  onClicValue: () => void;
}) {
  const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  return (
    <button
      type="button"
      onClick={onClicValue}
      className={`flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5 ${highlight ? "bg-pink/10" : ""}`}
    >
      <ProductImage src={item.image} alt={item.title} highlight={highlight} />
      <div className="min-w-0 flex-1">
        <p className={`truncate text-sm ${highlight ? "font-semibold text-white" : "text-zinc-300"}`}>
          {item.title}
        </p>
        <p className="mt-0.5 font-mono text-[10px] tracking-wider text-zinc-600">
          {highlight && <span className="font-bold text-pink">● ON AIR · </span>}
          {item.itemNumber}
          {item.playbackSeconds > 0 && <span className="text-cyan/70"> · {fmtTime(item.playbackSeconds)} aired</span>}
        </p>
      </div>
    </button>
  );
}

function ProductImage({
  src,
  alt,
  highlight,
  dim,
}: {
  src?: string;
  alt: string;
  highlight?: boolean;
  dim?: boolean;
}) {
  return src ? (
    <img
      src={src}
      alt={alt}
      className={`h-11 w-11 shrink-0 rounded-lg border object-cover ${highlight ? "border-pink shadow-[0_0_12px_rgba(255,45,120,0.5)]" : "border-white/10"} ${dim ? "opacity-60" : ""}`}
    />
  ) : (
    <div className="h-11 w-11 shrink-0 rounded-lg border border-white/10 bg-gradient-to-br from-pink/30 to-cyan/20" />
  );
}

function SectionLabel({ label }: { label: string }) {
  return (
    <div className="sticky top-0 z-10 border-b border-white/10 bg-panel/95 px-4 py-2 font-mono text-[10px] tracking-[0.25em] text-zinc-500 backdrop-blur">
      {label}
    </div>
  );
}

// ─── Item Modal ──────────────────────────────────────────

function ItemModal({ item, onClose }: { item: RotationItem; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-white/10 bg-panel p-5 shadow-[0_0_60px_rgba(255,45,120,0.25)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <span className="rounded bg-gold px-2 py-0.5 font-mono text-[11px] font-bold text-black">
            ITEM {item.itemNumber}
          </span>
          <button
            onClick={onClose}
            className="rounded-lg bg-white/10 px-2.5 py-1 font-mono text-xs text-zinc-400 hover:bg-white/20"
          >
            ✕
          </button>
        </div>
        {item.image && (
          <img src={item.image} alt={item.title} className="mt-4 h-48 w-full rounded-xl border border-white/10 object-cover" />
        )}
        <h3 className="mt-4 text-xl text-white font-bold">{item.title}</h3>
        {item.price && <p className="chrome-text mt-1 text-3xl">{item.price}</p>}
        <a
          href={item.url}
          target="_blank"
          rel="nofollow noopener noreferrer"
          className="mt-5 block rounded-xl bg-gradient-to-b from-pink to-[#c2185b] px-5 py-3 text-center text-white shadow-[0_0_25px_rgba(255,45,120,0.5)] hover:brightness-110"
        >
          VISIT PRODUCT PAGE →
        </a>
        <p className="mt-3 text-center text-[10px] text-zinc-600">
          Links open the seller&apos;s site in a new tab.
        </p>
      </div>
    </div>
  );
}

// ─── Chat Panel ──────────────────────────────────────────

function ChatPanel({ offline, chat }: { offline: boolean; chat: ChatMessage[] }) {
  const [input, setInput] = useState("");
  const [name, setName] = useState("");
  const [lastMsg, setLastMsg] = useState<string | null>(null);
  const sendChat = useMutation(api.channel.sendChat);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("pixelshop-name");
      if (saved) {
        setName(saved);
      } else {
        const random = `Shopper${Math.floor(1000 + Math.random() * 9000)}`;
        setName(random);
        localStorage.setItem("pixelshop-name", random);
      }
    } catch {
      const random = `Shopper${Math.floor(1000 + Math.random() * 9000)}`;
      setName(random);
    }
  }, []);

  // Auto-scroll
  const lastId = chat.length ? chat[chat.length - 1].id : "";
  useEffect(() => {
    const el = scrollRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [lastId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || !name.trim()) return;
    setInput("");
    setLastMsg(text);
    try {
      await sendChat({ sender: name.trim(), text });
    } catch {}
  };

  return (
    <aside className="flex w-full lg:w-80 flex-col rounded-2xl border border-white/10 bg-panel/60 backdrop-blur h-96 max-h-[45vh] lg:h-auto lg:max-h-none lg:order-3 min-h-0">
      <div className="border-b border-white/10 px-4 py-3 font-mono text-xs tracking-widest text-zinc-500">
        LIVE CHAT
      </div>
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-4 text-sm">
        {chat.length === 0 && (
          <p className="text-xs text-zinc-600">
            Ask the host a question live — they answer on air!
          </p>
        )}
        {chat.map((msg) =>
          msg.role === "host" ? (
            <p key={msg.id} className="rounded-md border border-gold/25 bg-gold/10 px-2 py-1.5 leading-snug break-words">
              <span className="font-semibold text-gold">🎙 {msg.user}</span>{" "}
              <span className="text-zinc-300">{msg.text}</span>
            </p>
          ) : (
            <p key={msg.id} className="leading-snug break-words">
              <span className="font-semibold" style={{ color: userColor(msg.user) }}>
                {msg.user}
              </span>{" "}
              <span className="text-zinc-300">{msg.text}</span>
            </p>
          )
        )}
        {lastMsg && (
          <p className="flex items-center gap-2 leading-snug break-words opacity-50">
            <span className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-pink border-t-transparent" />
            <span className="text-zinc-400">{lastMsg}</span>
          </p>
        )}
      </div>
      <div className="border-t border-white/10 p-3">
        <div className="mb-2 flex items-center gap-1.5 font-mono text-[10px] text-zinc-600">
          <span>CHATTING AS</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => { try { localStorage.setItem("pixelshop-name", name); } catch {} }}
            maxLength={24}
            className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 font-semibold outline-none focus:bg-black/30"
            style={{ color: userColor(name || "Shopper") }}
          />
        </div>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={280}
            disabled={offline}
            placeholder={offline ? "Chat is paused — back soon!" : "Ask the host a question…"}
            className="min-w-0 flex-1 rounded-lg bg-black/30 border border-white/10 px-3 py-2 text-xs outline-none placeholder:text-zinc-600 focus:border-pink/50 disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={offline || !input.trim()}
            className="rounded-lg bg-pink/90 px-3 py-2 text-xs font-bold text-white hover:bg-pink disabled:opacity-40"
          >
            SEND
          </button>
        </form>
      </div>
    </aside>
  );
}
