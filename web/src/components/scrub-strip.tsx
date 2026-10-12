"use client";

import type { Beat } from "@/lib/beats";

/** Moments that earn a heavier mark on the filmstrip. */
const DRAMATIC = new Set(["elimination", "night", "voteTally"]);

type Props = {
  acts: { title: string; beats: Beat[] }[];
  /** How many beats have been presented so far. */
  presentedCount: number;
  stageKey: string | undefined;
  onSeek: (key: string) => void;
};

export function ScrubStrip({ acts, presentedCount, stageKey, onSeek }: Props) {
  let offset = 0;
  return (
    <div className="scrub-strip">
      {acts.map((act, actIndex) => {
        const base = offset;
        offset += act.beats.length;
        return (
          <section className="scrub-act" key={`${act.title}-${actIndex}`}>
            <h3 className="scrub-act-label">{act.title}</h3>
            <div className="scrub-beats">
              {act.beats.map((beat, beatIndex) => {
                const position = base + beatIndex;
                const state =
                  beat.key === stageKey ? "is-current" : position < presentedCount ? "is-played" : "is-future";
                return (
                  <button
                    aria-label={`${beat.phase.scene}, beat ${position + 1}`}
                    className={`scrub-beat ${state}${DRAMATIC.has(beat.kind) ? " is-dramatic" : ""}`}
                    key={beat.key}
                    onClick={() => onSeek(beat.key)}
                    title={`${beat.phase.scene} · ${beat.phase.actTitle}`}
                    type="button"
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
