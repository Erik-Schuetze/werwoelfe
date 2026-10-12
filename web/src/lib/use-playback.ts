"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { reuseBeats, type Beat } from "@/lib/beats";
import { CADENCE, dwellMs, revealLength, revealMs, runwayMs, type Speed } from "@/lib/cadence";

/**
 * The buffered presentation layer: the engine emits dialogue 4–18× faster than
 * a human can read it, so the browser computes everything at full speed and
 * drips it onto the stage at reading cadence.
 *
 * The cursor is keyed on a beat's `key`, not on an array index, because the
 * 1.5s poll rebuilds the whole beat array. Closed beats never change, so their
 * keys are stable and the cursor can never point at the wrong moment.
 */

export type Playback = {
  beats: Beat[];
  /** The beat on the stage right now — the live tail when everything is presented. */
  stageBeat: Beat | undefined;
  /**
   * The beat immediately before `stageBeat`, for continuity (the outgoing line
   * staying greyed above the new one). `undefined` at the head of the run, and
   * deduped so it is never the same object as `stageBeat`.
   */
  previousBeat: Beat | undefined;
  /** Every beat at or before the cursor, plus the tail once caught up. */
  presentedCount: number;
  /** Nothing left to advance to. */
  caughtUp: boolean;
  /** 0..1 within the current beat. */
  progress: number;
  /**
   * How many characters of the current beat's text to show right now, derived
   * from the single playback clock. Reaches the full length before the beat
   * advances; 0..full and monotonic; full under instant or reduced motion.
   */
  revealedChars: number;
  playing: boolean;
  speed: Speed;
  /** Watch time still owed before the head of the stream. */
  remainingMs: number;
  remainingBeats: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  setSpeed: (speed: Speed) => void;
  next: () => void;
  previous: () => void;
  seekTo: (key: string) => void;
  jumpToLive: () => void;
  /** Show the current beat's text in full without advancing to the next beat. */
  skipReveal: () => void;
};

export function usePlayback(rawBeats: Beat[], initialSpeed: Speed): Playback {
  const previousRef = useRef<Beat[]>([]);
  const beats = useMemo(() => {
    const next = reuseBeats(previousRef.current, rawBeats);
    previousRef.current = next;
    return next;
    // `reuseBeats` is idempotent, so a discarded StrictMode re-run is harmless.
  }, [rawBeats]);

  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<Speed>(initialSpeed);
  const [progress, setProgress] = useState(0);
  const [reduceMotion, setReduceMotion] = useState(false);

  // The repo's only prefers-reduced-motion check. When set, the reveal is
  // instant — the text is simply there — while the dwell still paces the beats.
  // Guarded for SSR, and the listener is torn down on unmount.
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = (): void => setReduceMotion(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const accumulator = useRef(0);
  const lastFrame = useRef(0);

  const index = useMemo(() => {
    if (beats.length === 0) return -1;
    if (cursorKey === null) return 0;
    const at = beats.findIndex((beat) => beat.key === cursorKey);
    return at < 0 ? 0 : at + 1;
  }, [beats, cursorKey]);

  const caughtUp = index >= beats.length;
  const current = caughtUp ? undefined : beats[index];
  const stageBeat = current ?? beats[beats.length - 1];
  const presentedCount = caughtUp ? beats.length : index;

  // The beat before the one on stage. When caught up, `stageBeat` is the tail,
  // so a naive `beats[index - 1]` is the same object — return undefined instead
  // of handing the stage the same beat twice.
  const previousBeat = useMemo(() => {
    if (stageBeat === undefined) return undefined;
    const candidate = index >= 1 ? beats[index - 1] : undefined;
    return candidate === stageBeat ? undefined : candidate;
  }, [beats, index, stageBeat]);

  // Reveal position, derived from the one accumulating clock's `progress` — no
  // second timer, so pause/speed/seek keep working and nothing can desync. The
  // reveal occupies the head of the beat, so it is full well before advance.
  const revealedChars = useMemo(() => {
    const beat = current ?? stageBeat;
    if (!beat) return 0;
    const full = revealLength(beat);
    // Instant or reduced motion: the whole text is simply there.
    if (!current || speed === "instant" || reduceMotion) return full;
    const reveal = revealMs(beat);
    const dwell = Math.max(1, dwellMs(beat, 1));
    if (reveal <= 0) return full;
    const fraction = Math.min(1, (progress * dwell) / reveal);
    return Math.max(0, Math.min(full, Math.round(fraction * full)));
  }, [current, stageBeat, speed, reduceMotion, progress]);

  const remainingMs = caughtUp ? 0 : runwayMs(beats, index, speed === "instant" ? 1 : speed, speed === "instant");
  const remainingBeats = Math.max(0, beats.length - index);

  const stateRef = useRef({ beats, index });
  stateRef.current = { beats, index };

  const advance = useCallback((): void => {
    const { beats: list, index: at } = stateRef.current;
    const beat = list[at];
    if (!beat) return;
    accumulator.current = 0;
    setProgress(0);
    setCursorKey(beat.key);
  }, []);

  // Reset the in-flight dwell only when the beat itself changes, so pause,
  // resume and a speed change all keep their place inside the beat.
  useEffect(() => {
    accumulator.current = 0;
    setProgress(0);
    lastFrame.current = 0;
  }, [current?.key]);

  useEffect(() => {
    if (!playing || !current) {
      lastFrame.current = 0;
      return;
    }

    if (speed === "instant") {
      const timer = window.setTimeout(advance, CADENCE.instantTick);
      return () => window.clearTimeout(timer);
    }

    const dwell = Math.max(1, dwellMs(current, 1));
    let frame = 0;
    let painted = 0;
    // A restarting loop (speed change, pause, new content) must not bill the
    // viewer for the wall-clock gap since the last frame.
    lastFrame.current = 0;

    const step = (now: number): void => {
      if (lastFrame.current === 0) lastFrame.current = now;
      const delta = now - lastFrame.current;
      lastFrame.current = now;
      accumulator.current += delta * speed;

      if (accumulator.current >= dwell) {
        advance();
        return;
      }
      if (now - painted > 100) {
        painted = now;
        setProgress(accumulator.current / dwell);
      }
      frame = window.requestAnimationFrame(step);
    };

    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, speed, advance, current]);

  const seekTo = useCallback(
    (key: string): void => {
      const at = beats.findIndex((beat) => beat.key === key);
      if (at < 0) return;
      setCursorKey(at === 0 ? null : beats[at - 1].key);
      accumulator.current = 0;
      setProgress(0);
    },
    [beats],
  );

  const next = useCallback((): void => {
    advance();
  }, [advance]);

  // Reveal the current beat's text in full without advancing. Because the
  // reveal is read off the same clock, this just jumps the accumulator to the
  // end of the reveal window and lets the settle play out.
  const skipReveal = useCallback((): void => {
    if (!current || speed === "instant" || reduceMotion) return;
    const reveal = revealMs(current);
    if (accumulator.current >= reveal) return;
    accumulator.current = reveal;
    setProgress(Math.min(1, reveal / Math.max(1, dwellMs(current, 1))));
  }, [current, speed, reduceMotion]);

  const previous = useCallback((): void => {
    if (caughtUp) {
      setCursorKey(beats.length >= 2 ? beats[beats.length - 2].key : null);
    } else {
      setCursorKey(index >= 2 ? beats[index - 2].key : null);
    }
    accumulator.current = 0;
    setProgress(0);
  }, [beats, caughtUp, index]);

  const jumpToLive = useCallback((): void => {
    const tail = beats[beats.length - 1];
    setCursorKey(tail ? tail.key : null);
    accumulator.current = 0;
    setProgress(0);
  }, [beats]);

  return {
    beats,
    stageBeat,
    previousBeat,
    presentedCount,
    caughtUp,
    progress,
    revealedChars,
    playing,
    speed,
    remainingMs,
    remainingBeats,
    play: useCallback(() => setPlaying(true), []),
    pause: useCallback(() => setPlaying(false), []),
    toggle: useCallback(() => setPlaying((value) => !value), []),
    setSpeed,
    next,
    previous,
    seekTo,
    jumpToLive,
    skipReveal,
  };
}
