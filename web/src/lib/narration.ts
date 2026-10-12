import type { Beat } from "@/lib/beats";
import type { TruthLevel } from "@/lib/truth";

/**
 * What the spectator *hears*.
 *
 * This is the audio twin of `beat-card.tsx`: for every beat on the stage it
 * produces the ordered lines a narrator would read aloud, one line per thing the
 * screen shows. The invariant is one-directional — the narration may never say
 * *more* than the card renders. A blind viewer must not hear a werewolf's name
 * any more than they may read it, so the night beat is level-gated here exactly
 * as it is in the component.
 *
 * The module is PURE: no React, no browser APIs, and — because the dev harness in
 * `web/scripts/inspect-beats.mts` loads it under Node's native type-stripping,
 * which resolves no path aliases at runtime — only *type* imports. `import type`
 * is erased before Node ever sees the module, so the `@/lib/*` specifiers never
 * have to resolve. Anything imported for its value would break that harness.
 */

/** One utterance. `speakerId` of `null` selects the narrator voice. */
export type NarrationLine = { speakerId: string | null; text: string };

export type NarrationContext = {
  level: TruthLevel;
  reasoning: boolean;
  /**
   * Resolve a player id to a display name. Carried for `NightBeat.wolves`, which
   * is a list of raw ids rather than `SpeakerRef`s.
   */
  nameOf: (id: string) => string;
};

export function narrationFor(beat: Beat, context: NarrationContext): NarrationLine[] {
  switch (beat.kind) {
    case "speech": {
      const speakerId = beat.speaker?.id ?? null;
      const lines: NarrationLine[] = [{ speakerId, text: beat.body }];
      // Mirror `showThought`: private reasoning is spoken only when the viewer
      // has asked for it (or is the operator). Never in blind mode.
      if (beat.thought && (context.reasoning || context.level === "director")) {
        lines.push({ speakerId, text: beat.thought });
      }
      return lines;
    }

    case "pileOn": {
      const lines: NarrationLine[] = [
        { speakerId: null, text: `The room turns on ${beat.target?.name ?? "the accused"}.` },
      ];
      // The same fold the card applies: a collapsed run shows only its head, and
      // the rest is summarised. Speaking the hidden voices would put words in the
      // room's mouth that the viewer never saw.
      const shown = beat.collapsed ? beat.voices.slice(0, 1) : beat.voices;
      for (const voice of shown) {
        lines.push({ speakerId: voice.speaker?.id ?? null, text: voice.body });
      }
      if (beat.collapsed) {
        const hidden = beat.voices.length - 1;
        if (hidden > 0) lines.push({ speakerId: null, text: `${hidden} more voices join.` });
      }
      return lines;
    }

    case "passRun": {
      const names = beat.voices.map((voice) => voice.name);
      const text =
        names.length === 0
          ? "Someone lets the moment pass."
          : `${names.join(", ")} ${names.length === 1 ? "stays" : "stay"} silent.`;
      return [{ speakerId: null, text }];
    }

    case "declaration": {
      // Mirror the card: speaker, the named target, the stated reason. The
      // engine's sentence is third-person, so the narrator reads it rather than
      // the player's own voice — a player announcing "Ada will vote for Curie"
      // in Ada's voice would be the one thing the card cannot show.
      const name = beat.speaker?.name ?? "Someone";
      const text = beat.target
        ? beat.body
          ? `${name} will vote for ${beat.target.name}: ${beat.body}.`
          : `${name} will vote for ${beat.target.name}.`
        : beat.body
          ? `${name} declares: ${beat.body}.`
          : `${name} makes a declaration.`;
      return [{ speakerId: null, text }];
    }

    case "ballot": {
      const count = beat.votes.length;
      return [
        {
          speakerId: null,
          text: `${beat.label}. ${count} ${count === 1 ? "ballot" : "ballots"} cast.`,
        },
      ];
    }

    case "voteTally":
      // The engine already words the tally as a sentence; read it verbatim.
      return [{ speakerId: null, text: beat.raw }];

    case "elimination": {
      const name = beat.player?.name ?? "Someone";
      const moved =
        beat.cause === "eaten"
          ? "taken in the night"
          : beat.cause === "exiled"
            ? "exiled by the village"
            : "removed from the village";
      // A null role (old-engine run, no reveal) must still read as a sentence —
      // "They were a unknown." does not — so the unknown case gets its own clause.
      const roleClause =
        !beat.role || beat.role.toLowerCase() === "unknown"
          ? "They were unknown."
          : `They were a ${beat.role}.`;
      return [{ speakerId: null, text: `${name} was ${moved}. ${roleClause}` }];
    }

    case "night": {
      // Blind mode is the whole point of the gate: the card collapses the night to
      // one line, and the audio must collapse with it or the truth leaks by ear.
      if (context.level === "blind") {
        return [{ speakerId: null, text: "Something moves in the forest. The village sleeps." }];
      }
      const lines: NarrationLine[] = [{ speakerId: null, text: `Night ${beat.night}.` }];
      // The card names the pack from raw ids, and so do we — this is the one line
      // `nameOf` exists for. It sits below the blind gate, so the roster can never
      // leak by ear.
      if (beat.wolves.length > 0) {
        lines.push({ speakerId: null, text: `The pack: ${beat.wolves.map(context.nameOf).join(", ")}.` });
      }
      if (beat.mealVictim) {
        lines.push({ speakerId: null, text: `The pack chose ${beat.mealVictim.name}.` });
      }
      for (const check of beat.checks) {
        // The card falls back to "?" for an unattributed reading; match it.
        lines.push({ speakerId: null, text: `${check.target?.name ?? "?"} is ${check.result}.` });
      }
      return lines;
    }

    case "marker":
      return [{ speakerId: null, text: `${beat.title}. ${beat.detail}` }];

    case "text":
      return [{ speakerId: null, text: beat.event.message }];

    default:
      // Exhaustive over the `Beat` union; anything new speaks nothing until it is
      // given a voice here, which is the safe default.
      return [];
  }
}
