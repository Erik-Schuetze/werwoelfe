"use client";

import { useEffect, useRef, useState } from "react";

import type { Beat } from "@/lib/beats";
import type { Speed } from "@/lib/cadence";
import type { TruthLevel } from "@/lib/truth";
import { narrationFor } from "@/lib/narration";
import {
  narratorVoice,
  rateForSpeed,
  speaksAtSpeed,
  useSpeechVoices,
  voiceForPlayer,
  type VoiceChoice,
} from "@/lib/speech";

/**
 * Drives narration for the beat currently on the stage.
 *
 * The hard rule is that narration follows the *beat*, not the render. React
 * re-renders the spectator page constantly (the 1.5s poll, a progress tick, a
 * hover), and re-speaking on any of those would stutter the same line forever.
 * So the speaking effect is keyed on `stageBeat?.key` — the stable identity the
 * playback hook already guarantees — and everything else the effect needs (the
 * live beat object, the level, the roster, the voice list) is read through refs.
 * The effect therefore fires only when the beat, the play state, the enabled
 * toggle or the speed actually change.
 *
 * PAUSE/RESUME: we never use `speechSynthesis.pause()`. Its behaviour is
 * inconsistent across engines — Chrome's queue can wedge on resume after a
 * pause — so pausing playback cancels outright and the current beat is re-spoken
 * from the top on resume. That is deliberate lossy behaviour in exchange for one
 * that always works.
 */

export type NarrationOptions = {
  /** The beat on the stage, or `undefined` before the first beat loads. */
  stageBeat: Beat | undefined;
  playing: boolean;
  speed: Speed;
  enabled: boolean;
  level: TruthLevel;
  reasoning: boolean;
  roster: string[];
  nameOf: (id: string) => string;
};

export function useNarration(options: NarrationOptions): { supported: boolean; speaking: boolean } {
  const { voices, supported } = useSpeechVoices();
  const [speaking, setSpeaking] = useState(false);

  // The latest render's inputs, kept in refs so the speak effect below can stay
  // keyed on the beat key alone without going stale between beats.
  const latest = useRef(options);
  const voicesRef = useRef(voices);

  // Mirror the latest props into the refs after every commit. An effect with no
  // dependency array is the sanctioned way to do this without writing a ref
  // during render, and it is declared first so it runs before the speak effect in
  // the same commit. The speak effect below therefore depends only on the beat
  // key and the toggles, so an unrelated re-render (the poll, a progress tick, a
  // level change) can never re-speak.
  useEffect(() => {
    latest.current = options;
    voicesRef.current = voices;
  });

  // The beat key is the effect's real dependency; a changed key is a new line.
  const stageKey = options.stageBeat?.key ?? null;

  useEffect(() => {
    const synth = typeof window === "undefined" ? undefined : window.speechSynthesis;
    if (!synth) {
      setSpeaking(false);
      return;
    }

    const current = latest.current;

    // Anything that means "do not narrate right now" is a cancel, not a pause
    // (see the module note). This also covers the beat going away entirely.
    if (
      !current.stageBeat ||
      !current.enabled ||
      !current.playing ||
      !speaksAtSpeed(current.speed)
    ) {
      synth.cancel();
      setSpeaking(false);
      return;
    }

    const beat = current.stageBeat;
    const lines = narrationFor(beat, {
      level: current.level,
      reasoning: current.reasoning,
      nameOf: current.nameOf,
    });

    // A new beat preempts whatever the engine still has queued.
    synth.cancel();
    setSpeaking(false);

    if (lines.length === 0) return;

    const choices = voicesRef.current;
    const rate = rateForSpeed(current.speed);
    // `VoiceChoice` is our own { id, name } shape; the engine needs the live
    // `SpeechSynthesisVoice`, so map the chosen id back through `getVoices()`.
    const natives = synth.getVoices();
    const nativeFor = (choice: VoiceChoice | undefined): SpeechSynthesisVoice | undefined => {
      if (!choice) return undefined;
      return natives.find((voice) => (voice.voiceURI || voice.name) === choice.id);
    };

    const utterances = lines.map((line) => {
      const utterance = new SpeechSynthesisUtterance(line.text);
      utterance.rate = rate;
      const choice =
        line.speakerId === null
          ? narratorVoice(choices)
          : voiceForPlayer(line.speakerId, current.roster, choices);
      const native = nativeFor(choice);
      if (native) utterance.voice = native;
      return utterance;
    });

    // `speaking` means "narration for this beat is in progress". The engine
    // queues the whole list up front, so the *first* line's start opens the
    // window and the *last* line's end (or error) closes it — the first line's
    // own `onend` would fire while later lines were still playing and read as
    // silence when there was none.
    const first = utterances[0];
    const last = utterances[utterances.length - 1];
    first.onstart = (): void => setSpeaking(true);
    last.onend = (): void => setSpeaking(false);
    last.onerror = (): void => setSpeaking(false);

    for (const utterance of utterances) synth.speak(utterance);

    // Any dep change (new beat, play/enable/speed) or unmount cancels the queue
    // and clears the flag, so `speaking` can never stick on.
    return () => {
      synth.cancel();
      setSpeaking(false);
    };
    // Keyed on the beat key plus the three toggles that legitimately change what
    // should be heard. `latest`/`voicesRef` are refs, so they add no churn here.
  }, [stageKey, options.enabled, options.playing, options.speed]);

  return { supported, speaking };
}
