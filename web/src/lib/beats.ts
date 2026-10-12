import type { GameEvent, GamePlayer } from "@/lib/game";

/**
 * Turns the raw engine event stream into dramatic "beats" — one render unit per
 * moment worth watching. Pure, no React, no value imports (so the dev harness in
 * `web/scripts/inspect-beats.mts` can run it under Node's type-stripping).
 *
 * Safety property, relied on by the playback cursor: the fold is forward-only
 * with a mutable tail. Once a beat is closed nothing about it ever changes, so
 * `lastSeq` of a closed beat is invariant and a cursor expressed in event
 * sequences can never point at the wrong beat however the 1.5s poll rebuilds
 * the array.
 */

export type SpeakerRef = { id: string; name: string };

export type PlayerIndex = {
  byId: Map<string, string>;
  byName: Map<string, string>;
};

export type BeatPhase = {
  act: number;
  actKind: "prologue" | "night" | "day";
  day: number;
  actTitle: string;
  scene: string;
  round: number | null;
};

/** Which register a beat reads in — drives cadence and colour, not content. */
export type BeatClass = "narrative" | "mechanical" | "private" | "marker";

type BeatBase = {
  /** Stable under append; never derived from `lastSeq`, so a growing tail keeps its React key. */
  key: string;
  firstSeq: number;
  /** Close boundary. Grows while the beat is open; frozen once `closed`. */
  lastSeq: number;
  closed: boolean;
  class: BeatClass;
  phase: BeatPhase;
  at: string;
  events: GameEvent[];
};

export type Voice = {
  speaker: SpeakerRef | null;
  body: string;
  seq: number;
  truncated: boolean;
};

export type SpeechBeat = BeatBase & {
  kind: "speech";
  speaker: SpeakerRef | null;
  body: string;
  truncated: boolean;
  /** The speaker's own private reasoning, when it trailed this beat. */
  thought: string | null;
};

export type PileOnBeat = BeatBase & {
  kind: "pileOn";
  targetId: string | null;
  target: SpeakerRef | null;
  voices: Voice[];
  /** True once the runway summarises the run instead of showing every line. */
  collapsed: boolean;
};

export type PassRunBeat = BeatBase & {
  kind: "passRun";
  voices: SpeakerRef[];
};

/**
 * A final declaration: the commitment that replaced the old mandatory final
 * speech. It is a commitment with a named target rather than a line of prose,
 * so it gets its own kind — the engine words it "<Speaker> will vote for
 * <Target>: <reason>.", not "<Speaker>: <body>".
 */
export type DeclarationBeat = BeatBase & {
  kind: "declaration";
  speaker: SpeakerRef | null;
  /** The player the speaker committed to, or null for the bare "declares" form. */
  target: SpeakerRef | null;
  /** The stated reason, or "" when a target was named without one. */
  body: string;
  truncated: boolean;
};

export type BallotBeat = BeatBase & {
  kind: "ballot";
  scope: "sheriff" | "exile";
  label: string;
  votes: { voter: SpeakerRef | null; target: SpeakerRef | null; seq: number }[];
};

export type VoteTallyBeat = BeatBase & {
  kind: "voteTally";
  counts: { target: SpeakerRef | null; count: number }[];
  raw: string;
};

export type EliminationBeat = BeatBase & {
  kind: "elimination";
  player: SpeakerRef | null;
  role: string | null;
  cause: "eaten" | "exiled" | "unknown";
};

export type NightBeat = BeatBase & {
  kind: "night";
  night: number;
  wolves: string[];
  mealVictim: SpeakerRef | null;
  mealTied: boolean;
  mealAt: string | null;
  checks: { reader: SpeakerRef | null; target: SpeakerRef | null; result: string }[];
  plans: { speaker: SpeakerRef | null; body: string }[];
};

export type MarkerBeat = BeatBase & {
  kind: "marker";
  title: string;
  detail: string;
};

export type TextBeat = BeatBase & { kind: "text"; event: GameEvent };

export type Beat =
  | SpeechBeat
  | PileOnBeat
  | PassRunBeat
  | DeclarationBeat
  | BallotBeat
  | VoteTallyBeat
  | EliminationBeat
  | NightBeat
  | MarkerBeat
  | TextBeat;

export const GROUPING = {
  /** Voices on one target before the runway calls it a pile-on and collapses it. */
  PILE_ON_MIN: 3,
  PILE_ON_MAX_VOICES: 8,
  PASS_RUN_MIN: 2,
} as const;

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

const CUT_MARKER = "[Time is up.]";
const NAME_PREFIX = /^([^:\n]{1,40}):[ \t]+/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildPlayerIndex(players: GamePlayer[]): PlayerIndex {
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const player of players) {
    byId.set(player.id, player.name);
    byName.set(player.name, player.id);
  }
  return { byId, byName };
}

/**
 * The engine has no actor field — the speaker lives in the message as
 * `"Name: body"`. The prefix is only trusted when it names a real player:
 * a blind `^([^:]{1,40}):\s` also matches "Votes: Curie 7, Babbage 1.".
 */
export function parseSpeaker(
  event: GameEvent,
  index: PlayerIndex,
): { speaker: SpeakerRef | null; body: string } {
  const match = NAME_PREFIX.exec(event.message);
  if (match) {
    const name = match[1].trim();
    const id = index.byName.get(name);
    if (id) {
      return { speaker: { id, name }, body: event.message.slice(match[0].length) };
    }
  }
  if (event.playerId) {
    const name = index.byId.get(event.playerId) ?? event.playerId;
    return { speaker: { id: event.playerId, name }, body: event.message };
  }
  return { speaker: null, body: event.message };
}

/**
 * Some engine messages name their actor without a colon — `"Ada stays silent."`,
 * `"Ada nods along with Babbage."`. Only a real player name is accepted.
 */
export function speakerFromMessage(message: string, index: PlayerIndex): SpeakerRef | null {
  const colon = NAME_PREFIX.exec(message);
  if (colon) {
    const name = colon[1].trim();
    const id = index.byName.get(name);
    if (id) return { id, name };
  }
  for (const [name, id] of index.byName) {
    if (message.startsWith(`${name} `)) return { id, name };
  }
  return null;
}

function splitCut(body: string): { body: string; truncated: boolean } {
  const at = body.lastIndexOf(CUT_MARKER);
  if (at < 0) return { body, truncated: false };
  return { body: body.slice(0, at).trim(), truncated: true };
}

/** Players named in `body`, excluding `speakerId`, with the index of first mention. */
export function findTargetPositions(
  body: string,
  speakerId: string | null,
  index: PlayerIndex,
): { id: string; at: number }[] {
  const hits: { id: string; at: number }[] = [];
  for (const [name, id] of index.byName) {
    if (id === speakerId) continue;
    const match = new RegExp(`\\b${escapeRegExp(name)}\\b`).exec(body);
    if (match) hits.push({ id, at: match.index });
  }
  hits.sort((a, b) => a.at - b.at);
  return hits;
}

/** Player ids named in `body`, in order of first mention. */
export function findTargets(body: string, speakerId: string | null, index: PlayerIndex): string[] {
  return findTargetPositions(body, speakerId, index).map((hit) => hit.id);
}

/** "The werewolves chose Curie." */
function parseMeal(message: string): string | null {
  const match = /^The werewolves chose (.+)\.$/.exec(message);
  return match ? match[1].trim() : null;
}

/** "Curie is a villager." / "Edsger is a werewolf." */
function parseInvestigation(message: string): { name: string; result: string } | null {
  const match = /^(.+?) is (?:a|the) (.+)\.$/.exec(message);
  return match ? { name: match[1].trim(), result: match[2].trim() } : null;
}

/** "Ada votes for Curie." */
function parseVoteCast(message: string): { voter: string; target: string } | null {
  const match = /^(.+?) votes for (.+)\.$/.exec(message);
  return match ? { voter: match[1].trim(), target: match[2].trim() } : null;
}

/** A name resolved the way `refOf` does — a real player when known, else a bare name. */
function refFromName(name: string, index: PlayerIndex): SpeakerRef | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const id = index.byName.get(trimmed);
  return id ? { id, name: trimmed } : { id: trimmed, name: trimmed };
}

/** The speaker named at the head of a declaration, falling back to the event's own actor. */
function speakerFromName(name: string, event: GameEvent, index: PlayerIndex): SpeakerRef | null {
  const trimmed = name.trim();
  const id = index.byName.get(trimmed);
  if (id) return { id, name: trimmed };
  if (event.playerId) {
    const fallback = index.byId.get(event.playerId) ?? event.playerId;
    return { id: event.playerId, name: fallback };
  }
  return { id: trimmed, name: trimmed };
}

/**
 * The three shapes the engine words a `final_declaration` in:
 *   "<Speaker> will vote for <Target>: <reason>."
 *   "<Speaker> will vote for <Target>."
 *   "<Speaker> declares: <reason>."
 *
 * The first two put the speaker's name before " will vote for ", NOT before a
 * colon, so `parseSpeaker`'s NAME_PREFIX (which needs "<Name>: ") cannot read
 * them — it would match the whole "Speaker will vote for Target" span and then
 * fail the name lookup, silently dropping the attribution to `event.playerId`.
 * The third has a colon, but after " declares", so it fails there too. Hence a
 * parser of their own. `body` is the reason, empty on the target-only form.
 */
function parseFinalDeclaration(
  event: GameEvent,
  index: PlayerIndex,
): { speaker: SpeakerRef | null; target: SpeakerRef | null; body: string } {
  const vote = /^(.+?) will vote for (.+?)(?:: (.*))?\.$/.exec(event.message);
  if (vote) {
    return {
      speaker: speakerFromName(vote[1], event, index),
      target: refFromName(vote[2], index),
      body: (vote[3] ?? "").trim(),
    };
  }
  const declares = /^(.+?) declares: (.*)\.$/.exec(event.message);
  if (declares) {
    return {
      speaker: speakerFromName(declares[1], event, index),
      target: null,
      body: declares[2].trim(),
    };
  }
  // An unrecognised shape still renders as a declaration attributed the way any
  // other event is — never a silent drop into the generic text line.
  const { speaker, body } = parseSpeaker(event, index);
  return { speaker, target: null, body };
}

/** "Votes: Curie 7, Babbage 1." */
export function parseTally(message: string): { name: string; count: number }[] {
  const match = /^Votes: (.+)\.$/.exec(message);
  if (!match) return [];
  const parts: { name: string; count: number }[] = [];
  for (const chunk of match[1].split(",")) {
    const entry = /^(.+?) (\d+)$/.exec(chunk.trim());
    if (entry) parts.push({ name: entry[1].trim(), count: Number(entry[2]) });
  }
  return parts;
}

/** "Curie was eaten overnight. They were a villager." (and the exiled form) */
export function parseRemoval(
  message: string,
): { name: string; cause: "eaten" | "exiled" | "unknown"; role: string | null } | null {
  const match =
    /^(.+?) was (eaten overnight|exiled by the village)\. They (?:were|was) (.+)\.$/.exec(message);
  if (!match) return null;
  return {
    name: match[1].trim(),
    cause: match[2] === "eaten overnight" ? "eaten" : "exiled",
    role: match[3].trim(),
  };
}

function parseRound(message: string): number | null {
  const match = /round (\d+) of (\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

const SCENE_TITLES: Record<string, string> = {
  game_started: "The gathering",
  introductions_started: "The gathering",
  introductions_completed: "The gathering",
  sheriff_election_started: "Sheriff election",
  discussion_started: "Opening discussion",
  final_statements_started: "Final declarations",
  exile_vote_started: "Exile vote",
  sheriff_succession_required: "Sheriff succession",
  werewolf_planning_started: "Private Werewolf planning",
  werewolf_meal_started: "Werewolf meal",
  dawn_started: "Dawn",
  game_finished: "Finale",
};

export function markerTitle(kind: string, message: string): string {
  switch (kind) {
    case "discussion_round_started":
    case "werewolf_planning_round_started":
    case "night_started":
    case "dawn_started":
    case "game_finished":
      return message;
    default:
      return SCENE_TITLES[kind] ?? "Village proceedings";
  }
}

/** Short headline for a marker beat; the message itself is the detail. */
const MARKER_TITLES: Record<string, string> = {
  game_started: "The gathering",
  sheriff_elected: "The Sheriff is chosen",
  sheriff_election_tied: "The election is tied",
  sheriff_succeeded: "A new Sheriff",
  sheriff_appointed: "The Sheriff names a successor",
  sheriff_succession_required: "A successor is demanded",
  exile_tied: "The vote is tied",
  no_exile: "No one is exiled",
  game_finished: "The village decides",
};

// --------------------------------------------------------------------------
// The fold
// --------------------------------------------------------------------------

/** A run of consecutive speeches pressing the same target, materialised as one beat. */
type Run = {
  voices: Voice[];
  target: string | null;
  at: string;
  events: GameEvent[];
  phase: BeatPhase;
};

export function buildBeats(events: GameEvent[], players: GamePlayer[]): Beat[] {
  const index = buildPlayerIndex(players);
  const beats: Beat[] = [];

  // Running phase state, snapshotted into every beat.
  let act = 0;
  let actKind: BeatPhase["actKind"] = "prologue";
  let title = "Prologue";
  let day = 0;
  let scene = "Prologue";
  let round: number | null = null;

  const snapshot = (): BeatPhase => ({
    act,
    actKind,
    day,
    actTitle: `Act ${act} · ${title}`,
    scene,
    round,
  });

  /**
   * The open tail beat, and the run of same-target speeches feeding it.
   *
   * Both are read back through accessors rather than as plain locals: every
   * mutation happens inside a helper closure, which TypeScript's control-flow
   * analysis cannot see, so a bare `let` would narrow to its initial `null` and
   * every `beat.kind` check would collapse to `never`.
   */
  let openBeat: Beat | null = null;
  let activeRun: Run | null = null;

  const tail = (): Beat | null => openBeat;
  const currentRun = (): Run | null => activeRun;

  const nameOf = (id: string | null): string | null => (id ? (index.byId.get(id) ?? id) : null);
  const refOf = (name: string | null): SpeakerRef | null => {
    if (!name) return null;
    const id = index.byName.get(name);
    return id ? { id, name } : { id: name, name };
  };
  // The same ref, resolved from an id instead of a name. Events that address a
  // player by id — a reading's `recipients`, which is the Fortune Teller alone —
  // still need a name to render, and this is the only other direction of lookup.
  const refOfId = (id: string | null): SpeakerRef | null =>
    id ? { id, name: index.byId.get(id) ?? id } : null;

  const closeTail = (): void => {
    const beat = tail();
    if (beat) beat.closed = true;
    openBeat = null;
  };

  /** Push a beat as the growable tail. */
  const pushTail = (beat: Beat): void => {
    closeTail();
    beats.push(beat);
    openBeat = beat;
  };

  /** Push a beat that can never grow. */
  const pushClosed = (beat: Beat): void => {
    closeTail();
    beat.closed = true;
    beats.push(beat);
  };

  /** End the current runway — any open speech, ballot or pass run. */
  const flush = (): void => {
    activeRun = null;
    closeTail();
  };

  /** Rebuild the tail beat from the current run, so the newest voice is visible live. */
  const materialiseRun = (): void => {
    const run = currentRun();
    if (!run || run.voices.length === 0) return;
    const key = `${run.voices[0].seq}:say`;
    const beat: Beat =
      run.voices.length === 1
        ? {
            key,
            firstSeq: run.voices[0].seq,
            lastSeq: run.voices[0].seq,
            closed: false,
            class: "narrative",
            phase: run.phase,
            at: run.at,
            events: run.events.slice(),
            kind: "speech",
            speaker: run.voices[0].speaker,
            body: run.voices[0].body,
            truncated: run.voices[0].truncated,
            thought: tail()?.kind === "speech" && tail()?.key === key ? (tail() as SpeechBeat).thought : null,
          }
        : {
            key,
            firstSeq: run.voices[0].seq,
            lastSeq: run.voices[run.voices.length - 1].seq,
            closed: false,
            class: "narrative",
            phase: run.phase,
            at: run.at,
            events: run.events.slice(),
            kind: "pileOn",
            targetId: run.target,
            target: run.target ? refOf(nameOf(run.target)) : null,
            voices: run.voices.map((voice) => ({ ...voice })),
            collapsed: run.voices.length >= GROUPING.PILE_ON_MIN,
          };
    const previous = tail();
    if (previous && previous.key === key && beats[beats.length - 1] === previous) {
      beats[beats.length - 1] = beat;
      openBeat = beat;
    } else {
      pushTail(beat);
    }
  };

  for (const event of events) {
    const kind = event.kind;
    const seq = event.sequence;

    // -- phase ------------------------------------------------------------
    if (act === 0 && kind !== "night_started") {
      act = 1;
      actKind = "prologue";
      title = "Prologue";
      scene = "Prologue";
    }
    switch (kind) {
      case "night_started":
        day += 1;
        act += 1;
        actKind = "night";
        title = `Night ${day}`;
        scene = event.message;
        round = null;
        break;
      case "dawn_started":
        if (!(actKind === "day" && title === `Day ${day}`)) {
          act += 1;
          actKind = "day";
          title = `Day ${day}`;
        }
        scene = "Dawn";
        round = null;
        break;
      case "discussion_round_started":
        round = parseRound(event.message);
        scene = event.message;
        break;
      case "werewolf_planning_round_started":
        round = parseRound(event.message);
        break;
      default:
        if (SCENE_TITLES[kind]) {
          scene = SCENE_TITLES[kind];
          round = null;
        }
        break;
    }
    const phase = snapshot();

    // -- transparency -----------------------------------------------------
    // Private reasoning trails the action it belongs to; it must never interrupt it.
    if (kind === "player_thought" || kind === "character_defined") {
      const beat = tail();
      if (kind === "player_thought" && beat?.kind === "speech" && beat.speaker) {
        const { speaker, body } = parseSpeaker(event, index);
        if (speaker && speaker.id === beat.speaker.id) {
          beat.thought = splitCut(body).body;
          beat.lastSeq = Math.max(beat.lastSeq, seq);
        }
      }
      continue;
    }

    // -- night, dramatised ------------------------------------------------
    if (kind === "night_started") {
      flush();
      pushTail({
        key: `${seq}:night`,
        firstSeq: seq,
        lastSeq: seq,
        closed: false,
        class: "private",
        phase,
        at: event.at,
        events: [event],
        kind: "night",
        night: day,
        wolves: [],
        mealVictim: null,
        mealTied: false,
        mealAt: null,
        checks: [],
        plans: [],
      });
      continue;
    }

    // A night kill is a public removal like any other. The night scene closes
    // when its body is revealed, and the removal falls through to the runway so
    // the ordinary `player_removed` handling gives the dawn its elimination beat.
    let removalFallsThrough = false;
    const openNight = tail();
    if (openNight?.kind === "night") {
      const night = openNight;
      night.events.push(event);
      night.lastSeq = Math.max(night.lastSeq, seq);
      if (kind.startsWith("werewolf") || kind === "meal_chosen" || kind === "meal_choice_tied") {
        for (const recipient of event.recipients) {
          if (!night.wolves.includes(recipient)) night.wolves.push(recipient);
        }
      }
      switch (kind) {
        case "investigation_result": {
          const parsed = parseInvestigation(event.message);
          if (parsed) {
            // The reading is addressed to the Fortune Teller alone, so `recipients`
            // is who did it — the half of "who read whom" that the message text
            // does not carry.
            night.checks.push({
              reader: refOfId(event.recipients[0] ?? null),
              target: refOf(parsed.name),
              result: parsed.result,
            });
          }
          break;
        }
        case "meal_chosen":
          night.mealVictim = refOf(parseMeal(event.message));
          night.mealAt = event.at;
          break;
        case "meal_choice_tied":
          night.mealTied = true;
          break;
        case "werewolf_plan": {
          // Only the wolf's final word in the planning thread: the earlier rounds
          // are the same argument being refined.
          const { speaker, body } = parseSpeaker(event, index);
          const text = splitCut(body).body;
          const seen = night.plans.findIndex((plan) => plan.speaker?.id === speaker?.id);
          if (seen >= 0) night.plans[seen] = { speaker, body: text };
          else night.plans.push({ speaker, body: text });
          break;
        }
        case "dawn_started":
          // Dawn, and the body it reveals, are this beat's payoff.
          night.class = "narrative";
          break;
        case "player_removed": {
          const removal = parseRemoval(event.message);
          if (removal?.cause === "eaten") {
            closeTail();
            removalFallsThrough = true;
          }
          break;
        }
        default:
          break;
      }
      if (!removalFallsThrough) continue;
    }

    // -- runway -----------------------------------------------------------
    switch (kind) {
      case "town_hall_message": {
        const { speaker, body: rawBody } = parseSpeaker(event, index);
        const { body, truncated } = splitCut(rawBody);
        const primary = findTargets(body, speaker?.id ?? null, index)[0] ?? null;

        let run = currentRun();
        if (!run || !primary || primary !== run.target || run.voices.length >= GROUPING.PILE_ON_MAX_VOICES) {
          flush();
          run = { voices: [], target: primary, at: event.at, events: [], phase };
          activeRun = run;
        }
        run.voices.push({ speaker, body, seq, truncated });
        run.events.push(event);
        materialiseRun();
        break;
      }

      case "town_hall_agreement": {
        // An endorsement of a case already on the table — never emitted by the
        // current engine, but if it is, it reads as a line rather than a speech.
        activeRun = null;
        pushClosed({
          key: `${seq}:text`,
          firstSeq: seq,
          lastSeq: seq,
          closed: true,
          class: "mechanical",
          phase,
          at: event.at,
          events: [event],
          kind: "text",
          event,
        });
        break;
      }

      case "final_declaration": {
        // The commitment that replaced the old mandatory final speech. It is not
        // dialogue: it names a target rather than answering the room, so it ends
        // any open runway and stands alone as one closed beat. Handled explicitly
        // so it can never reach the generic `default` and render as a bare line.
        activeRun = null;
        const parsed = parseFinalDeclaration(event, index);
        const { body, truncated } = splitCut(parsed.body);
        pushClosed({
          key: `${seq}:declare`,
          firstSeq: seq,
          lastSeq: seq,
          closed: true,
          class: "narrative",
          phase,
          at: event.at,
          events: [event],
          kind: "declaration",
          speaker: parsed.speaker,
          target: parsed.target,
          body,
          truncated,
        });
        break;
      }

      case "player_introduced": {
        const { speaker, body: rawBody } = parseSpeaker(event, index);
        const { body, truncated } = splitCut(rawBody);
        activeRun = null;
        pushClosed({
          key: `${seq}:speech`,
          firstSeq: seq,
          lastSeq: seq,
          closed: true,
          class: "narrative",
          phase,
          at: event.at,
          events: [event],
          kind: "speech",
          speaker,
          body,
          truncated,
          thought: null,
        });
        break;
      }

      case "town_hall_pass": {
        const speaker = speakerFromMessage(event.message, index);
        const openPass = tail();
        if (openPass?.kind === "passRun") {
          if (speaker) openPass.voices.push(speaker);
          openPass.lastSeq = Math.max(openPass.lastSeq, seq);
          openPass.events.push(event);
        } else {
          activeRun = null;
          pushTail({
            key: `${seq}:pass`,
            firstSeq: seq,
            lastSeq: seq,
            closed: false,
            class: "mechanical",
            phase,
            at: event.at,
            events: [event],
            kind: "passRun",
            voices: speaker ? [speaker] : [],
          });
        }
        break;
      }

      case "vote_cast": {
        const parsed = parseVoteCast(event.message);
        const vote = {
          voter: parsed ? refOf(parsed.voter) : null,
          target: parsed ? refOf(parsed.target) : null,
          seq,
        };
        const openBallot = tail();
        if (openBallot?.kind === "ballot") {
          openBallot.votes.push(vote);
          openBallot.lastSeq = Math.max(openBallot.lastSeq, seq);
          openBallot.events.push(event);
        } else {
          activeRun = null;
          const sheriff = phase.scene === "Sheriff election";
          pushTail({
            key: `${seq}:ballot`,
            firstSeq: seq,
            lastSeq: seq,
            closed: false,
            class: "mechanical",
            phase,
            at: event.at,
            events: [event],
            kind: "ballot",
            scope: sheriff ? "sheriff" : "exile",
            label: sheriff ? "Sheriff election" : `Exile vote · Day ${phase.day}`,
            votes: [vote],
          });
        }
        break;
      }

      case "votes_tallied": {
        const counts = parseTally(event.message).map((entry) => ({
          target: refOf(entry.name),
          count: entry.count,
        }));
        activeRun = null;
        pushClosed({
          key: `${seq}:tally`,
          firstSeq: seq,
          lastSeq: seq,
          closed: true,
          class: "narrative",
          phase,
          at: event.at,
          events: [event],
          kind: "voteTally",
          counts,
          raw: event.message,
        });
        break;
      }

      case "player_removed": {
        const removal = parseRemoval(event.message);
        const playerId = event.playerId ?? (removal ? (index.byName.get(removal.name) ?? null) : null);
        activeRun = null;
        pushClosed({
          key: `${seq}:elim`,
          firstSeq: seq,
          lastSeq: seq,
          closed: true,
          class: "narrative",
          phase,
          at: event.at,
          events: [event],
          kind: "elimination",
          player: playerId
            ? { id: playerId, name: index.byId.get(playerId) ?? removal?.name ?? playerId }
            : refOf(removal?.name ?? null),
          role: event.revealedRole ?? removal?.role ?? null,
          cause: removal?.cause ?? "unknown",
        });
        break;
      }

      case "game_started":
      case "sheriff_elected":
      case "sheriff_election_tied":
      case "sheriff_succeeded":
      case "sheriff_appointed":
      case "sheriff_succession_required":
      case "exile_tied":
      case "no_exile":
      case "game_finished": {
        activeRun = null;
        pushClosed({
          key: `${seq}:marker`,
          firstSeq: seq,
          lastSeq: seq,
          closed: true,
          class: "marker",
          phase,
          at: event.at,
          events: [event],
          kind: "marker",
          title: MARKER_TITLES[kind] ?? markerTitle(kind, event.message),
          detail: event.message,
        });
        break;
      }

      // Phase boundaries: they end whatever was open and start nothing new.
      case "dawn_started":
      case "discussion_started":
      case "discussion_round_started":
      case "final_statements_started":
      case "exile_vote_started":
      case "sheriff_election_started":
      case "introductions_started":
      case "introductions_completed":
      case "werewolf_planning_started":
      case "werewolf_planning_round_started":
      case "werewolf_meal_started":
      case "werewolf_plan_pass":
        flush();
        break;

      default: {
        if (event.visibility === "private") break;
        activeRun = null;
        pushClosed({
          key: `${seq}:text`,
          firstSeq: seq,
          lastSeq: seq,
          closed: true,
          class: "mechanical",
          phase,
          at: event.at,
          events: [event],
          kind: "text",
          event,
        });
        break;
      }
    }
  }

  const last = tail();
  if (last) last.closed = true;
  return beats;
}

// --------------------------------------------------------------------------
// Grouping and reuse
// --------------------------------------------------------------------------

export function groupBeatsByAct(beats: Beat[]): { title: string; beats: Beat[] }[] {
  const groups: { title: string; beats: Beat[] }[] = [];
  for (const beat of beats) {
    const last = groups[groups.length - 1];
    if (last && last.title === beat.phase.actTitle) {
      last.beats.push(beat);
    } else {
      groups.push({ title: beat.phase.actTitle, beats: [beat] });
    }
  }
  return groups;
}

/**
 * Returns the previous object for any beat whose key and close boundary are
 * unchanged, so `React.memo` sees a stable identity across the 1.5s poll.
 */
export function reuseBeats(previous: Beat[], next: Beat[]): Beat[] {
  if (previous.length === 0) return next;
  const byKey = new Map(previous.map((beat) => [beat.key, beat]));
  let changed = previous.length !== next.length;
  const merged = next.map((beat, index) => {
    const old = byKey.get(beat.key);
    if (old && old.lastSeq === beat.lastSeq) {
      if (!changed && previous[index] !== old) changed = true;
      return old;
    }
    changed = true;
    return beat;
  });
  return changed ? merged : previous;
}
