"use client";

import type { Beat } from "@/lib/beats";
import type { GroundTruth, TruthLevel } from "@/lib/truth";
import { BeatCard } from "@/components/beat-card";

/**
 * The dialogue scene is a fixed two-slot window on the conversation: the line
 * being spoken types on at the top, and the line it answers sits greyed below
 * it — the older message is pushed down and dimmed the moment a new one lands,
 * so a run of speeches reads as people following up on each other rather than as
 * a transcript. There are only ever two slots, never a growing list: the box is
 * a window, not a log.
 *
 * The past slot is filled only when the previous beat was itself dialogue. A
 * ballot, tally, night or story beat is a different kind of thing and must not
 * be re-shown inside a speech box; when one of them precedes the current line
 * the current line simply stands alone, and the scene change is its own signal.
 *
 * Both slots hold their full text in the DOM from the first paint. Only the
 * current slot reveals, and the reveal is pure opacity — nothing is ever built
 * up by concatenation, so the box can never reflow as it types.
 */

const DIALOGUE_KINDS: ReadonlySet<Beat["kind"]> = new Set<Beat["kind"]>([
  "speech",
  "pileOn",
  "passRun",
]);

function isDialogue(beat: Beat | undefined): boolean {
  return beat !== undefined && DIALOGUE_KINDS.has(beat.kind);
}

type DialoguePairProps = {
  current: Beat;
  previous: Beat | undefined;
  /** Characters of the current beat's text to show; the past slot never animates. */
  reveal: number;
  level: TruthLevel;
  reasoning: boolean;
  truth: GroundTruth;
  nameOf: (id: string) => string;
  /**
   * The current speaker's voice, or undefined when the run has none. Only the
   * live slot is given it — the greyed past slot shows the line it is answering,
   * not who is answering, so its speaker's voice would be a second copy of a
   * description already spent.
   */
  voiceOf?: (id: string) => string | undefined;
  expandedKeys: Set<string>;
  onToggle: (key: string) => void;
};

export function DialoguePair(props: DialoguePairProps) {
  const current = props.current;
  const past = isDialogue(props.previous) ? props.previous : undefined;
  return (
    <div className="dialogue-pair">
      <div className="dialogue-slot is-current">
        <BeatCard
          beat={current}
          expanded={props.expandedKeys.has(current.key)}
          level={props.level}
          nameOf={props.nameOf}
          onToggle={props.onToggle}
          reasoning={props.reasoning}
          reveal={props.reveal}
          truth={props.truth}
          voiceOf={props.voiceOf}
        />
      </div>
      {past ? (
        <div className="dialogue-slot is-past">
          <BeatCard
            beat={past}
            expanded={props.expandedKeys.has(past.key)}
            level={props.level}
            nameOf={props.nameOf}
            onToggle={props.onToggle}
            reasoning={props.reasoning}
            reveal={null}
            truth={props.truth}
          />
        </div>
      ) : null}
    </div>
  );
}
