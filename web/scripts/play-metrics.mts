/**
 * play-metrics — dev-only measurement over the recorded run corpus.
 *
 * The point of this file is to make a prompt change *judgeable*: it recomputes
 * the known baseline numbers from the raw event streams so that any later
 * reading of a changed prompt is anchored to a tool that reproduces the "before".
 * If a number here disagrees with a stated baseline, that is reported, never
 * tuned away — a definition bent to fit a target measures nothing.
 *
 * No build step: Node strips the types. Like the sibling `inspect-beats.mts` it
 * needs the `@/*` alias hook, so the working invocation is
 *
 *   cd web && node --experimental-strip-types --import ./scripts/alias-hook.mjs \
 *     scripts/play-metrics.mts [options]
 *
 *   (no args)             every run under ../data/runs, per-run lines + aggregate + calibration
 *   <run-id prefix>       one run, full metric block
 *   --dir <path>          use <path> as the corpus instead of ../data/runs
 *   --compare <A> <B>     two-arm comparison: per-seed paired deltas + aggregate
 *
 * Everything is `sequence`-ordered and pure. Parsing is delegated to
 * `src/lib/beats.ts` (ballot grouping, `parseRemoval`) and `src/lib/truth.ts`
 * (beliefs, ground truth) rather than re-derived here.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GameEvent, GamePlayer } from "../src/lib/game.ts";
import {
  buildBeats,
  buildPlayerIndex,
  type BallotBeat,
  type Beat,
  type EliminationBeat,
  type PlayerIndex,
  type SpeakerRef,
} from "../src/lib/beats.ts";
import { deriveBeliefs, deriveGroundTruth } from "../src/lib/truth.ts";

const DEFAULT_DATA_DIR = resolve(import.meta.dirname, "..", "..", "data", "runs");

// ---------------------------------------------------------------------------
// Known baselines (the acceptance test). The prompt change must be judged
// against these. They are *expectations*, not inputs — the script never reads
// them when computing, only when printing the calibration verdict.
//
// PROVENANCE. Re-measured 2026-10-12 against the six completed runs of the
// `2026-10-11-voices` batch (web/scripts/batches/2026-10-11.json, corpus
// `data/runs`), which is the reference corpus future batches are compared to.
// They replace the previous constants (`8 of 29`, `27 of 38`, agree=4, pass=17),
// which described a corpus that has since been deleted: against every run that
// is present they reported MISMATCH, so they calibrated nothing. The numbers
// below are what this script itself prints for the completed-run scope.
//   · exile accuracy  8/19 by-removal (by-ballot agrees) — 42.1%
//   · wolf bandwagon  19/30 — 63.3%
//   · agree / pass    0 / 0 — this corpus emits no town_hall_agreement or
//                     town_hall_pass events at all, so these two rows now
//                     detect the *introduction* of such events, not their rate.
// ---------------------------------------------------------------------------
const BASELINE = {
  exileAccuracy: { wolves: 8, exiles: 19, label: "8 of 19 (42.1%)" },
  wolfBandwagon: { hits: 19, votes: 30, label: "19 of 30 (63.3%)" },
  agree: 0,
  pass: 0,
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * On-disk ndjson records are snake_case (`player_id`, `revealed_role`) and drop
 * `recipients` on public events; the running app normalises them at ingest
 * (see `src/lib/server/runner.ts`). A direct read must do the same, or every
 * `event.playerId` in `beats.ts` silently becomes undefined.
 */
type RawEvent = {
  sequence: number;
  at: string;
  kind: string;
  visibility: "public" | "private";
  recipients?: string[];
  player_id?: string | null;
  revealed_role?: string | null;
  message: string;
};

type RawResult = {
  seed?: string | number | null;
  winner?: string | null;
  players?: { id: string; name?: string; role?: string | null; alive?: boolean | null }[];
};

function normalizeEvent(raw: RawEvent): GameEvent {
  return {
    sequence: raw.sequence,
    at: raw.at,
    kind: raw.kind,
    visibility: raw.visibility,
    recipients: raw.recipients ?? [],
    playerId: raw.player_id ?? null,
    revealedRole: raw.revealed_role ?? null,
    message: raw.message,
  };
}

type LoadedRun = {
  id: string;
  dir: string;
  players: GamePlayer[];
  index: PlayerIndex;
  events: GameEvent[];
  /** Final roles from the sanitized result, when the run completed. */
  roster: Map<string, string> | null;
  seed: string | null;
  winner: string | null;
};

function loadRun(dir: string, id: string): LoadedRun | null {
  const configPath = join(dir, "input", "config.json");
  let config: { players: { id: string; name: string }[] };
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as typeof config;
  } catch {
    return null;
  }
  const players: GamePlayer[] = config.players.map((player) => ({
    id: player.id,
    name: player.name,
    role: null,
    alive: null,
  }));
  const index = buildPlayerIndex(players);

  let events: GameEvent[] = [];
  let result: RawResult | null = null;
  let rawText = "";
  const eventsPath = join(dir, "output", "events.ndjson");
  try {
    const raw = readFileSync(eventsPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as { type?: string; event?: RawEvent; result?: RawResult };
      if (record.type === "event" && record.event) events.push(normalizeEvent(record.event));
      // The terminal `result` record rides in the same stream and carries the seed.
      else if (record.type === "result" && record.result) {
        result = record.result;
        rawText = line;
      }
    }
  } catch {
    events = [];
  }

  // Prefer the standalone artifact (inspect-beats convention); the ndjson
  // result line is the fallback and supplies the seed for both.
  try {
    const artifactText = readFileSync(join(dir, "output", "game-result.json"), "utf8");
    result = JSON.parse(artifactText) as RawResult;
    rawText = artifactText;
  } catch {
    /* keep whatever the stream gave us */
  }

  let roster: Map<string, string> | null = null;
  if (result?.players?.length) {
    roster = new Map(result.players.map((player) => [player.id, player.role ?? "unknown"]));
  }
  // The seed is a full uint64: JSON.parse would round it through a float64 and lose the low
  // digits, so read it straight out of the text instead. The console writes it to a launch
  // sibling of the input config, which exists even for a run that died before any result
  // artifact was written — prefer it, then fall back to the result artifact / stream record.
  let seed = readLaunchSeed(join(dir, "input", "launch.json"));
  if (!seed) {
    seed = extractSeed(rawText);
  }
  if (!seed) {
    try {
      seed = extractSeed(readFileSync(configPath, "utf8"));
    } catch {
      /* leave it null */
    }
  }
  return {
    id,
    dir,
    players,
    index,
    events,
    roster,
    seed,
    winner: result?.winner ?? null,
  };
}

/** Uint64 seed, read as text so `JSON.parse`'s float64 rounding cannot lose the low digits. */
function extractSeed(text: string): string | null {
  const match = /"seed"\s*:\s*"?(\d+)"?/.exec(text);
  return match ? match[1] : null;
}

/**
 * The launch sibling the console writes for every run: `{ seed: "<decimal>" }`. It is present
 * even when the run died before writing a result artifact, so it is the one seed source a failed
 * run cannot lose. Read as text (via `extractSeed`) so a uint64 seed is not rounded.
 */
function readLaunchSeed(filePath: string): string | null {
  try {
    return extractSeed(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listRunDirs(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** Final role map: the sanitized roster when the run completed, else the roles
 *  `deriveGroundTruth` rebuilds from the private night recipients. */
function rolesOf(run: LoadedRun): { roles: Map<string, string>; wolves: Set<string>; source: string } {
  if (run.roster) {
    const roles = new Map(run.roster);
    const wolves = new Set([...roles].filter(([, role]) => role === "werewolf").map(([id]) => id));
    return { roles, wolves, source: "roster" };
  }
  const truth = deriveGroundTruth(run.players, run.events);
  const roles = new Map([...truth.roles].map(([id, role]) => [id, role as string]));
  return { roles, wolves: new Set(truth.wolves), source: truth.source };
}

// ---------------------------------------------------------------------------
// Final statements — the target each voter named in their own last word that day
// ---------------------------------------------------------------------------

/**
 * The scene title the `final_statements_started` phase carries in `beats.ts`
 * (its `SCENE_TITLES`). The phase event kind is unchanged; only the wording moved
 * from "Final statements" to "Final declarations", so this string must track it.
 */
const FINAL_STATEMENTS_SCENE = "Final declarations";

/**
 * Vote declarations: the clause where a voter *commits* to a target, rather than
 * naming players for context. Only explicit first-person forms count, so a
 * final statement such as "X's case doesn't hold and Y has been quiet — I'll
 * vote Z" matches on Z, not on the first name mentioned. This is the anchor for
 * dissent (i): the ballot and the sentence are both recorded, so a mismatch
 * between them is evidence of play, not a bug (the engine documents that a
 * ballot may legally differ from what was said).
 */
const DECLARATION_SHAPES = [
  String.raw`\bi(?:\s+will|\s+am|['’]ll|['’]m)?\s*(?:be\s+|going\s+to\s+)?vot(?:e|ing)\s+(?:for\s+)?(NAME)\b`,
  String.raw`\bmy\s+(?:vote|ballot)\s+(?:goes|go|lands|drops|is\s+going|will\s+go)\s+(?:to|on|for)\s+(NAME)\b`,
  String.raw`\b(NAME)\s+(?:gets|has|will\s+get|receives)\s+my\s+(?:vote|ballot)\b`,
] as const;

function declarationTarget(body: string, index: PlayerIndex): string | null {
  const alternation = [...index.byName.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  for (const shape of DECLARATION_SHAPES) {
    const match = new RegExp(shape.replace("NAME", `(${alternation})`), "i").exec(body);
    if (!match) continue;
    const id = index.byName.get(match[1]);
    if (id) return id;
  }
  return null;
}

/**
 * Scans the day's final statements for a declared vote target, and counts how
 * many statements produced one at all — the coverage figure that has to be
 * printed beside any dissent (i) rate.
 *
 * Two shapes count as a final statement. The old engine announced them as
 * ordinary speeches in the final-statements scene, and their target is read out
 * of the prose. The current engine emits a `final_declaration` beat instead,
 * which already carries the committed target, so its prose scan is only the
 * fallback for the bare "declares:" form.
 */
function finalStatementDeclarations(
  beats: Beat[],
  index: PlayerIndex,
): { declared: Map<string, string>; statements: number; withDeclaration: number } {
  // key `${day}:${speakerId}` -> declared target id (their last final word that day wins)
  const declared = new Map<string, string>();
  let statements = 0;
  let withDeclaration = 0;
  for (const beat of beats) {
    if (beat.phase.scene !== FINAL_STATEMENTS_SCENE) continue;
    let speakers: { id: string; target: string | null }[] = [];
    if (beat.kind === "declaration") {
      if (beat.speaker) {
        speakers = [{ id: beat.speaker.id, target: beat.target?.id ?? declarationTarget(beat.body, index) }];
      }
    } else {
      const voices: { speaker: SpeakerRef | null; body: string }[] =
        beat.kind === "speech"
          ? [{ speaker: beat.speaker, body: beat.body }]
          : beat.kind === "pileOn"
            ? beat.voices.map((voice) => ({ speaker: voice.speaker, body: voice.body }))
            : [];
      speakers = voices
        .filter((voice): voice is { speaker: SpeakerRef; body: string } => voice.speaker !== null)
        .map((voice) => ({ id: voice.speaker.id, target: declarationTarget(voice.body, index) }));
    }
    for (const speaker of speakers) {
      statements += 1;
      if (speaker.target) {
        withDeclaration += 1;
        declared.set(`${beat.phase.day}:${speaker.id}`, speaker.target);
      }
    }
  }
  return { declared, statements, withDeclaration };
}

// ---------------------------------------------------------------------------
// Per-run metrics
// ---------------------------------------------------------------------------

export type RunMetrics = {
  id: string;
  seed: string | null;
  completed: boolean;
  truthSource: string;
  eventCount: number;
  wolfCount: number;

  // 1. exile accuracy
  exilesByRemoval: number; // player_removed with cause "exiled"
  wolfExilesByRemoval: number;
  exilesByBallot: number; // resolved exile ballots
  wolfExilesByBallot: number;
  chanceSamples: number[]; // per exile vote: living_wolves/living_players
  chanceRate: number | null; // mean of chanceSamples
  chanceVotes: number;

  // 2. wolf bandwagon
  wolfExileVotes: number;
  wolfBandwagonHits: number;

  // 3. contestedness
  exileBallots: number;
  exileVotes: number; // individual votes cast across those ballots
  contestedBallots: number;
  margins: number[]; // per exile ballot: top count - second count
  meanMargin: number | null;

  // 4. dissent
  finalStatements: number; // final statements seen — denominator for declaration coverage
  finalStatementsDeclared: number; // those carrying an explicit vote declaration
  dissentDeclared: number; // exile votes differing from the voter's declared target
  dissentDeclaredComparable: number; // votes where the voter declared a target
  dissentModal: number;
  dissentModalComparable: number; // votes where the modal target is unique

  // 5. assertiveness
  agree: number;
  pass: number;

  // 6. vote-intent reasoning
  mentions: number;
  cuedMentions: number;
  phrases: Map<string, number>;
  phraseHits: number;
  speechesScanned: number;
  speechesWithPhrase: number;

  // 7. thought quality
  thoughts: number;
  reasonedActions: number;
  thoughtLengths: number[];
  thoughtsNamingPlayer: number;

  // 8. cap pressure
  speechVoices: number;
  truncatedVoices: number;
  speechLengths: number[];
};

function analyzeRun(run: LoadedRun): RunMetrics {
  const beats = buildBeats(run.events, run.players);
  const { wolves, source: truthSource } = rolesOf(run);

  const ballots = beats.filter(isExileBallot);
  const removals = beats.filter(isElimination);
  const exileRemovals = removals.filter((beat) => beat.cause === "exiled");

  // -- ballots in stream order, each matched to the exile it produced ---------
  // An exile ballot's outcome is the exiled removal between it and the next
  // ballot (a tied round yields no removal, so its outcome is null).
  const orderedBallots = [...beats]
    .filter((beat) => beat.kind === "ballot")
    .sort((a, b) => a.firstSeq - b.firstSeq);
  const outcomeByBallot = new Map<Beat, string | null>();
  for (let i = 0; i < orderedBallots.length; i += 1) {
    const ballot = orderedBallots[i];
    const nextSeq = orderedBallots[i + 1]?.firstSeq ?? Number.POSITIVE_INFINITY;
    const outcome = exileRemovals.find(
      (removal) => removal.firstSeq > ballot.lastSeq && removal.firstSeq < nextSeq,
    );
    outcomeByBallot.set(ballot, outcome?.player?.id ?? null);
  }

  // -- 1. exile accuracy ----------------------------------------------------
  const exilesByRemoval = exileRemovals.length;
  const wolfExilesByRemoval = exileRemovals.filter((beat) => beat.role === "werewolf").length;
  let exilesByBallot = 0;
  let wolfExilesByBallot = 0;
  for (const ballot of ballots) {
    const outcome = outcomeByBallot.get(ballot) ?? null;
    if (!outcome) continue;
    exilesByBallot += 1;
    if (wolves.has(outcome)) wolfExilesByBallot += 1;
  }

  // Chance rate: living wolves / living players at each exile vote, averaged
  // over votes — the baseline drifts as players die, so 25% is only a reference.
  const removalSeqOf = new Map<string, number>();
  for (const beat of removals) {
    if (beat.player) removalSeqOf.set(beat.player.id, beat.firstSeq);
  }
  const allIds = run.players.map((player) => player.id);
  const aliveAt = (seq: number): string[] =>
    allIds.filter((id) => (removalSeqOf.get(id) ?? Number.POSITIVE_INFINITY) > seq);
  const chanceSamples: number[] = [];

  // -- votes over exile ballots --------------------------------------------
  let wolfExileVotes = 0;
  let wolfBandwagonHits = 0;
  let contestedBallots = 0;
  const margins: number[] = [];
  let dissentDeclared = 0;
  let dissentDeclaredComparable = 0;
  let dissentModal = 0;
  let dissentModalComparable = 0;
  let exileVotes = 0;

  const finalScan = finalStatementDeclarations(beats, run.index);

  for (const ballot of ballots) {
    const votes = ballot.votes.filter((vote) => vote.voter && vote.target);
    const counts = new Map<string, number>();
    for (const vote of votes) {
      const target = vote.target!.id;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    const distinct = counts.size;
    if (distinct > 1) contestedBallots += 1;
    const sorted = [...counts.values()].sort((a, b) => b - a);
    margins.push(sorted[0] - (sorted[1] ?? 0));

    const modal = [...counts].filter(([, count]) => count === sorted[0]).map(([id]) => id);
    const outcome = outcomeByBallot.get(ballot) ?? null;
    const alive = aliveAt(ballot.firstSeq);
    const livingWolves = alive.filter((id) => wolves.has(id)).length;

    for (const vote of votes) {
      const voter = vote.voter!.id;
      const target = vote.target!.id;
      exileVotes += 1;
      if (alive.length > 0) chanceSamples.push(livingWolves / alive.length);
      if (wolves.has(voter)) {
        wolfExileVotes += 1;
        if (outcome && target === outcome) wolfBandwagonHits += 1;
      }
      const declared = finalScan.declared.get(`${ballot.phase.day}:${voter}`);
      if (declared) {
        dissentDeclaredComparable += 1;
        if (declared !== target) dissentDeclared += 1;
      }
      if (modal.length === 1) {
        dissentModalComparable += 1;
        if (modal[0] !== target) dissentModal += 1;
      }
    }
  }

  // -- 5. assertiveness -----------------------------------------------------
  let agree = 0;
  let pass = 0;
  for (const event of run.events) {
    if (event.kind === "town_hall_agreement") agree += 1;
    else if (event.kind === "town_hall_pass") pass += 1;
  }

  // -- 6. vote-intent reasoning --------------------------------------------
  const beliefs = deriveBeliefs(run.events, run.index);
  let mentions = 0;
  let cuedMentions = 0;
  for (const list of beliefs.mentions.values()) {
    for (const mention of list) {
      mentions += 1;
      if (mention.cued) cuedMentions += 1;
    }
  }
  const phraseScan = scanPhrases(run);

  // -- 7. thought quality ---------------------------------------------------
  const reasonedActions = run.events.filter((event) => REASONED_ACTION_KINDS.has(event.kind)).length;
  const thoughtLengths: number[] = [];
  let thoughts = 0;
  let thoughtsNamingPlayer = 0;
  for (const event of run.events) {
    if (event.kind !== "player_thought") continue;
    thoughts += 1;
    const { speaker, body } = splitSpeaker(event.message, run.index);
    const text = stripCut(body);
    thoughtLengths.push(text.length);
    if (
      run.players.some(
        (player) =>
          player.id !== speaker && new RegExp(`\\b${escapeRegExp(player.name)}\\b`).test(text),
      )
    ) {
      thoughtsNamingPlayer += 1;
    }
  }

  // -- 8. cap pressure ------------------------------------------------------
  let speechVoices = 0;
  let truncatedVoices = 0;
  const speechLengths: number[] = [];
  for (const beat of beats) {
    const voices = beat.kind === "speech" ? [beat] : beat.kind === "pileOn" ? beat.voices : [];
    for (const voice of voices) {
      speechVoices += 1;
      if (voice.truncated) truncatedVoices += 1;
      speechLengths.push(voice.body.length);
    }
  }

  return {
    id: run.id,
    seed: run.seed,
    completed: Boolean(run.roster),
    truthSource,
    eventCount: run.events.length,
    wolfCount: wolves.size,
    exilesByRemoval,
    wolfExilesByRemoval,
    exilesByBallot,
    wolfExilesByBallot,
    chanceSamples,
    chanceRate: chanceSamples.length ? mean(chanceSamples) : null,
    chanceVotes: chanceSamples.length,
    wolfExileVotes,
    wolfBandwagonHits,
    exileBallots: ballots.length,
    exileVotes,
    contestedBallots,
    margins,
    meanMargin: margins.length ? mean(margins) : null,
    finalStatements: finalScan.statements,
    finalStatementsDeclared: finalScan.withDeclaration,
    dissentDeclared,
    dissentDeclaredComparable,
    dissentModal,
    dissentModalComparable,
    agree,
    pass,
    mentions,
    cuedMentions,
    phrases: phraseScan.counts,
    phraseHits: phraseScan.hits,
    speechesScanned: phraseScan.speeches,
    speechesWithPhrase: phraseScan.withPhrase,
    thoughts,
    reasonedActions,
    thoughtLengths,
    thoughtsNamingPlayer,
    speechVoices,
    truncatedVoices,
    speechLengths,
  };
}

// ---------------------------------------------------------------------------
// Lexical scan — who-benefits / manipulation framing
// ---------------------------------------------------------------------------

/**
 * Explicit phrase list, printed by the report so the number is auditable.
 * Deliberately narrow: these are framings a player uses when they are reasoning
 * about *motive* rather than evidence.
 */
const MANIPULATION_PHRASES = [
  "who benefits",
  "who-benefits",
  "what do they gain",
  "what does that gain",
  "wants you to",
  "wanted you to",
  "trying to frame",
  "frame me",
  "framing me",
  "set me up",
  "scapegoat",
  "distract",
  "turn us against",
  "turn you against",
  "why would they",
  "why would he",
  "why would she",
  "cover story",
  "misdirect",
  "deflect",
  "redirect",
  "manufactured",
  "engineered",
] as const;

/** Public speech that can carry a manipulation read. */
const SPEECH_KINDS = new Set(["town_hall_message", "player_introduced"]);

/** Every action a player may attach private reasoning to (see `recordThought`). */
const REASONED_ACTION_KINDS = new Set([
  "town_hall_message",
  "player_introduced",
  "town_hall_pass",
  "town_hall_agreement",
  "vote_cast",
  "werewolf_plan",
  "werewolf_plan_pass",
  // The final declaration carries the voter's reasoning for their commitment,
  // so it is a reasoned action like any other turn.
  "final_declaration",
]);

function scanPhrases(run: LoadedRun): {
  counts: Map<string, number>;
  hits: number;
  speeches: number;
  withPhrase: number;
} {
  const counts = new Map<string, number>();
  let hits = 0;
  let speeches = 0;
  let withPhrase = 0;
  for (const event of run.events) {
    if (!SPEECH_KINDS.has(event.kind) || event.visibility !== "public") continue;
    speeches += 1;
    const { body } = splitSpeaker(event.message, run.index);
    const lower = body.toLowerCase();
    let touched = false;
    for (const phrase of MANIPULATION_PHRASES) {
      let from = 0;
      for (;;) {
        const at = lower.indexOf(phrase, from);
        if (at < 0) break;
        counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
        hits += 1;
        touched = true;
        from = at + phrase.length;
      }
    }
    if (touched) withPhrase += 1;
  }
  return { counts, hits, speeches, withPhrase };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CUT_MARKER = "[Time is up.]";
const NAME_PREFIX = /^([^:\n]{1,40}):[ \t]+/;

function isExileBallot(beat: Beat): beat is BallotBeat {
  return beat.kind === "ballot" && beat.scope === "exile";
}

function isElimination(beat: Beat): beat is EliminationBeat {
  return beat.kind === "elimination";
}


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripCut(body: string): string {
  const at = body.lastIndexOf(CUT_MARKER);
  return at < 0 ? body : body.slice(0, at).trim();
}

function splitSpeaker(message: string, index: PlayerIndex): { speaker: string | null; body: string } {
  const match = NAME_PREFIX.exec(message);
  if (match && index.byName.has(match[1].trim())) {
    return { speaker: index.byName.get(match[1].trim())!, body: message.slice(match[0].length) };
  }
  return { speaker: null, body: message };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(hit: number, total: number): string {
  if (!total) return "n/a";
  return `${((hit / total) * 100).toFixed(1)}%`;
}

function ratio(hit: number, total: number): string {
  return `${hit}/${total} (${pct(hit, total)})`;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

type Aggregate = {
  runs: number;
  events: number;
  exilesByRemoval: number;
  wolfExilesByRemoval: number;
  exilesByBallot: number;
  wolfExilesByBallot: number;
  chanceRate: number | null;
  chanceVotes: number;
  wolfExileVotes: number;
  wolfBandwagonHits: number;
  exileBallots: number;
  exileVotes: number;
  contestedBallots: number;
  meanMargin: number | null;
  finalStatements: number;
  finalStatementsDeclared: number;
  dissentDeclared: number;
  dissentDeclaredComparable: number;
  dissentModal: number;
  dissentModalComparable: number;
  agree: number;
  pass: number;
  mentions: number;
  cuedMentions: number;
  phraseHits: number;
  speechesScanned: number;
  speechesWithPhrase: number;
  thoughts: number;
  reasonedActions: number;
  thoughtsNamingPlayer: number;
  thoughtLength: number;
  runsWithThoughts: number;
  runsWithBallots: number;
  speechVoices: number;
  truncatedVoices: number;
  speechMin: number;
  speechMedian: number;
  speechMax: number;
};

function aggregate(metrics: RunMetrics[]): Aggregate {
  const sums = metrics.map((m) => m);
  const sum = (pick: (m: RunMetrics) => number): number => sums.reduce((acc, m) => acc + pick(m), 0);
  const thoughtLengths = metrics.flatMap((m) => m.thoughtLengths);
  const speechLengths = metrics.flatMap((m) => m.speechLengths);
  const chanceSamples = metrics.flatMap((m) => m.chanceSamples);
  const margins = metrics.flatMap((m) => m.margins);
  return {
    runs: metrics.length,
    events: sum((m) => m.eventCount),
    exilesByRemoval: sum((m) => m.exilesByRemoval),
    wolfExilesByRemoval: sum((m) => m.wolfExilesByRemoval),
    exilesByBallot: sum((m) => m.exilesByBallot),
    wolfExilesByBallot: sum((m) => m.wolfExilesByBallot),
    chanceRate: chanceSamples.length ? mean(chanceSamples) : null,
    chanceVotes: chanceSamples.length,
    wolfExileVotes: sum((m) => m.wolfExileVotes),
    wolfBandwagonHits: sum((m) => m.wolfBandwagonHits),
    exileBallots: sum((m) => m.exileBallots),
    exileVotes: sum((m) => m.exileVotes),
    contestedBallots: sum((m) => m.contestedBallots),
    meanMargin: margins.length ? mean(margins) : null,
    finalStatements: sum((m) => m.finalStatements),
    finalStatementsDeclared: sum((m) => m.finalStatementsDeclared),
    dissentDeclared: sum((m) => m.dissentDeclared),
    dissentDeclaredComparable: sum((m) => m.dissentDeclaredComparable),
    dissentModal: sum((m) => m.dissentModal),
    dissentModalComparable: sum((m) => m.dissentModalComparable),
    agree: sum((m) => m.agree),
    pass: sum((m) => m.pass),
    mentions: sum((m) => m.mentions),
    cuedMentions: sum((m) => m.cuedMentions),
    phraseHits: sum((m) => m.phraseHits),
    speechesScanned: sum((m) => m.speechesScanned),
    speechesWithPhrase: sum((m) => m.speechesWithPhrase),
    thoughts: sum((m) => m.thoughts),
    reasonedActions: sum((m) => m.reasonedActions),
    thoughtsNamingPlayer: sum((m) => m.thoughtsNamingPlayer),
    thoughtLength: thoughtLengths.length ? mean(thoughtLengths) : 0,
    runsWithThoughts: metrics.filter((m) => m.thoughts > 0).length,
    runsWithBallots: metrics.filter((m) => m.exileBallots > 0 || m.exilesByRemoval > 0).length,
    speechVoices: sum((m) => m.speechVoices),
    truncatedVoices: sum((m) => m.truncatedVoices),
    speechMin: speechLengths.length ? Math.min(...speechLengths) : 0,
    speechMedian: median(speechLengths),
    speechMax: speechLengths.length ? Math.max(...speechLengths) : 0,
  };
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

function printDefinitions(): void {
  console.log("METRIC DEFINITIONS (the number is printed beside each so it can be audited)");
  console.log("  1 exile accuracy     exiles that landed on a werewolf / total exiles. Shown two ways:");
  console.log("                       by-removal = `player_removed` with cause \"exiled\";");
  console.log("                       by-ballot  = resolved exile ballots (one outcome per ballot).");
  console.log("    chance rate        mean over exile votes of (living wolves / living players at that vote).");
  console.log("  2 wolf bandwagon     wolf votes on exile ballots whose target is the ballot's exile / all wolf exile votes.");
  console.log("  3 contestedness      share of exile ballots with >1 distinct target; mean margin top-minus-second.");
  console.log("  4 dissent (i)        share of exile votes whose target differs from the target the voter *declared* in their");
  console.log("                       own final statement that day (explicit \"I'll vote X\" / \"my vote goes to X\" forms only).");
  console.log("                       Printed with coverage: statements carrying a declaration / all final statements.");
  console.log("    dissent (ii)       share of exile votes whose target differs from the ballot's unique modal target.");
  console.log("  5 assertiveness      counts of town_hall_agreement and town_hall_pass events.");
  console.log("  6 vote-intent        accusation-cued mentions / all player mentions (deriveBeliefs), plus a literal scan of");
  console.log("                       public speeches for who-benefits / manipulation framing phrases.");
  console.log("  7 thought quality    player_thought presence / reasoned actions, mean length, share naming another player.");
  console.log("  8 cap pressure       share of speech voices with the truncation flag; speech length min/median/max (chars).");
  console.log("");
}

/** `[baseline: yes]` marks a metric with a known corpus figure; `no` means a
 *  change in that row cannot be read as a regression or improvement against
 *  history — it is fresh-arm-only. */
function baselineTag(has: boolean): string {
  return has ? "[baseline: yes]" : "[baseline: no ]";
}

function printAggregate(label: string, agg: Aggregate): void {
  console.log(`AGGREGATE — ${label}`);
  console.log(`  runs=${agg.runs}  events=${agg.events}  runs-with-votes=${agg.runsWithBallots}  runs-emitting-thoughts=${agg.runsWithThoughts}`);
  console.log("  [baseline: yes] = a known corpus figure exists; [baseline: no] = fresh-arm-only, not comparable to history.");
  console.log(
    `  1 exile accuracy   by-removal ${ratio(agg.wolfExilesByRemoval, agg.exilesByRemoval)}   by-ballot ${ratio(agg.wolfExilesByBallot, agg.exilesByBallot)}   ${baselineTag(true)}`,
  );
  console.log(
    `    chance rate      ${agg.chanceRate === null ? "n/a" : pct(agg.chanceRate, 1)}  (over ${agg.chanceVotes} exile votes)   ${baselineTag(false)}`,
  );
  console.log(`  2 wolf bandwagon   ${ratio(agg.wolfBandwagonHits, agg.wolfExileVotes)}   ${baselineTag(true)}`);
  console.log(
    `  3 contestedness    contested ${ratio(agg.contestedBallots, agg.exileBallots)}   mean margin ${agg.meanMargin?.toFixed(2) ?? "n/a"}   ${baselineTag(false)}`,
  );
  console.log(
    `  4 dissent (i)      declared target differs from the ballot ${ratio(agg.dissentDeclared, agg.dissentDeclaredComparable)}   ${baselineTag(false)}`,
  );
  console.log(
    `    coverage         final statements with a declaration ${ratio(agg.finalStatementsDeclared, agg.finalStatements)}   (vote-level: ${ratio(agg.dissentDeclaredComparable, agg.exileVotes)} of exile votes comparable)`,
  );
  console.log(
    `    dissent (ii)     differs from modal target ${ratio(agg.dissentModal, agg.dissentModalComparable)}   ${baselineTag(false)}`,
  );
  console.log(`  5 assertiveness    agree=${agg.agree}  pass=${agg.pass}   ${baselineTag(true)}`);
  console.log(
    `  6 vote-intent      cued mentions ${ratio(agg.cuedMentions, agg.mentions)}   phrase hits=${agg.phraseHits} in ${agg.speechesScanned} speeches (${agg.speechesWithPhrase} carry >=1)   ${baselineTag(false)}`,
  );
  console.log(
    `  7 thought quality  presence ${ratio(agg.thoughts, agg.reasonedActions)}   mean length ${agg.thoughtLength.toFixed(0)}c   naming a player ${ratio(agg.thoughtsNamingPlayer, agg.thoughts)}   ${baselineTag(false)}`,
  );
  console.log(
    `  8 cap pressure     truncation ${ratio(agg.truncatedVoices, agg.speechVoices)}   speech len min/median/max = ${agg.speechMin}/${agg.speechMedian}/${agg.speechMax}   ${baselineTag(false)}`,
  );
  console.log("");
}

function printRun(run: LoadedRun, m: RunMetrics, detailed: boolean): void {
  const chance = m.chanceRate === null ? "n/a" : pct(m.chanceRate, 1);
  console.log(
    `${m.id.slice(0, 8)}  ${m.completed ? "done" : "partial"}  seed=${m.seed ?? "?"}  truth=${m.truthSource}  events=${m.eventCount}  wolves=${m.wolfCount}`,
  );
  console.log(
    `  exiles by-removal ${ratio(m.wolfExilesByRemoval, m.exilesByRemoval)}  by-ballot ${ratio(m.wolfExilesByBallot, m.exilesByBallot)}  chance ${chance}  bandwagon ${ratio(m.wolfBandwagonHits, m.wolfExileVotes)}`,
  );
  if (!detailed) return;
  console.log(
    `  contested ${ratio(m.contestedBallots, m.exileBallots)}  margin ${m.meanMargin?.toFixed(2) ?? "n/a"}  agree=${m.agree} pass=${m.pass}`,
  );
  console.log(
    `  dissent declared ${ratio(m.dissentDeclared, m.dissentDeclaredComparable)} (declared coverage ${ratio(m.finalStatementsDeclared, m.finalStatements)})  modal ${ratio(m.dissentModal, m.dissentModalComparable)}`,
  );
  console.log(
    `  mentions ${ratio(m.cuedMentions, m.mentions)} cued  phrases=${m.phraseHits}/${m.speechesScanned}`,
  );
  console.log(
    `  thoughts ${ratio(m.thoughts, m.reasonedActions)} (mean ${m.thoughtLengths.length ? (m.thoughtLengths.reduce((a, b) => a + b, 0) / m.thoughtLengths.length).toFixed(0) : 0}c, naming ${ratio(m.thoughtsNamingPlayer, m.thoughts)})`,
  );
  console.log(
    `  truncation ${ratio(m.truncatedVoices, m.speechVoices)}  speech min/med/max = ${m.speechLengths.length ? Math.min(...m.speechLengths) : 0}/${median(m.speechLengths)}/${m.speechLengths.length ? Math.max(...m.speechLengths) : 0}`,
  );
}

function verdict(computed: string, expected: string, match: boolean): string {
  return match ? `MATCH` : `*** MISMATCH *** computed ${computed}, expected ${expected}`;
}

function printCalibration(scopes: { label: string; note: string; agg: Aggregate }[]): void {
  console.log("CALIBRATION — the acceptance test. A computed value that disagrees is reported, not tuned.");
  for (const scope of scopes) {
    const { agg } = scope;
    console.log("");
    console.log(`  scope: ${scope.label}`);
    console.log(`  (${scope.note})`);
    const exileMatch =
      agg.wolfExilesByRemoval === BASELINE.exileAccuracy.wolves &&
      agg.exilesByRemoval === BASELINE.exileAccuracy.exiles;
    console.log(
      `    exile accuracy      expected ${BASELINE.exileAccuracy.label.padEnd(18)}  by-removal ${ratio(agg.wolfExilesByRemoval, agg.exilesByRemoval)}   ${verdict(ratio(agg.wolfExilesByRemoval, agg.exilesByRemoval), BASELINE.exileAccuracy.label, exileMatch)}`,
    );
    const bandMatch =
      agg.wolfBandwagonHits === BASELINE.wolfBandwagon.hits &&
      agg.wolfExileVotes === BASELINE.wolfBandwagon.votes;
    console.log(
      `    wolf bandwagon      expected ${BASELINE.wolfBandwagon.label.padEnd(18)}  computed   ${ratio(agg.wolfBandwagonHits, agg.wolfExileVotes)}   ${verdict(ratio(agg.wolfBandwagonHits, agg.wolfExileVotes), BASELINE.wolfBandwagon.label, bandMatch)}`,
    );
    console.log(
      `    town_hall_agreement expected ${String(BASELINE.agree).padEnd(18)}  computed   ${agg.agree}   ${verdict(String(agg.agree), String(BASELINE.agree), agg.agree === BASELINE.agree)}`,
    );
    console.log(
      `    town_hall_pass      expected ${String(BASELINE.pass).padEnd(18)}  computed   ${agg.pass}   ${verdict(String(agg.pass), String(BASELINE.pass), agg.pass === BASELINE.pass)}`,
    );
  }
  console.log("");
}

function printPhraseList(runs: RunMetrics[]): void {
  const totals = new Map<string, number>();
  for (const run of runs) {
    for (const [phrase, count] of run.phrases) {
      totals.set(phrase, (totals.get(phrase) ?? 0) + count);
    }
  }
  console.log("  phrase list (literal, case-insensitive substring over public speeches):");
  console.log(`    ${MANIPULATION_PHRASES.join(" | ")}`);
  const fired = [...totals].sort((a, b) => b[1] - a[1]);
  if (fired.length) {
    console.log(`    fired: ${fired.map(([phrase, count]) => `${phrase}×${count}`).join(", ")}`);
  } else {
    console.log("    fired: (none)");
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Comparison mode
// ---------------------------------------------------------------------------

type Pairing = { seed: string | null; a: RunMetrics | null; b: RunMetrics | null };

function pairRuns(
  a: RunMetrics[],
  b: RunMetrics[],
): { pairs: Pairing[]; method: string; unseeded: RunMetrics[] } {
  const aSeeds = a.filter((m) => m.seed);
  const bSeeds = b.filter((m) => m.seed);
  if (aSeeds.length === a.length && bSeeds.length === b.length && a.length > 0) {
    const bBySeed = new Map(b.map((m) => [m.seed!, m]));
    const pairs: Pairing[] = a.map((m) => ({ seed: m.seed, a: m, b: bBySeed.get(m.seed!) ?? null }));
    const aSeedSet = new Set(a.map((m) => m.seed!));
    for (const m of b) if (!aSeedSet.has(m.seed!)) pairs.push({ seed: m.seed, a: null, b: m });
    return { pairs, method: "by seed", unseeded: [] };
  }
  const n = Math.max(a.length, b.length);
  const pairs: Pairing[] = [];
  for (let i = 0; i < n; i += 1) {
    pairs.push({
      seed: a[i]?.seed ?? b[i]?.seed ?? null,
      a: a[i] ?? null,
      b: b[i] ?? null,
    });
  }
  // A run whose seed could not be recovered is named explicitly rather than quietly paired by
  // position, because position pairing can cross the arms and make the aggregate meaningless.
  const unseeded = [...a, ...b].filter((m) => !m.seed);
  const method = unseeded.length > 0
    ? `by position (seed unrecoverable for ${unseeded.length} run(s))`
    : "by position";
  return { pairs, method, unseeded };
}

type MetricRow = {
  label: string;
  /** True when a known corpus baseline exists, so a delta is readable against history. */
  baseline: boolean;
  of: (m: RunMetrics) => number | null;
  format: (value: number | null) => string;
  /** Aggregate across runs (default: ratio of summed components). */
  aggOf?: (runs: RunMetrics[]) => number | null;
};

const METRIC_ROWS: MetricRow[] = [
  {
    label: "exile accuracy (by-removal)",
    baseline: true,
    of: (m) => (m.exilesByRemoval ? m.wolfExilesByRemoval / m.exilesByRemoval : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const w = runs.reduce((s, m) => s + m.wolfExilesByRemoval, 0);
      const e = runs.reduce((s, m) => s + m.exilesByRemoval, 0);
      return e ? w / e : null;
    },
  },
  {
    label: "chance rate",
    baseline: false,
    of: (m) => m.chanceRate,
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const withRate = runs.filter((m) => m.chanceRate !== null);
      return withRate.length ? mean(withRate.map((m) => m.chanceRate!)) : null;
    },
  },
  {
    label: "wolf bandwagon",
    baseline: true,
    of: (m) => (m.wolfExileVotes ? m.wolfBandwagonHits / m.wolfExileVotes : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const h = runs.reduce((s, m) => s + m.wolfBandwagonHits, 0);
      const v = runs.reduce((s, m) => s + m.wolfExileVotes, 0);
      return v ? h / v : null;
    },
  },
  {
    label: "contested share",
    baseline: false,
    of: (m) => (m.exileBallots ? m.contestedBallots / m.exileBallots : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const c = runs.reduce((s, m) => s + m.contestedBallots, 0);
      const b = runs.reduce((s, m) => s + m.exileBallots, 0);
      return b ? c / b : null;
    },
  },
  {
    label: "mean margin",
    baseline: false,
    of: (m) => m.meanMargin,
    format: (v) => (v === null ? "n/a" : v.toFixed(2)),
    aggOf: (runs) => {
      const w = runs.filter((m) => m.meanMargin !== null);
      return w.length ? mean(w.map((m) => m.meanMargin!)) : null;
    },
  },
  {
    label: "dissent vs declared target",
    baseline: false,
    of: (m) => (m.dissentDeclaredComparable ? m.dissentDeclared / m.dissentDeclaredComparable : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const d = runs.reduce((s, m) => s + m.dissentDeclared, 0);
      const c = runs.reduce((s, m) => s + m.dissentDeclaredComparable, 0);
      return c ? d / c : null;
    },
  },
  {
    label: "declaration coverage (final statements)",
    baseline: false,
    of: (m) => (m.finalStatements ? m.finalStatementsDeclared / m.finalStatements : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const d = runs.reduce((s, m) => s + m.finalStatementsDeclared, 0);
      const t = runs.reduce((s, m) => s + m.finalStatements, 0);
      return t ? d / t : null;
    },
  },
  {
    label: "dissent vs modal",
    baseline: false,
    of: (m) => (m.dissentModalComparable ? m.dissentModal / m.dissentModalComparable : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const d = runs.reduce((s, m) => s + m.dissentModal, 0);
      const c = runs.reduce((s, m) => s + m.dissentModalComparable, 0);
      return c ? d / c : null;
    },
  },
  { label: "town_hall_agreement", baseline: true, of: (m) => m.agree, format: (v) => String(v ?? "n/a"), aggOf: (runs) => runs.reduce((s, m) => s + m.agree, 0) },
  { label: "town_hall_pass", baseline: true, of: (m) => m.pass, format: (v) => String(v ?? "n/a"), aggOf: (runs) => runs.reduce((s, m) => s + m.pass, 0) },
  {
    label: "accusation-cued mention rate",
    baseline: false,
    of: (m) => (m.mentions ? m.cuedMentions / m.mentions : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const c = runs.reduce((s, m) => s + m.cuedMentions, 0);
      const t = runs.reduce((s, m) => s + m.mentions, 0);
      return t ? c / t : null;
    },
  },
  { label: "manipulation phrase hits", baseline: false, of: (m) => m.phraseHits, format: (v) => String(v ?? "n/a"), aggOf: (runs) => runs.reduce((s, m) => s + m.phraseHits, 0) },
  {
    label: "thought presence",
    baseline: false,
    of: (m) => (m.reasonedActions ? m.thoughts / m.reasonedActions : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const t = runs.reduce((s, m) => s + m.thoughts, 0);
      const a = runs.reduce((s, m) => s + m.reasonedActions, 0);
      return a ? t / a : null;
    },
  },
  {
    label: "thought mean length",
    baseline: false,
    of: (m) => (m.thoughtLengths.length ? mean(m.thoughtLengths) : null),
    format: (v) => (v === null ? "n/a" : v.toFixed(0)),
    aggOf: (runs) => {
      const all = runs.flatMap((m) => m.thoughtLengths);
      return all.length ? mean(all) : null;
    },
  },
  {
    label: "thought names a player",
    baseline: false,
    of: (m) => (m.thoughts ? m.thoughtsNamingPlayer / m.thoughts : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const n = runs.reduce((s, m) => s + m.thoughtsNamingPlayer, 0);
      const t = runs.reduce((s, m) => s + m.thoughts, 0);
      return t ? n / t : null;
    },
  },
  {
    label: "truncation rate",
    baseline: false,
    of: (m) => (m.speechVoices ? m.truncatedVoices / m.speechVoices : null),
    format: (v) => (v === null ? "n/a" : pct(v, 1)),
    aggOf: (runs) => {
      const t = runs.reduce((s, m) => s + m.truncatedVoices, 0);
      const v = runs.reduce((s, m) => s + m.speechVoices, 0);
      return v ? t / v : null;
    },
  },
  {
    label: "speech median length",
    baseline: false,
    of: (m) => (m.speechLengths.length ? median(m.speechLengths) : null),
    format: (v) => (v === null ? "n/a" : v.toFixed(0)),
    aggOf: (runs) => {
      const all = runs.flatMap((m) => m.speechLengths);
      return all.length ? median(all) : null;
    },
  },
];

function printComparison(dirA: string, dirB: string, runsA: RunMetrics[], runsB: RunMetrics[]): void {
  const { pairs, method, unseeded } = pairRuns(runsA, runsB);
  console.log(`TWO-ARM COMPARISON`);
  console.log(`  arm A: ${dirA}  (${runsA.length} runs)`);
  console.log(`  arm B: ${dirB}  (${runsB.length} runs)`);
  console.log(`  pairing: ${method}`);
  if (unseeded.length > 0) {
    console.log(
      `  WARNING: no recoverable seed for ${unseeded.length} run(s): ${unseeded.map((m) => m.id.slice(0, 8)).join(", ")}`,
    );
    console.log(
      "  The arms are paired BY SORTED POSITION instead of by seed, so a row may put two different",
    );
    console.log(
      "  seeds together; treat the paired deltas and the aggregate below as unpaired and weaker.",
    );
  }
  const shared = pairs.filter((pair) => pair.a && pair.b).length;
  if (method === "by seed" && shared === 0) {
    console.log("  WARNING: no seed appears in both arms — nothing paired across arms; the columns are disjoint.");
  } else if (method === "by seed") {
    console.log(`  paired across arms: ${shared}/${pairs.length}`);
  }
  console.log("");

  console.log("[baseline: yes] = a known corpus figure exists; [baseline: no] = fresh-arm-only, not comparable to history.");
  console.log("");
  for (const row of METRIC_ROWS) {
    console.log(`${row.label}   ${baselineTag(row.baseline)}`);
    console.log(`  ${"seed".padEnd(22)} ${"A".padStart(9)} ${"B".padStart(9)} ${"delta".padStart(10)}`);
    for (const pair of pairs) {
      const aVal = pair.a ? row.of(pair.a) : null;
      const bVal = pair.b ? row.of(pair.b) : null;
      const delta = aVal !== null && bVal !== null ? bVal - aVal : null;
      const sign = delta === null ? "" : delta >= 0 ? "+" : "";
      const label =
        pair.seed ??
        (pair.a && pair.b
          ? `${pair.a.id.slice(0, 8)}~${pair.b.id.slice(0, 8)}`
          : (pair.a ?? pair.b)!.id.slice(0, 8));
      const seedLabel = label.slice(0, 22);
      console.log(
        `  ${seedLabel.padEnd(22)} ${(aVal === null ? "-" : row.format(aVal)).padStart(9)} ${(bVal === null ? "-" : row.format(bVal)).padStart(9)} ${(delta === null ? "-" : `${sign}${row.format(delta)}`).padStart(10)}`,
      );
    }
    const aggFn = row.aggOf ?? (() => null);
    const aggA = aggFn(runsA);
    const aggB = aggFn(runsB);
    const aggDelta = aggA !== null && aggB !== null ? aggB - aggA : null;
    const sign = aggDelta === null ? "" : aggDelta >= 0 ? "+" : "";
    console.log(
      `  ${"AGGREGATE".padEnd(22)} ${(aggA === null ? "-" : row.format(aggA)).padStart(9)} ${(aggB === null ? "-" : row.format(aggB)).padStart(9)} ${(aggDelta === null ? "-" : `${sign}${row.format(aggDelta)}`).padStart(10)}`,
    );
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  let dataDir = DEFAULT_DATA_DIR;
  let compareA: string | null = null;
  let compareB: string | null = null;
  let filter: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dir") dataDir = resolve(argv[++i] ?? ".");
    else if (arg === "--compare") {
      compareA = resolve(argv[++i] ?? ".");
      compareB = resolve(argv[++i] ?? ".");
    } else if (!arg.startsWith("--")) filter = arg;
  }

  if (compareA && compareB) {
    const load = (dir: string): RunMetrics[] =>
      listRunDirs(dir)
        .map((id) => loadRun(join(dir, id), id))
        .filter((run): run is LoadedRun => run !== null && run.events.length > 0)
        .map(analyzeRun);
    console.log("play-metrics — two-arm comparison\n");
    printComparison(compareA, compareB, load(compareA), load(compareB));
    return;
  }

  const dirs = listRunDirs(dataDir).filter((id) => (filter ? id.startsWith(filter) : true));
  const loaded: LoadedRun[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of dirs) {
    const run = loadRun(join(dataDir, id), id);
    if (!run) skipped.push({ id, reason: "no input/config.json" });
    else if (run.events.length === 0) skipped.push({ id, reason: "no events.ndjson" });
    else loaded.push(run);
  }

  const metrics = loaded.map((run) => analyzeRun(run));
  const completed = loaded.filter((run) => run.roster);

  console.log("play-metrics — dev-only measurement over recorded runs");
  console.log(`corpus: ${dataDir}`);
  console.log(
    `runs: ${loaded.length} with events, ${completed.length} completed (roster present), ${skipped.length} skipped`,
  );
  console.log(`excluded: ${skipped.map((s) => `${s.id.slice(0, 8)} (${s.reason})`).join(", ") || "(none)"}`);
  const noBallot = loaded.filter(
    (run) => !run.events.some((event) => event.kind === "vote_cast"),
  );
  if (noBallot.length) {
    console.log(
      `note: ${noBallot.length} run(s) emit no vote_cast at all (older engine) — they contribute removals but no ballots: ${noBallot.map((run) => run.id.slice(0, 8)).join(", ")}`,
    );
  }
  console.log("");

  printDefinitions();

  console.log("PER RUN");
  for (let i = 0; i < loaded.length; i += 1) {
    printRun(loaded[i], metrics[i], Boolean(filter));
  }
  console.log("");

  const completedMetrics = metrics.filter((m) => m.completed);
  printAggregate("ALL RUNS WITH EVENTS", aggregate(metrics));
  printAggregate("COMPLETED RUNS ONLY (roster present)", aggregate(completedMetrics));

  printPhraseList(metrics);

  printCalibration([
    {
      label: "COMPLETED RUNS ONLY (roster present)",
      note: `run count: ${completedMetrics.length}`,
      agg: aggregate(completedMetrics),
    },
    {
      label: "ALL RUNS WITH EVENTS",
      note: `run count: ${metrics.length}`,
      agg: aggregate(metrics),
    },
  ]);
}

main();
