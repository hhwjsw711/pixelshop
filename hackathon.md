### 2026-09-09 - P1 persona + P3 smart duration + P4 prompt upgrade
First round of post-launch improvements applied to the generation pipeline,
based on competitive analysis of interdimensional-shopping and fal API docs:

- **Host persona (P1):** Added HOST_PERSONA (Max Flex, 35yo American shopping
  host) and STUDIO_SETTING constants. Every videoPrompt now starts with the
  studio description and host appearance for visual consistency across
  clips. SYSTEM_PROMPT rewritten to include persona, anti-repetition
  instructions, and durationSec field requirements.
- **Smart duration (P3):** Replaced fixed 10s clip duration with smartDuration()
  — ceil(words / 2.8) clamped to [5, 10] seconds. OpenAI returns durationSec
  per clip; fallback uses smartDuration on the dialogue. fal T2V Turbo
  accepts integer 5-15s (verified via API docs). Fixed scheduleStart to use
  actualDurationMs instead of fixed CLIP_DURATION_MS, eliminating schedule
  gaps when clips have variable lengths.
- **Prompt upgrade (P4):** Temperature raised to 0.85, max_tokens to 1500.
  Added AbortController with 30s timeout on OpenAI fetch. Added
  getRecentDialogues query to fetch last 3 ready clip dialogues as
  anti-repetition context — passed to generateScript and included in user
  prompt. Degrades gracefully if query fails.
- **Adversarial audit fix:** scheduleStart = hintStart + actualDurationMs
  (was using fixed constant — would cause gaps with variable durations).

TypeScript typecheck passes. Deployed to Convex static hosting.

> AI生成