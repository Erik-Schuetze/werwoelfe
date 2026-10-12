"use client";

import { useEffect, useState } from "react";

import type { Speed } from "@/lib/cadence";

/**
 * The Web Speech adapter — the only place in the app that touches
 * `window.speechSynthesis`.
 *
 * Everything above this layer (see `narration.ts` and `use-narration.ts`) is
 * pure or React-only; the browser API is quarantined here so the narration logic
 * stays testable and the SSR path never reaches for a global that does not exist
 * on the server. Every entry point is SSR-safe: the hooks guard on `window` and
 * the standalone helpers are total functions over their inputs.
 */

/** A voice as the app cares about it: a stable id plus a human label. */
export type VoiceChoice = { id: string; name: string };

/**
 * The narrator is cast here, in preference order. These are the male English
 * voices shipped by the major engines — macOS (Daniel, Oliver, Alex), Chrome
 * (Google UK English Male), Windows (Guy, David) — and the order is the casting:
 * a warm "storyteller" voice first. The list is a preference, not a requirement;
 * an engine that owns none of them simply falls through.
 */
const NARRATOR_PREFERRED = [
  "Daniel",
  "Oliver",
  "Alex",
  "Google UK English Male",
  "Microsoft Guy",
  "Microsoft David",
] as const;

/**
 * Subscribe to the engine's voice list.
 *
 * Voices are populated *asynchronously* on macOS and Chrome — the first
 * `getVoices()` call on a cold page returns `[]` — so this is not a one-shot
 * read: it re-collects on the `voiceschanged` event and tears that listener down
 * on unmount. Non-English voices are filtered out; there is no language switch,
 * and a mixed-language roster would only garble the dialogue.
 */
export function useSpeechVoices(): { voices: VoiceChoice[]; supported: boolean } {
  const [voices, setVoices] = useState<VoiceChoice[]>([]);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.speechSynthesis === "undefined") return;
    const synth = window.speechSynthesis;
    setSupported(true);

    const collect = (): void => {
      const next: VoiceChoice[] = [];
      for (const voice of synth.getVoices()) {
        if (!voice.lang || !voice.lang.toLowerCase().startsWith("en")) continue;
        next.push({ id: voice.voiceURI || voice.name, name: voice.name });
      }
      setVoices(next);
    };

    collect();
    synth.addEventListener("voiceschanged", collect);
    return () => synth.removeEventListener("voiceschanged", collect);
  }, []);

  // `supported` stays false through SSR and on engines with no speech at all.
  return { voices, supported };
}

/** The narrator's voice: the first preferred match, else whatever exists. */
export function narratorVoice(voices: VoiceChoice[]): VoiceChoice | undefined {
  for (const wanted of NARRATOR_PREFERRED) {
    const match = voices.find((voice) => voice.name.toLowerCase() === wanted.toLowerCase());
    if (match) return match;
  }
  return voices[0];
}

/**
 * Cast a player to a voice.
 *
 * The pool is every voice *but* the narrator's, and the player is picked by their
 * position in the fixed roster. Both inputs are stable — a player keeps the same
 * voice across every render and every reload — which is the point: a listener
 * learns who is speaking by timbre, and re-casting mid-game would read as a
 * different person. The double modulo keeps the index non-negative even if the
 * id is missing from the roster (`indexOf` -> -1).
 */
export function voiceForPlayer(
  playerId: string,
  roster: string[],
  voices: VoiceChoice[],
): VoiceChoice | undefined {
  const narrator = narratorVoice(voices);
  const pool = voices.filter((voice) => voice.id !== narrator?.id);
  if (pool.length === 0) return undefined;
  const index = roster.indexOf(playerId);
  return pool[((index % pool.length) + pool.length) % pool.length];
}

/**
 * Web Speech `rate: 1` is roughly 175 wpm in the major engines — a touch hot
 * against the 160 wpm the reveal is tuned to (`READING.cps` in `cadence.ts`), so
 * at face value the voice drifts ahead of the words still typing on. Speaking 1×
 * at this fraction of the engine default keeps the two roughly together.
 *
 * One constant, tuned by ear once, deliberately not a per-utterance computation:
 * real engine wpm varies by voice and platform, so a precise formula here would
 * be false precision. If the alignment is visibly off, this is the single knob.
 */
const VOICE_RATE_AT_1X = 0.9;

/** Playback rate for the speech engine; `instant` is silent so rate is moot. */
export function rateForSpeed(speed: Speed): number {
  if (speed === "instant") return 1;
  return Math.min(Math.max(Number(speed) * VOICE_RATE_AT_1X, 0.5), 2);
}

/**
 * Whether speed is a speed the ear can follow at all. The engine's rates top out
 * at 2×; past that the utterance is unintelligible noise, so the fast speeds and
 * `instant` simply do not speak and the visual reveal carries the beat alone.
 */
export function speaksAtSpeed(speed: Speed): boolean {
  if (speed === "instant") return false;
  const rate = Number(speed);
  return Number.isFinite(rate) && rate <= 2;
}
