"use client";

import { useCallback } from "react";

import type { Beat } from "@/lib/beats";
import { revealLength } from "@/lib/cadence";
import type { GroundTruth, TruthLevel } from "@/lib/truth";
import { BeatCard } from "@/components/beat-card";
import { DialoguePair } from "@/components/dialogue-pair";
import { SceneBanner, sceneBanner, sceneOf } from "@/components/scene-banner";

type Props = {
  beat: Beat | undefined;
  /** The beat before the one on stage, for the greyed past slot. */
  previousBeat: Beat | undefined;
  /** Characters of the current beat's text to reveal. */
  revealedChars: number;
  /** Show the current beat's text in full without advancing. */
  skipReveal: () => void;
  level: TruthLevel;
  reasoning: boolean;
  truth: GroundTruth;
  nameOf: (id: string) => string;
  /**
   * The current speaker's voice, or undefined when the run has none. Passed only
   * into the live slot so the beat on stage can name who is talking; the greyed
   * past slot and the transcript below never carry it.
   */
  voiceOf: (id: string) => string | undefined;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
  playing: boolean;
  caughtUp: boolean;
  active: boolean;
  totalBeats: number;
  beatNumber: number;
};

export function GameStage({
  beat,
  previousBeat,
  revealedChars,
  skipReveal,
  level,
  reasoning,
  truth,
  nameOf,
  voiceOf,
  expandedKeys,
  onToggle,
  playing,
  caughtUp,
  active,
  totalBeats,
  beatNumber,
}: Props) {
  const scene = sceneOf(beat);
  const banner = beat ? sceneBanner(beat, previousBeat) : null;
  // A reveal that cannot be skipped makes the reader wait for text that already
  // exists — the documented reason typewriter effects are disliked. So skipping
  // is offered two ways: this button, and a click anywhere on the stage body.
  // It is only offered while there is text still to type; under instant or
  // reduced motion the reveal is already full and the button would do nothing.
  const revealing = beat !== undefined && revealedChars < revealLength(beat);
  const skip = useCallback((): void => skipReveal(), [skipReveal]);

  return (
    <section className="game-stage" aria-live="polite">
      <header className="stage-header">
        <div>
          <p className="eyebrow">{beat ? beat.phase.actTitle : "Waiting for the first beat"}</p>
          <h2 className="stage-scene">{beat ? beat.phase.scene : "The village is gathering"}</h2>
        </div>
        <span className="stage-counter">
          {totalBeats === 0 ? "no beats yet" : `beat ${beatNumber} of ${totalBeats}`}
        </span>
      </header>

      <div className="stage-body" data-scene={scene} onClick={revealing ? skip : undefined}>
        {banner ? <SceneBanner banner={banner} key={banner.key} /> : null}

        {beat ? (
          scene === "dialogue" ? (
            <DialoguePair
              current={beat}
              expandedKeys={expandedKeys}
              level={level}
              nameOf={nameOf}
              onToggle={onToggle}
              previous={previousBeat}
              reasoning={reasoning}
              reveal={revealedChars}
              truth={truth}
              voiceOf={voiceOf}
            />
          ) : (
            // Ballot, tally, night, elimination, marker, text: none of these has a
            // single speaker, so the voice line has nowhere to go and is not passed.
            <BeatCard
              beat={beat}
              expanded={expandedKeys.has(beat.key)}
              level={level}
              nameOf={nameOf}
              onToggle={onToggle}
              reasoning={reasoning}
              reveal={revealedChars}
              truth={truth}
            />
          )
        ) : (
          <p className="stage-empty">
            {active
              ? "The moderator has not published an event yet. The stage will start as soon as the village gathers."
              : "This run recorded no events."}
          </p>
        )}

        {revealing ? (
          <button
            aria-keyshortcuts="S"
            className="stage-skip"
            onClick={(event) => {
              event.stopPropagation();
              skip();
            }}
            title="Skip the reveal (S)"
            type="button"
          >
            Skip the reveal
          </button>
        ) : null}
      </div>

      <footer className="stage-foot">
        {caughtUp ? (
          <span>{active ? "Waiting for the game to continue…" : "That is the whole run."}</span>
        ) : playing ? (
          <span className="stage-playing">Playing</span>
        ) : (
          <span className="stage-paused">Paused</span>
        )}
      </footer>
    </section>
  );
}
