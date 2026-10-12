import type { Beat } from "@/lib/beats";

/**
 * How long a beat holds the stage, and how fast its text types on. Everything
 * about the feel of the playback lives in this one table — components must not
 * hard-code timing.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE NUMBERS (keep this rationale)
 * ---------------------------------------------------------------------------
 * Adult silent reading is 238 wpm (Brysbaert 2019 meta-analysis; most adults
 * 175–300 wpm). Our text, though, is **transient and unrevisitable** — it is
 * pushed down and greyed when the next line arrives — which is exactly the
 * condition captioning standards exist for, and they sit deliberately below
 * free reading speed:
 *   · BBC 160–180 wpm with a 0.3 s per word floor
 *   · European Captioning Institute ~180 wpm
 *   · Netflix caps adults at 20 cps and children at 17 cps
 * We adopt the **BBC lower bound, ~160 wpm ≈ 15 characters/second**, because
 * the spectator is also watching a table, a rail and a score.
 *
 * THE KEY DESIGN DECISION: the reveal rate EQUALS the reading rate. Words
 * arrive no faster than they can be read, so the eye is never behind and the
 * post-reveal hold is a settle, not a second reading period. Do NOT cap the
 * reveal and then add a long hold to compensate — that is what makes typewriter
 * effects annoying. The previous version of this file got that wrong: its own
 * comment admitted it targeted "a comfortable skim, not full reading speed" at
 * 3–5 s per beat. That was the bug.
 *
 * The settle is deliberately not instant, though. A line that clears on the same
 * frame as its last character gives the eye nowhere to rest, and the cut marker
 * — which only lands with the final word — would never be seen at all. So a
 * completed line holds for 1–2 s before the stage moves on.
 */

export const READING = {
  cps: 15, // BBC lower bound ~160 wpm; reveal rate == reading rate
  minRevealMs: 700, // short lines still feel typed
  settlePerChar: 4, // longer lines are worth a longer settle
  minSettleMs: 1000, // ...but a completed line always holds at least a second
  maxSettleMs: 2000, // ...and never longer than two
} as const;

/**
 * The BBC's 0.3 s-per-word floor is already satisfied *by the reveal rate*, not
 * by a hold: at `cps: 15` a character takes 66.7 ms, so the reveal delivers
 * ~0.4 s per word. Applying the floor a second time as a post-reveal hold would
 * double-count the reading budget and roughly double every dwell — which is the
 * "cap the reveal then add a long hold" anti-pattern this module exists to avoid.
 * The floor therefore lives in `cps` and nowhere else.
 */

/** Finite speeds, slowest first, plus the "instant" fire-hose. */
export const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4, 8] as const;
export type Speed = (typeof SPEEDS)[number] | "instant";

/**
 * Per-kind dramatic bonuses, added on top of the text's own reveal + settle so
 * that the mechanical beats and the big moments still land. These are holds the
 * text length cannot express — a ballot's ballot count, a night's victim, the
 * finale — and they are divided by `speed` like everything else.
 */
export const CADENCE = {
  /** Fixed cost of mechanical events that carry no prose. */
  mechanical: 420,
  ballotBase: 600,
  ballotPerVote: 200,
  ballotMax: 3200,
  tallyBase: 2000,
  tallyPerCandidate: 200,
  elimination: 3200,
  nightBase: 1800,
  nightVictim: 600,
  passBase: 700,
  passPerVoice: 90,
  passMax: 1800,
  /** A final declaration is a commitment, not a line — it earns a beat of its own. */
  declarationBonus: 1400,
  pileOnBase: 1100,
  pileOnPerVoice: 120,
  pileOnMax: 3200,
  /** Extra hold on top of the text dwell, for moments that should land. */
  markerBonus: {
    game_finished: 3200,
    sheriff_elected: 1600,
    sheriff_succeeded: 1200,
    sheriff_appointed: 1000,
    sheriff_succession_required: 1200,
    exile_tied: 1600,
    no_exile: 1400,
    game_started: 800,
  } as Record<string, number>,
  /** One tick per beat when the viewer asks for instant. */
  instantTick: 40,
} as const;

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/**
 * The prose a beat actually reveals — the text the reader watches type on. This
 * is the same text the old `rawDwellMs` measured its dwell against (speech body,
 * pile-on voices, night plans, marker detail), so there is exactly one notion of
 * "how long is this beat" in the module. `revealedChars` from the playback hook
 * indexes into this string.
 */
export function revealText(beat: Beat): string {
  switch (beat.kind) {
    case "speech":
      return beat.body;
    case "pileOn":
      // A collapsed run shows only its head voice; the rest is summarised and
      // paid for by the pile-on bonus, not by reveal time.
      return (beat.collapsed ? beat.voices.slice(0, 1) : beat.voices)
        .map((voice) => voice.body)
        .join(" ");
    case "night":
      return beat.plans.map((plan) => plan.body).join(" ");
    case "marker":
      return beat.detail;
    case "text":
      return beat.event.message;
    case "declaration":
      // The reason is the only prose; the commitment itself is structural.
      return beat.body;
    case "passRun":
    case "ballot":
    case "voteTally":
    case "elimination":
      return "";
  }
}

/** Characters the beat reveals — the length `revealedChars` runs up to. */
export function revealLength(beat: Beat): number {
  return revealText(beat).length;
}

/**
 * How long the beat's text takes to type on: characters ÷ reading rate, floored
 * so a short line still feels typed.
 *
 * TTS forward-compatibility: a future text-to-speech layer substitutes the audio
 * duration for the typewriter reveal and reuses `holdMs`, touching no component.
 * That substitution is this one line — return the audio length instead of the
 * computed reading time (e.g. `return ttsDurationMs(beat);`) and nothing else in
 * this module or the playback hook changes.
 */
export function revealMs(beat: Beat): number {
  return Math.max(READING.minRevealMs, (revealLength(beat) / READING.cps) * 1000);
}

/**
 * The settle after the last word lands, and nothing more: the reading budget is
 * already spent by the reveal (see the note on `READING`). Proportional to the
 * text but clamped, so it stays a breath between lines rather than a second wait.
 */
export function holdMs(beat: Beat): number {
  return clamp(
    revealLength(beat) * READING.settlePerChar,
    READING.minSettleMs,
    READING.maxSettleMs,
  );
}

/** The per-kind dramatic hold, preserved from the old table. */
export function bonusMs(beat: Beat): number {
  const C = CADENCE;
  switch (beat.kind) {
    case "speech":
      return 0;
    case "pileOn":
      return beat.collapsed
        ? Math.min(C.pileOnBase + beat.voices.length * C.pileOnPerVoice, C.pileOnMax)
        : 0;
    case "passRun":
      return Math.min(C.passBase + beat.voices.length * C.passPerVoice, C.passMax);
    case "declaration":
      return C.declarationBonus;
    case "ballot":
      return Math.min(C.ballotBase + beat.votes.length * C.ballotPerVote, C.ballotMax);
    case "voteTally":
      return C.tallyBase + beat.counts.length * C.tallyPerCandidate;
    case "elimination":
      return C.elimination;
    case "night":
      return C.nightBase + (beat.mealVictim ? C.nightVictim : 0);
    case "marker":
      return C.markerBonus[beat.events[0]?.kind ?? ""] ?? 0;
    case "text":
      return C.mechanical;
  }
}

function totalMs(beat: Beat): number {
  return revealMs(beat) + holdMs(beat) + bonusMs(beat);
}

/** The one timing model every consumer divides by speed. */
function dwellFor(beat: Beat, speed: Speed | number): number {
  if (speed === "instant") return CADENCE.instantTick;
  return totalMs(beat) / speed;
}

/** Full stage time for a beat, reveal + settle + dramatic bonus, at `speed`. */
export function dwellMs(beat: Beat, speed: Speed): number {
  return dwellFor(beat, speed);
}

/**
 * Rough wall-clock cost of the remaining runway, shown as the drift chip. Built
 * on the same model as `dwellMs`, so the "N behind · jump to live" chip and the
 * playback clock can never disagree.
 */
export function runwayMs(beats: Beat[], fromIndex: number, speed: number, instant: boolean): number {
  let total = 0;
  for (let index = fromIndex; index < beats.length; index += 1) {
    total += dwellFor(beats[index], instant ? "instant" : speed);
  }
  return total;
}

export function describeDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
