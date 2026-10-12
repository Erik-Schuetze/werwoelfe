#!/usr/bin/env node
/**
 * roleplay-review — an offline, deterministic reading instrument for a corpus of
 * recorded Werewolves runs.
 *
 * Where `play-metrics.mts` computes the acceptance-test numbers, this file is for
 * *reading* the runs: it writes a hand-review transcript per run and prints six
 * cross-run lenses (voices, drift, echo, register, frame detection, digest) that
 * make a qualitative claim about the roleplay countable.
 *
 * Two hard boundaries, both deliberate:
 *   - It imports NOTHING from the app. Plain `node:` builtins only, so it runs with
 *     no build step and no alias hook:
 *
 *       cd web && node --experimental-strip-types scripts/roleplay-review.mts \
 *         [--dir <corpus>] [--out <dir>] [--run <id-prefix>]
 *
 *     --dir defaults to ../../data/runs (the repo's data/runs); --out to ./review.
 *   - It is deterministic and free: no randomness, no network, no model calls.
 *
 * Robustness is a requirement, not a nicety: a run missing a file, a truncated
 * ndjson line, or an entirely absent corpus is a printed note, never a crash.
 *
 * Artifact layout of one run directory:
 *   input/config.json         { players: [{id,name,personality,temperature?}], model? }
 *   input/launch.json         { seed: "<decimal string>" }  (may be absent)
 *   output/events.ndjson      one JSON object per line, every line {schema_version:1,type,...}
 *   output/game-result.json   the engine's sanitized result (may be absent on failure)
 *   output/model-failures.ndjson  optional failure log
 */

import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types. Plain `type` declarations only — this file is run through
// `--experimental-strip-types`, so no enum / namespace / parameter properties.
// ---------------------------------------------------------------------------

type PlayerConfig = { id: string; name: string; personality?: string; temperature?: number };
type RunConfig = { players: PlayerConfig[]; model?: Record<string, unknown> };

/** One on-disk ndjson payload. The engine writes snake_case (`player_id`,
 *  `revealed_role`); the running app normalises to camelCase at ingest. Read both. */
type RawEvent = {
  sequence?: number;
  at?: string;
  kind?: string;
  visibility?: string;
  recipients?: string[];
  player_id?: string | null;
  playerId?: string | null;
  revealed_role?: string | null;
  revealedRole?: string | null;
  message?: string;
};

type RawResultPlayer = { id: string; name?: string; role?: string | null; alive?: boolean | null };
type RawResult = {
  seed?: string | number | null;
  winner?: string | null;
  title?: string | null;
  players?: RawResultPlayer[];
};

/** Normalised, in-memory event. */
type Event = {
  sequence: number;
  kind: string;
  visibility: "public" | "private";
  recipients: string[];
  playerId: string | null;
  revealedRole: string | null;
  message: string;
};

type Utterance = {
  seq: number;
  kind: string;
  speakerId: string;
  speakerName: string;
  body: string;
};

type LoadedRun = {
  id: string;
  dir: string;
  players: PlayerConfig[];
  nameToId: Map<string, string>;
  idToName: Map<string, string>;
  namesByLength: string[];
  events: Event[];
  /** Final roles: the sanitized roster, else roles rebuilt from `player_removed`. */
  roles: Map<string, string>;
  alive: Map<string, boolean>;
  seed: string | null;
  winner: string | null;
  title: string | null;
  /** null = the failure log file is absent; a number = its non-empty line count. */
  modelFailures: number | null;
  notes: string[];
};

type LoadOutcome = { ok: true; run: LoadedRun } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Fixed vocabularies and regexes (metric definitions live beside them).
// ---------------------------------------------------------------------------

/**
 * Function words for the style profile (section 2/3). Function words carry style
 * rather than topic, which is exactly why authorship attribution uses them: two
 * players talking about the same accusation still differ in how often they reach
 * for "the", "but", "though", "well". A fixed list, not a derived one, so two runs
 * are always compared on the same axes.
 */
const FUNCTION_WORDS: string[] = [
  "a", "about", "above", "across", "after", "again", "against", "all", "almost", "already",
  "also", "although", "always", "am", "among", "an", "and", "any", "anyone", "anything",
  "are", "around", "as", "at", "away", "back", "be", "because", "been", "before",
  "behind", "being", "below", "between", "beyond", "both", "but", "by", "can", "could",
  "did", "do", "does", "doing", "done", "down", "during", "each", "either", "enough",
  "even", "ever", "every", "everyone", "everything", "far", "few", "for", "from", "had",
  "has", "have", "having", "he", "her", "here", "hers", "herself", "him", "himself",
  "his", "how", "however", "i", "if", "in", "into", "is", "it", "its", "itself",
  "just", "less", "like", "little", "many", "may", "me", "might", "mine", "more",
  "most", "much", "must", "my", "myself", "near", "neither", "never", "no", "nobody",
  "nor", "not", "nothing", "now", "of", "off", "often", "on", "once", "one",
  "only", "or", "other", "others", "our", "ours", "ourselves", "out", "over", "own",
  "perhaps", "rather", "really", "same", "she", "should", "since", "so", "some", "someone",
  "something", "still", "such", "than", "that", "the", "their", "theirs", "them", "themselves",
  "then", "there", "therefore", "these", "they", "this", "those", "though", "through", "thus",
  "to", "too", "toward", "under", "until", "up", "upon", "us", "very", "was",
  "we", "well", "were", "what", "when", "where", "whether", "which", "while", "who",
  "whom", "whose", "why", "will", "with", "within", "without", "would", "yet", "you",
  "your", "yours", "yourself", "yourselves",
];

/** Kinds whose `message` is a player's own public utterance (a speech or intro). */
const SPEECH_KINDS = new Set(["town_hall_message", "player_introduced"]);

/** Phase / scene markers. Rendered as dividers in the reading sheet, not as speech. */
const PHASE_KINDS = new Set([
  "game_started", "night_started", "dawn_started", "discussion_started", "discussion_round_started",
  "introductions_started", "introductions_completed", "sheriff_election_started", "final_statements_started",
  "exile_vote_started", "werewolf_meal_started", "werewolf_planning_started", "werewolf_planning_round_started",
  "game_finished",
]);

/** Focal / AI-favoured vocabulary (section 5). Matched as tolerant stems, word-bounded. */
const FOCAL_STEMS =
  /\b(?:delv\w*|testament\w*|tapestr\w*|realm\w*|pivotal\w*|intricat\w*|meticulous\w*|leverag\w*|robust\w*|seamless\w*|myriad\w*|holistic\w*|underscor\w*)\b/gi;
/** Focal phrases, matched as case-insensitive substrings (not word-bounded, they are phrases). */
const FOCAL_PHRASES = ["it is worth noting", "worth noting", "speaks to", "stands as"];

/** "not just X but Y" family — tolerant of "isn't just", "it's not X, it's Y". */
const RE_NOT_JUST = /\bnot\s+just\b[^.!?]*\bbut\b/gi;
const RE_ISNT_JUST = /\b(?:is|are|was|were|isn't|aren't|wasn't|'s)\s+just\b/gi;
const RE_NOT_X_IT_Y = /\b(?:it|this|that|there)\s+(?:is|was|'s)?\s*not\b[^.!?]*,\s*(?:it|this|that)\s+(?:is|was|'s)\b/gi;

/** Hedging. Exact tokens from the brief, with tolerant inflections for seem/appear. */
const RE_HEDGE = /\b(?:perhaps|arguably|seem(?:s|ed)?|appear(?:s|ed)?)\b/gi;
const HEDGE_PHRASES = ["it is possible", "one could"];

/** Frame-naming phrases the accused might use when calling out a set-up (section 6). */
const FRAME_PHRASES = [
  "set me up", "setting me up", "frame me", "framed", "frame job", "planted",
  "what they wanted", "wanted this", "wanted me gone", "the play",
  "playing you", "playing me", "deflect", "deflection",
  "turn it on me", "turning it on me", "turned it on me", "turn this on me",
];

/**
 * Accusatory cue for the accusation detector (section 6). Deliberately a HIGH bar: a bare
 * mention of "wolf" in a hypothetical ("if Otto flips wolf, look at who he shielded — Ivo")
 * is not an accusation, so the bare noun is excluded and "wolf" only counts when directly
 * predicated ("X is a wolf"). Vote/no-confidence statements and the sharp verbs carry the
 * rest. This is a heuristic, and the section prints numerator and denominator so the reader
 * can judge the bar; it will still miss a purely implicit suspicion.
 */
const RE_ACCUSE_CUE =
  /(?:\b(?:vote|voting|ballot|no\s+confidence|suspect\w*|accus\w*|distrust\w*|don'?t\s+trust|do\s+not\s+trust|deceiv\w*|manipulat\w*|deflect\w*|lying|lied|liar|guilty|suspicious|threw|throwing|thrown)\b|\bis\s+(?:a\s+|the\s+)?(?:wolf|werewolf)\b|\bare\s+(?:the\s+)?(?:wolves|werewolves)\b)/i;
/** Second-person accusation: "you" plus a sharp token, or "you're a wolf". */
const RE_SECOND_PERSON = /\byou(?:'re|\s+are|\s+were)?\b/i;
const RE_SECOND_PERSON_CUE =
  /(?:\b(?:deceiv\w*|manipulat\w*|lying|lied|liar|deflect\w*|threw|throwing|thrown|set\s+me\s+up|framed)\b|\byou(?:'re|\s+are|\s+were)\s+(?:a\s+|the\s+)?(?:wolf|werewolf)\b)/i;

/** Leadership-flavoured persona markers, for the digest's "was a leader exiled?". */
const RE_LEADERSHIP =
  /\b(?:lead|leads|leader|leading|command|commanding|authorit\w*|boss|chief|captain|decisive|dominant|dominat\w*|confident|assertive|in\s+charge|take\s+charge|marshal|sheriff|mayor|foreman)\b/i;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function ratio(numerator: number, denominator: number): string {
  if (!denominator) return `${numerator}/${denominator} (n/a)`;
  return `${numerator}/${denominator} (${pct(numerator / denominator)})`;
}

function fixed(x: number, digits: number): string {
  return Number.isFinite(x) ? x.toFixed(digits) : "n/a";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clip(text: string, max = 140): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function countMatches(text: string, re: RegExp): number {
  const global = re.global ? re : new RegExp(re.source, `${re.flags}g`);
  global.lastIndex = 0;
  let n = 0;
  while (global.exec(text) !== null) {
    n += 1;
    if (n > 100000) break; // pathological guard; never expected
  }
  return n;
}

function countSubstrings(text: string, needles: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const needle of needles) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      n += 1;
      from = at + needle.length;
    }
  }
  return n;
}

/** Lowercase alphabetic-word tokens. Splitting every non-letter run means "it's" -> it, s,
 *  so the frequency of the function word "it" is still counted. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z]+/g) ?? [];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const DEFAULT_DIR = resolve(import.meta.dirname, "..", "..", "data", "runs");

function listRunDirs(dir: string): { dirs: string[]; error: string | null } {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    return { dirs: [], error: `cannot read corpus directory ${dir} (${(err as Error).message})` };
  }
  const dirs = names
    .filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  return { dirs, error: null };
}

/** Read a file line by line (streaming) so a few-hundred-KB event stream is never
 *  slurped whole. A missing file rejects, which the caller turns into a note. */
async function readLines(filePath: string, onLine: (line: string) => void): Promise<void> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) onLine(line);
  } finally {
    rl.close();
  }
}

function readText(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Uint64 seed, read as text so JSON.parse's float64 rounding cannot lose low digits. */
function extractSeed(text: string): string | null {
  const match = /"seed"\s*:\s*"?(\d+)"?/.exec(text);
  return match ? match[1] : null;
}

function normalizeEvent(raw: RawEvent, fallbackSeq: number): Event {
  return {
    sequence: typeof raw.sequence === "number" ? raw.sequence : fallbackSeq,
    kind: typeof raw.kind === "string" ? raw.kind : "unknown",
    visibility: raw.visibility === "private" ? "private" : "public",
    recipients: Array.isArray(raw.recipients) ? raw.recipients : [],
    playerId: raw.player_id ?? raw.playerId ?? null,
    revealedRole: raw.revealed_role ?? raw.revealedRole ?? null,
    message: typeof raw.message === "string" ? raw.message : "",
  };
}

async function loadRun(dir: string, id: string): Promise<LoadOutcome> {
  const notes: string[] = [];

  const configText = readText(join(dir, "input", "config.json"));
  if (configText === null) return { ok: false, reason: "no input/config.json" };
  let config: RunConfig;
  try {
    config = JSON.parse(configText) as RunConfig;
  } catch (err) {
    return { ok: false, reason: `input/config.json is not valid JSON (${(err as Error).message})` };
  }
  if (!config || !Array.isArray(config.players) || config.players.length === 0) {
    return { ok: false, reason: "input/config.json has no players" };
  }

  const players: PlayerConfig[] = config.players.map((p) => ({
    id: String(p.id),
    name: String(p.name),
    personality: typeof p.personality === "string" ? p.personality : "",
    temperature: typeof p.temperature === "number" ? p.temperature : undefined,
  }));
  const nameToId = new Map<string, string>();
  const idToName = new Map<string, string>();
  for (const p of players) {
    nameToId.set(p.name, p.id);
    idToName.set(p.id, p.name);
  }
  const namesByLength = [...nameToId.keys()].sort((a, b) => b.length - a.length);

  // -- events.ndjson, line by line -----------------------------------------
  const events: Event[] = [];
  let malformed = 0;
  let result: RawResult | null = null;
  let eventsRead = true;
  try {
    await readLines(join(dir, "output", "events.ndjson"), (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let record: { type?: string; event?: RawEvent; result?: RawResult };
      try {
        record = JSON.parse(trimmed) as typeof record;
      } catch {
        malformed += 1;
        return;
      }
      if (record.type === "event" && record.event) {
        events.push(normalizeEvent(record.event, events.length + 1));
      } else if (record.type === "result" && record.result) {
        result = record.result;
      }
      // other line types (e.g. `failure`) are ignored for metrics
    });
  } catch {
    eventsRead = false;
  }
  if (!eventsRead && events.length === 0) {
    return { ok: false, reason: "no readable output/events.ndjson" };
  }
  if (malformed > 0) notes.push(`${malformed} malformed ndjson line(s) ignored`);

  // -- game-result.json (preferred over the stream's result line) -----------
  const resultText = readText(join(dir, "output", "game-result.json"));
  if (resultText !== null) {
    try {
      result = JSON.parse(resultText) as RawResult;
    } catch {
      notes.push("output/game-result.json is not valid JSON; falling back to the event stream");
    }
  }

  // -- roles: roster, else derived from player_removed ----------------------
  const roles = new Map<string, string>();
  const alive = new Map<string, boolean>();
  if (result?.players?.length) {
    for (const rp of result.players) {
      if (rp.role) roles.set(String(rp.id), String(rp.role));
      if (typeof rp.alive === "boolean") alive.set(String(rp.id), rp.alive);
    }
  } else {
    notes.push("no usable result roster; roles derived from player_removed events");
  }
  for (const ev of events) {
    if (ev.kind === "player_removed" && ev.playerId) {
      if (ev.revealedRole && !roles.has(ev.playerId)) roles.set(ev.playerId, ev.revealedRole);
      alive.set(ev.playerId, false);
    }
  }
  for (const p of players) if (!alive.has(p.id)) alive.set(p.id, true);

  // -- seed ---------------------------------------------------------------
  const launchText = readText(join(dir, "input", "launch.json"));
  let seed = launchText ? extractSeed(launchText) : null;
  if (!seed && resultText) seed = extractSeed(resultText);
  if (!seed) seed = extractSeed(configText);

  // -- model failures -----------------------------------------------------
  const failureText = readText(join(dir, "output", "model-failures.ndjson"));
  const modelFailures = failureText === null
    ? null
    : failureText.split("\n").filter((line) => line.trim().length > 0).length;

  events.sort((a, b) => a.sequence - b.sequence);

  return {
    ok: true,
    run: {
      id,
      dir,
      players,
      nameToId,
      idToName,
      namesByLength,
      events,
      roles,
      alive,
      seed,
      winner: result?.winner ? String(result.winner) : null,
      title: result?.title ? String(result.title) : null,
      modelFailures,
      notes,
    },
  };
}

/** The speaker of a `"<Name>: <text>"` message, or null if it carries no name prefix. */
function speakerOf(message: string, run: LoadedRun): { speakerId: string; speakerName: string; body: string } | null {
  for (const name of run.namesByLength) {
    if (message.startsWith(`${name}: `)) {
      const id = run.nameToId.get(name);
      if (id) return { speakerId: id, speakerName: name, body: message.slice(name.length + 2) };
    }
  }
  return null;
}

function nameOf(run: LoadedRun, id: string): string {
  return run.idToName.get(id) ?? id;
}

/**
 * `vote_cast` messages read "<Voter> votes for <Target>." — a space, not the ": " that
 * `speakerOf` needs, so they need their own parse. The voter is the longest configured name
 * that prefixes "<name> votes for ", and the target is whatever follows. Returns null if the
 * message is not a vote cast (e.g. a tallied line or a narration event).
 */
function parseVote(message: string, run: LoadedRun): { voterId: string; targetId: string | null } | null {
  const marker = " votes for ";
  for (const name of run.namesByLength) {
    if (!message.startsWith(name + marker)) continue;
    const voterId = run.nameToId.get(name);
    if (!voterId) continue;
    const raw = message.slice(name.length + marker.length).trim().replace(/\.$/, "");
    return { voterId, targetId: run.nameToId.get(raw) ?? null };
  }
  return null;
}

/**
 * `final_declaration` messages read, in the three shapes the engine words them:
 *   "<Speaker> will vote for <Target>: <reason>."
 *   "<Speaker> will vote for <Target>."
 *   "<Speaker> declares: <reason>."
 *
 * The first two name the speaker before " will vote for ", not before a colon, so
 * `speakerOf` (which needs "<Name>: ") cannot read them — it would hand back null
 * and the declaration would render as an anonymous narration line. The third has
 * a colon, but after " declares", so it fails there too. `targetName` is null for
 * the bare "declares" form; `reason` is empty when a target was named alone.
 */
function parseDeclaration(
  message: string,
  run: LoadedRun,
): { speakerName: string; targetName: string | null; reason: string } | null {
  const vote = /^(.+?) will vote for (.+?)(?:: (.*))?\.$/.exec(message);
  if (vote) return resolveDeclaration(run, vote[1], vote[2], vote[3] ?? "");
  const declares = /^(.+?) declares: (.*)\.$/.exec(message);
  if (declares) return resolveDeclaration(run, declares[1], null, declares[2]);
  return null;
}

/**
 * Resolves a parsed declaration against the roster with the same strictness
 * `speakerOf` applies: a speaker who is not a known player yields null, so a
 * mis-shaped message falls through to the narration line rather than inventing an
 * attribution. The target is named as the config spells it when it is a player.
 */
function resolveDeclaration(
  run: LoadedRun,
  rawSpeaker: string,
  rawTarget: string | null,
  rawReason: string,
): { speakerName: string; targetName: string | null; reason: string } | null {
  const speakerId = run.nameToId.get(rawSpeaker.trim());
  if (!speakerId) return null;
  let targetName: string | null = null;
  if (rawTarget !== null) {
    const trimmed = rawTarget.trim();
    const targetId = run.nameToId.get(trimmed);
    targetName = targetId ? nameOf(run, targetId) : trimmed;
  }
  return { speakerName: nameOf(run, speakerId), targetName, reason: rawReason.trim() };
}

/** Public speeches and introductions, in order — the utterances sections 2-6 read. */
function publicUtterances(run: LoadedRun): Utterance[] {
  const out: Utterance[] = [];
  for (const ev of run.events) {
    if (ev.visibility !== "public" || !SPEECH_KINDS.has(ev.kind)) continue;
    const u = speakerOf(ev.message, run);
    if (!u) continue;
    const body = u.body.trim();
    if (!body) continue;
    out.push({ seq: ev.sequence, kind: ev.kind, speakerId: u.speakerId, speakerName: u.speakerName, body });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section 1 — reading sheet
// ---------------------------------------------------------------------------

function renderTranscript(run: LoadedRun): string[] {
  const lines: string[] = [];
  for (const ev of run.events) {
    if (ev.visibility === "private") {
      const u = speakerOf(ev.message, run);
      if (u) lines.push(`> [private] ${u.speakerName}: ${u.body}`);
      else lines.push(`> [private] (${ev.kind}) ${ev.message}`);
      continue;
    }
    if (ev.kind === "final_declaration") {
      // A commitment with a named target, not a line of speech: marked with "»"
      // so it reads as its own turn in the sheet, and parsed rather than dumped
      // as an anonymous narration line (see `parseDeclaration`).
      const decl = parseDeclaration(ev.message, run);
      if (decl) {
        const commitment = decl.targetName
          ? `will vote for ${decl.targetName}${decl.reason ? `: ${decl.reason}` : ""}`
          : `declares${decl.reason ? `: ${decl.reason}` : ""}`;
        lines.push(`» ${decl.speakerName} ${commitment}.`);
        continue;
      }
    }
    if (SPEECH_KINDS.has(ev.kind) || ev.kind === "town_hall_agreement") {
      const u = speakerOf(ev.message, run);
      if (u) {
        lines.push(`${u.speakerName}: ${u.body}`);
        continue;
      }
    }
    if (PHASE_KINDS.has(ev.kind)) {
      lines.push("");
      lines.push(`— ${ev.message}`);
      continue;
    }
    lines.push(`· ${ev.message}`);
  }
  return lines;
}

function writeReadingSheet(run: LoadedRun, outDir: string): { path: string; thoughts: number; speeches: number } {
  const speeches = publicUtterances(run);
  const thoughts = run.events.filter((ev) => ev.kind === "player_thought").length;
  // Final declarations are turns of their own — counted here so their absence is
  // as visible as a thin sheet's missing thoughts, without folding their short,
  // formulaic text into the style lenses that read `speeches`.
  const declarations = run.events.filter((ev) => ev.kind === "final_declaration").length;

  const head: string[] = [];
  head.push(`# ${run.title ? `${run.title} — ` : ""}${run.id}`);
  head.push("");
  head.push(`- run: \`${run.id}\``);
  head.push(`- title: ${run.title ?? "(none)"}`);
  head.push(`- seed: ${run.seed ?? "?"}`);
  head.push(`- players: ${run.players.length}`);
  head.push(`- outcome: ${run.winner ?? "(no result — run did not finish)"}`);
  head.push(`- model failures: ${run.modelFailures === null ? "(no log)" : run.modelFailures}`);
  head.push(
    `- private thoughts: ${thoughts}   public speeches/introductions: ${speeches.length}   final declarations: ${declarations}`,
  );
  for (const note of run.notes) head.push(`- note: ${note}`);
  head.push("");
  if (thoughts === 0) {
    head.push(
      "> **WARNING: this run has ZERO `player_thought` events. The private-reasoning layer is",
    );
    head.push(
      "> missing, so this sheet is a thin public-only record. Read it as such — do not treat",
    );
    head.push("> the absence of private text as players having no reasons.**");
    head.push("");
  }
  head.push("## Cast");
  head.push("");
  for (const p of run.players) {
    const role = run.roles.get(p.id) ?? "unknown";
    const persona = (p.personality ?? "").trim() || "(blank persona)";
    head.push(`- **${p.name}** (\`${p.id}\`) — role: ${role} — persona: ${persona}`);
  }
  head.push("");
  head.push("## Transcript");
  head.push("");
  head.push("Public speech reads `Name: text`. Private reasoning reads `> [private] Name: text`.");
  head.push("A final declaration reads `» Name will vote for Target: reason` (the commitment the");
  head.push("engine emits as `final_declaration`, in place of the old mandatory final speech).");
  head.push("Engine narration reads `· ...`; phase markers read `— ...`.");

  const body = [...head, ...renderTranscript(run)];
  const path = join(outDir, `${run.id}.md`);
  writeFileSync(path, `${body.join("\n")}\n`, "utf8");
  return { path, thoughts, speeches: speeches.length };
}

// ---------------------------------------------------------------------------
// Section 2/3 — style profiles (Burrows' Delta, z-scores, drift)
// ---------------------------------------------------------------------------

type VoiceModel = {
  wordIndex: Map<string, number>;
  wordCount: number;
  mean: number[];
  sd: number[];
  /** playerId -> per-word counts, total tokens, and z-scored profile (full-data). */
  profiles: Map<string, { counts: number[]; total: number; z: number[] }>;
  /** playerId -> their utterances' own z-vectors (for leave-one-out). */
  utteranceZ: Map<string, { counts: number[]; total: number; z: number[] }[]>;
  classes: string[];
};

/**
 * Burrows' Delta between two profiles: the mean absolute difference of their per-word
 * z-scores (a z-score is (frequency - pooled mean) / pooled SD over the run's players).
 * It is a Manhattan distance on the style axes, so 0.0 = indistinguishable and higher =
 * further apart. CAVEAT, stated in the output too: Burrows' Delta is documented as
 * reliable only above ~1,500 words per author. These players speak a few hundred words
 * each, well below that, so a low identification accuracy here is a warning sign, not
 * proof of anything.
 */
function delta(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / n;
}

function zScore(counts: number[], total: number, mean: number[], sd: number[]): number[] {
  const out = new Array<number>(counts.length);
  for (let i = 0; i < counts.length; i += 1) {
    const freq = total > 0 ? counts[i] / total : 0;
    out[i] = sd[i] > 0 ? (freq - mean[i]) / sd[i] : 0;
  }
  return out;
}

function buildVoiceModel(run: LoadedRun, utterances: Utterance[]): VoiceModel {
  const wordIndex = new Map<string, number>();
  FUNCTION_WORDS.forEach((w, i) => wordIndex.set(w, i));
  const wordCount = FUNCTION_WORDS.length;

  const profiles = new Map<string, { counts: number[]; total: number; z: number[] }>();
  const utteranceZ = new Map<string, { counts: number[]; total: number; z: number[] }[]>();
  for (const p of run.players) {
    profiles.set(p.id, { counts: new Array(wordCount).fill(0), total: 0, z: [] });
    utteranceZ.set(p.id, []);
  }

  // Aggregate counts per player, and per-utterance counts, over the same words.
  for (const utt of utterances) {
    const profile = profiles.get(utt.speakerId);
    if (!profile) continue;
    const uCounts = new Array<number>(wordCount).fill(0);
    let uTotal = 0;
    for (const token of tokenize(utt.body)) {
      const idx = wordIndex.get(token);
      if (idx === undefined) continue;
      uCounts[idx] += 1;
      uTotal += 1;
      profile.counts[idx] += 1;
      profile.total += 1;
    }
    if (uTotal > 0) utteranceZ.get(utt.speakerId)!.push({ counts: uCounts, total: uTotal, z: [] });
  }

  // Pooled mean/SD per word across players who actually speak.
  const active = [...profiles.entries()].filter(([, p]) => p.total > 0);
  const mean = new Array<number>(wordCount).fill(0);
  const sd = new Array<number>(wordCount).fill(0);
  for (let w = 0; w < wordCount; w += 1) {
    const freqs = active.map(([, p]) => p.counts[w] / p.total);
    const m = freqs.reduce((a, b) => a + b, 0) / (freqs.length || 1);
    mean[w] = m;
    if (freqs.length > 1) {
      const variance = freqs.reduce((a, b) => a + (b - m) ** 2, 0) / freqs.length;
      sd[w] = Math.sqrt(variance);
    }
  }

  for (const [, p] of profiles) {
    if (p.total > 0) p.z = zScore(p.counts, p.total, mean, sd);
  }
  for (const list of utteranceZ.values()) {
    for (const u of list) u.z = zScore(u.counts, u.total, mean, sd);
  }

  return { wordIndex, wordCount, mean, sd, profiles, utteranceZ, classes: active.map(([id]) => id) };
}

type VoiceResult = {
  classes: number;
  accuracy: number | null;
  correct: number;
  scored: number;
  chance: number;
  pairs: { a: string; b: string; delta: number }[];
  meanPairwiseDelta: number | null;
};

function analyzeVoices(run: LoadedRun, model: VoiceModel): VoiceResult {
  const classes = model.classes;
  const chance = classes.length ? 1 / classes.length : 0;

  // Leave-one-utterance-out nearest-centroid identification: score an utterance against
  // every player's profile, but rebuild the true speaker's profile without that utterance
  // (its own words must not help score it).
  let correct = 0;
  let scored = 0;
  for (const speakerId of classes) {
    const speakerProfile = model.profiles.get(speakerId)!;
    for (const u of model.utteranceZ.get(speakerId)!) {
      const reducedTotal = speakerProfile.total - u.total;
      const reducedCounts = speakerProfile.counts.map((c, i) => c - u.counts[i]);
      const reducedZ = reducedTotal > 0 ? zScore(reducedCounts, reducedTotal, model.mean, model.sd) : null;

      let bestId: string | null = null;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const candidateId of classes) {
        const centroid = candidateId === speakerId
          ? reducedZ
          : model.profiles.get(candidateId)!.z;
        if (!centroid) continue; // the speaker had no other words — unscoreable
        const d = delta(u.z, centroid);
        if (d < bestDelta) {
          bestDelta = d;
          bestId = candidateId;
        }
      }
      scored += 1;
      if (bestId === speakerId) correct += 1;
    }
  }

  // Pairwise Delta between different players; the lowest are the most-confused pairs.
  const pairs: { a: string; b: string; delta: number }[] = [];
  for (let i = 0; i < classes.length; i += 1) {
    for (let j = i + 1; j < classes.length; j += 1) {
      const a = model.profiles.get(classes[i])!.z;
      const b = model.profiles.get(classes[j])!.z;
      pairs.push({ a: classes[i], b: classes[j], delta: delta(a, b) });
    }
  }
  pairs.sort((x, y) => x.delta - y.delta);
  const meanPairwiseDelta = pairs.length
    ? pairs.reduce((s, p) => s + p.delta, 0) / pairs.length
    : null;

  return {
    classes: classes.length,
    accuracy: scored ? correct / scored : null,
    correct,
    scored,
    chance,
    pairs,
    meanPairwiseDelta,
  };
}

type DriftResult = {
  perPlayer: { id: string; delta: number | null; normalized: number | null }[];
  meanNormalized: number | null;
  worst: { id: string; normalized: number } | null;
};

/**
 * Drift: does a player's voice hold all game? Split that player's public utterances in
 * half by position, take the Delta between the centroid of the first half and the second.
 * A raw Delta is hard to read, so it is NORMALISED by the run's mean Delta between
 * different players: the result is in "player-distances", where 1.0 means the player's
 * voice moved exactly as far across the game as one player differs from another. Below
 * 1.0 the voice is stable relative to the table; well above it, the player is drifting.
 */
function analyzeDrift(run: LoadedRun, model: VoiceModel, utterances: Utterance[], normalizer: number | null): DriftResult {
  const byPlayer = new Map<string, Utterance[]>();
  for (const u of utterances) {
    if (!byPlayer.has(u.speakerId)) byPlayer.set(u.speakerId, []);
    byPlayer.get(u.speakerId)!.push(u);
  }

  const perPlayer: { id: string; delta: number | null; normalized: number | null }[] = [];
  for (const p of run.players) {
    const list = byPlayer.get(p.id) ?? [];
    if (list.length < 2) {
      perPlayer.push({ id: p.id, delta: null, normalized: null });
      continue;
    }
    const splitAt = Math.ceil(list.length / 2);
    const firstHalf = list.slice(0, splitAt);
    const secondHalf = list.slice(splitAt);

    const centroidOf = (half: Utterance[]): number[] | null => {
      const counts = new Array<number>(model.wordCount).fill(0);
      let total = 0;
      for (const u of half) {
        for (const token of tokenize(u.body)) {
          const idx = model.wordIndex.get(token);
          if (idx === undefined) continue;
          counts[idx] += 1;
          total += 1;
        }
      }
      return total > 0 ? zScore(counts, total, model.mean, model.sd) : null;
    };

    const a = centroidOf(firstHalf);
    const b = centroidOf(secondHalf);
    if (!a || !b) {
      perPlayer.push({ id: p.id, delta: null, normalized: null });
      continue;
    }
    const d = delta(a, b);
    const normalized = normalizer && normalizer > 0 ? d / normalizer : null;
    perPlayer.push({ id: p.id, delta: d, normalized });
  }

  const normalizedValues = perPlayer
    .map((p) => p.normalized)
    .filter((v): v is number => v !== null);
  const meanNormalized = normalizedValues.length
    ? normalizedValues.reduce((a, b) => a + b, 0) / normalizedValues.length
    : null;
  let worst: { id: string; normalized: number } | null = null;
  for (const p of perPlayer) {
    if (p.normalized === null) continue;
    if (!worst || p.normalized > worst.normalized) worst = { id: p.id, normalized: p.normalized };
  }

  return { perPlayer, meanNormalized, worst };
}

// ---------------------------------------------------------------------------
// Section 4 — echo (4-gram restatement)
// ---------------------------------------------------------------------------

function fourGrams(text: string): Set<string> {
  const tokens = tokenize(text);
  const grams = new Set<string>();
  for (let i = 0; i + 4 <= tokens.length; i += 1) {
    grams.add(tokens.slice(i, i + 4).join(" "));
  }
  return grams;
}

type EchoResult = {
  mean: number | null;
  max: number | null;
  scored: number;
  skipped: number;
  worst: { later: Utterance; earlier: Utterance; overlap: number; phrase: string } | null;
};

/**
 * Echo: for each public speech, the maximum 4-gram overlap against any EARLIER public
 * speech by a DIFFERENT player. Overlap = (shared 4-grams) / (this speech's own 4-grams)
 * — a containment measure, so it reads as "this much of what I just said is a repeat of
 * what they said". High values are the "eight bots restating the same case" failure.
 */
function analyzeEcho(utterances: Utterance[]): EchoResult {
  const gramSets = utterances.map((u) => fourGrams(u.body));
  const overlaps: number[] = [];
  let max = -1;
  let worst: EchoResult["worst"] = null;
  let scored = 0;
  let skipped = 0;

  for (let i = 0; i < utterances.length; i += 1) {
    const mine = gramSets[i];
    if (mine.size === 0) {
      skipped += 1;
      continue;
    }
    let best = -1;
    let bestJ = -1;
    for (let j = 0; j < i; j += 1) {
      if (utterances[j].speakerId === utterances[i].speakerId) continue;
      let shared = 0;
      for (const gram of mine) if (gramSets[j].has(gram)) shared += 1;
      const overlap = shared / mine.size;
      if (overlap > best) {
        best = overlap;
        bestJ = j;
      }
    }
    if (bestJ < 0) {
      // no earlier different-speaker speech to compare against
      scored += 1;
      overlaps.push(0);
      continue;
    }
    scored += 1;
    overlaps.push(best);
    if (best > max) {
      max = best;
      let phrase = "";
      for (const gram of mine) {
        if (gramSets[bestJ].has(gram)) {
          phrase = gram;
          break;
        }
      }
      worst = { later: utterances[i], earlier: utterances[bestJ], overlap: best, phrase };
    }
  }

  return {
    mean: overlaps.length ? overlaps.reduce((a, b) => a + b, 0) / overlaps.length : null,
    max: max < 0 ? null : max,
    scored,
    skipped,
    worst,
  };
}

// ---------------------------------------------------------------------------
// Section 5 — register / slop density (a lens, not a verdict)
// ---------------------------------------------------------------------------

type RegisterCounts = {
  chars: number;
  emDash: number;
  construction: number;
  focal: number;
  ingPad: number;
  hedge: number;
};

/**
 * -ing tail-padding: a comma or dash immediately followed by a present participle
 * ("..., enabling the village to..."). Clause-aware: split the sentence at commas,
 * semicolons and dashes; a non-initial clause that OPENS with an -ing word is the
 * padding shape. This is the tail participial that pads a finished thought.
 */
function ingPaddingCount(text: string): number {
  let count = 0;
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const clauses = sentence.split(/\s*[,;—]\s*|\s+--\s+/);
    for (let i = 1; i < clauses.length; i += 1) {
      const first = (clauses[i].trim().split(/\s+/)[0] ?? "");
      if (/^[a-z]+ing\b/i.test(first)) count += 1;
    }
  }
  return count;
}

function registerCounts(text: string): RegisterCounts {
  return {
    chars: text.length,
    emDash: countMatches(text, /—/g) + countMatches(text, /\s--\s/g),
    construction:
      countMatches(text, RE_NOT_JUST) +
      countMatches(text, RE_ISNT_JUST) +
      countMatches(text, RE_NOT_X_IT_Y),
    focal: countMatches(text, FOCAL_STEMS) + countSubstrings(text, FOCAL_PHRASES),
    ingPad: ingPaddingCount(text),
    hedge: countMatches(text, RE_HEDGE) + countSubstrings(text, HEDGE_PHRASES),
  };
}

function addCounts(a: RegisterCounts, b: RegisterCounts): RegisterCounts {
  return {
    chars: a.chars + b.chars,
    emDash: a.emDash + b.emDash,
    construction: a.construction + b.construction,
    focal: a.focal + b.focal,
    ingPad: a.ingPad + b.ingPad,
    hedge: a.hedge + b.hedge,
  };
}

const EMPTY_COUNTS: RegisterCounts = { chars: 0, emDash: 0, construction: 0, focal: 0, ingPad: 0, hedge: 0 };

function density(count: number, chars: number): number {
  return chars > 0 ? (count / chars) * 1000 : 0;
}

function totalMarks(c: RegisterCounts): number {
  return c.emDash + c.construction + c.focal + c.ingPad + c.hedge;
}

type RegisterResult = {
  run: RegisterCounts;
  perPlayer: { id: string; counts: RegisterCounts }[];
  worstMessages: { utter: Utterance; counts: RegisterCounts; dens: number }[];
};

function analyzeRegister(run: LoadedRun, utterances: Utterance[]): RegisterResult {
  let runCounts = { ...EMPTY_COUNTS };
  const perPlayerMap = new Map<string, RegisterCounts>();
  const messageCounts: { utter: Utterance; counts: RegisterCounts; dens: number }[] = [];

  for (const u of utterances) {
    const c = registerCounts(u.body);
    runCounts = addCounts(runCounts, c);
    const prev = perPlayerMap.get(u.speakerId) ?? { ...EMPTY_COUNTS };
    perPlayerMap.set(u.speakerId, addCounts(prev, c));
    if (c.chars >= 60) {
      messageCounts.push({ utter: u, counts: c, dens: density(totalMarks(c), c.chars) });
    }
  }

  messageCounts.sort((a, b) => b.dens - a.dens);
  const worstMessages = messageCounts.slice(0, 3);
  const perPlayer = run.players
    .filter((p) => perPlayerMap.has(p.id))
    .map((p) => ({ id: p.id, counts: perPlayerMap.get(p.id)! }));

  return { run: runCounts, perPlayer, worstMessages };
}

// ---------------------------------------------------------------------------
// Section 6 — frame detector
// ---------------------------------------------------------------------------

type Accusation = {
  seq: number;
  speakerId: string;
  targetId: string;
  body: string;
  cue: string;
};

type FrameResult = {
  utterances: number;
  speechesWithAccusation: number;
  accusations: Accusation[];
  withResponse: number;
  frameNamed: number;
  frames: { acc: Accusation; responseSeq: number; responseBody: string; phrase: string }[];
  accuserPunished: number;
  punished: { acc: Accusation; seq: number; kind: string; byWolves: number; by: string[] }[];
};

function findNamedTargets(body: string, run: LoadedRun, excludeId: string): { id: string; at: number }[] {
  const found: { id: string; at: number }[] = [];
  for (const [name, id] of run.nameToId) {
    if (id === excludeId) continue;
    const re = new RegExp(`\\b${escapeRegExp(name)}\\b`, "i");
    const m = re.exec(body);
    if (m) found.push({ id, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * The user's hypothesis, made countable: a player accuses another; the wolves pile onto
 * the accuser to make the accused look like the manipulator; the accused should name the
 * frame out loud. Per run this detects
 *   (a) accusations — a public utterance naming another player in an accusatory register
 *       (a targeted second-person accusation, or an explicit vote/no-confidence statement
 *       naming a player);
 *   (b) whether the ACCUSED player's next message names the frame, from FRAME_PHRASES;
 *   (c) whether the ACCUSER was subsequently voted for or exiled.
 * Numerator and denominator are both reported, always.
 */
function analyzeFrames(run: LoadedRun, utterances: Utterance[]): FrameResult {
  const accusations: Accusation[] = [];
  const accusationSeqs = new Set<number>();

  for (const u of utterances) {
    const targets = findNamedTargets(u.body, run, u.speakerId);
    if (!targets.length) continue;
    const sentences = u.body.split(/(?<=[.!?])\s+/);
    const seen = new Set<string>();
    for (const sentence of sentences) {
      const named = targets.filter((t) =>
        new RegExp(`\\b${escapeRegExp(nameOf(run, t.id))}\\b`, "i").test(sentence),
      );
      if (!named.length) continue;

      // (a1) explicit targeted accusation in the same sentence as the name
      if (RE_ACCUSE_CUE.test(sentence)) {
        const cue = (RE_ACCUSE_CUE.exec(sentence)?.[0] ?? "cue").toLowerCase();
        for (const t of named) {
          if (seen.has(t.id)) continue;
          seen.add(t.id);
          accusations.push({ seq: u.seq, speakerId: u.speakerId, targetId: t.id, body: u.body, cue });
          accusationSeqs.add(u.seq);
        }
        continue;
      }
      // (a2) second-person accusation: "you" + a sharp token, exactly one other name in the
      // sentence (that name is who "you" points at)
      if (named.length === 1 && RE_SECOND_PERSON.test(sentence) && RE_SECOND_PERSON_CUE.test(sentence)) {
        const t = named[0];
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        accusations.push({ seq: u.seq, speakerId: u.speakerId, targetId: t.id, body: u.body, cue: "you" });
        accusationSeqs.add(u.seq);
      }
    }
  }

  // (b) the accused's next message, and whether it names the frame
  let withResponse = 0;
  let frameNamed = 0;
  const frames: FrameResult["frames"] = [];
  for (const acc of accusations) {
    const response = utterances.find((u) => u.speakerId === acc.targetId && u.seq > acc.seq);
    if (!response) continue;
    withResponse += 1;
    const lower = response.body.toLowerCase();
    const phrase = FRAME_PHRASES.find((p) => lower.includes(p));
    if (phrase) {
      frameNamed += 1;
      frames.push({ acc, responseSeq: response.seq, responseBody: response.body, phrase });
    }
  }

  // (c) the accuser voted for or exiled after the accusation; note whether the votes came
  // from wolves (the pile-on the hypothesis predicts)
  const votes: { seq: number; voterId: string; targetId: string | null }[] = [];
  for (const ev of run.events) {
    if (ev.kind !== "vote_cast" || ev.visibility !== "public") continue;
    const parsed = parseVote(ev.message, run);
    if (!parsed) continue;
    votes.push({ seq: ev.sequence, voterId: parsed.voterId, targetId: parsed.targetId });
  }
  const removals = run.events.filter((ev) => ev.kind === "player_removed" && ev.playerId);

  let accuserPunished = 0;
  const punished: FrameResult["punished"] = [];
  const punishedKeys = new Set<string>();
  for (const acc of accusations) {
    const vote = votes.find((v) => v.targetId === acc.speakerId && v.seq > acc.seq);
    const removal = removals.find(
      (ev) => ev.playerId === acc.speakerId && ev.sequence > acc.seq && /exil/i.test(ev.message),
    );
    if (!vote && !removal) continue;
    accuserPunished += 1;
    // Everyone who voted for the accuser after the accusation — the pile-on the hypothesis
    // predicts, whether or not the accuser was ultimately exiled.
    const by = votes
      .filter((v) => v.targetId === acc.speakerId && v.seq > acc.seq)
      .map((v) => nameOf(run, v.voterId));
    const byWolves = by.filter((n) => run.roles.get(run.nameToId.get(n) ?? "") === "werewolf").length;
    const kind = vote ? "voted" : "exiled";
    const hitSeq = vote ? vote.seq : removal!.sequence;
    const key = `${acc.speakerId}:${kind}:${hitSeq}`;
    if (punishedKeys.has(key)) continue;
    punishedKeys.add(key);
    punished.push({
      acc,
      seq: hitSeq,
      kind,
      byWolves,
      by: [...new Set(by)],
    });
  }

  return {
    utterances: utterances.length,
    speechesWithAccusation: accusationSeqs.size,
    accusations,
    withResponse,
    frameNamed,
    frames,
    accuserPunished,
    punished,
  };
}

// ---------------------------------------------------------------------------
// Section 7 — cross-run digest
// ---------------------------------------------------------------------------

type Exile = { id: string; wolf: boolean };

type DigestRow = {
  id: string;
  seed: string | null;
  playerCount: number;
  castSource: string;
  survivors: string[];
  exiles: Exile[];
  nightKills: string[];
  leaderExiled: boolean;
  exileBallots: number;
  contestedBallots: number;
};

function castSource(run: LoadedRun): string {
  const hasPersona = run.players.map((p) => (p.personality ?? "").trim().length > 0);
  if (hasPersona.every(Boolean)) return "authored";
  if (hasPersona.every((x) => !x)) return "generated";
  return "mixed";
}

function digestRow(run: LoadedRun): DigestRow {
  const exiles: Exile[] = [];
  const nightKills: string[] = [];
  for (const ev of run.events) {
    if (ev.kind !== "player_removed" || !ev.playerId) continue;
    if (/exil/i.test(ev.message)) {
      exiles.push({ id: ev.playerId, wolf: run.roles.get(ev.playerId) === "werewolf" });
    } else if (/eaten/i.test(ev.message)) {
      nightKills.push(ev.playerId);
    }
  }
  const survivors = run.players.filter((p) => run.alive.get(p.id) !== false).map((p) => p.id);

  const leaderExiled = exiles.some((e) => {
    const p = run.players.find((q) => q.id === e.id);
    return p ? RE_LEADERSHIP.test(p.personality ?? "") : false;
  });

  // Exile ballots: runs of vote_cast between exile contexts. The context flips to "exile" at
  // exile_vote_started and to "sheriff" at sheriff_election_started; a ballot closes at
  // votes_tallied. Contestedness = share of EXILE ballots with more than one distinct target.
  let context: "exile" | "sheriff" | "none" = "none";
  let current: string[] = [];
  let exileBallots = 0;
  let contestedBallots = 0;
  const closeBallot = () => {
    if (context === "exile" && current.length) {
      exileBallots += 1;
      if (new Set(current).size > 1) contestedBallots += 1;
    }
    current = [];
  };
  for (const ev of run.events) {
    if (ev.kind === "sheriff_election_started") {
      closeBallot();
      context = "sheriff";
    } else if (ev.kind === "exile_vote_started") {
      closeBallot();
      context = "exile";
    } else if (ev.kind === "vote_cast") {
      const parsed = parseVote(ev.message, run);
      current.push(parsed?.targetId ?? ev.message);
    } else if (ev.kind === "votes_tallied") {
      closeBallot();
    }
  }
  closeBallot();

  return {
    id: run.id,
    seed: run.seed,
    playerCount: run.players.length,
    castSource: castSource(run),
    survivors,
    exiles,
    nightKills,
    leaderExiled,
    exileBallots,
    contestedBallots,
  };
}

// ---------------------------------------------------------------------------
// Analysis + report
// ---------------------------------------------------------------------------

type RunAnalysis = {
  run: LoadedRun;
  utterances: Utterance[];
  thoughts: number;
  voice: VoiceResult;
  drift: DriftResult;
  echo: EchoResult;
  register: RegisterResult;
  frames: FrameResult;
  digest: DigestRow;
  sheetThoughts: number;
  sheetSpeeches: number;
};

function analyzeRun(run: LoadedRun): RunAnalysis {
  const utterances = publicUtterances(run);
  const model = buildVoiceModel(run, utterances);
  const voice = analyzeVoices(run, model);
  const drift = analyzeDrift(run, model, utterances, voice.meanPairwiseDelta);
  const echo = analyzeEcho(utterances);
  const register = analyzeRegister(run, utterances);
  const frames = analyzeFrames(run, utterances);
  const digest = digestRow(run);
  return {
    run,
    utterances,
    thoughts: run.events.filter((ev) => ev.kind === "player_thought").length,
    voice,
    drift,
    echo,
    register,
    frames,
    digest,
    sheetThoughts: 0,
    sheetSpeeches: utterances.length,
  };
}

function banner(title: string): void {
  console.log("");
  console.log("─".repeat(80));
  console.log(title);
  console.log("─".repeat(80));
}

function printSection2(analyses: RunAnalysis[]): void {
  banner("2. VOICES — are the personas actually distinguishable?");
  console.log(`  Burrows' Delta over ${FUNCTION_WORDS.length} function words; z-scored per run, Manhattan mean of z-diffs.`);
  console.log("  Identification = leave-one-utterance-out nearest-centroid; chance floor = 1/N players who speak.");
  console.log("  CAVEAT: Delta is documented as reliable only above ~1500 words per author. These players are far");
  console.log("  below that, so a LOW accuracy is a warning (the voices may not separate), not proof either way.");
  for (const a of analyses) {
    const v = a.voice;
    console.log("");
    console.log(`  ${a.run.id.slice(0, 8)}  players-speaking=${v.classes}  chance=${pct(v.chance)}  accuracy=${v.accuracy === null ? "n/a" : pct(v.accuracy)} (${v.correct}/${v.scored})`);
    if (v.pairs.length === 0) {
      console.log("    most-confused pairs: (need at least two speaking players)");
      continue;
    }
    const top = v.pairs.slice(0, 3);
    console.log("    most-confused pairs (lowest pairwise Delta = hardest to tell apart):");
    for (const p of top) {
      console.log(`      ${fixed(p.delta, 3)}  ${nameOf(a.run, p.a)} ~ ${nameOf(a.run, p.b)}`);
    }
  }
}

function printSection3(analyses: RunAnalysis[]): void {
  banner("3. DRIFT — does a voice hold all game?");
  console.log("  Per player: Delta(first-half centroid, second-half centroid), NORMALISED by the run's mean");
  console.log("  between-player Delta. Units are \"player-distances\": ~1.0 means the voice moved as far across");
  console.log("  the game as one player differs from another; <1.0 is stable, well above 1.0 is drift.");
  for (const a of analyses) {
    console.log("");
    const norm = a.voice.meanPairwiseDelta;
    console.log(`  ${a.run.id.slice(0, 8)}  normaliser(mean between-player Delta)=${norm === null ? "n/a" : fixed(norm, 3)}  run-mean drift=${a.drift.meanNormalized === null ? "n/a" : fixed(a.drift.meanNormalized, 2)}`);
    const rows = a.drift.perPlayer
      .map((p) => ({ id: p.id, d: p.normalized }))
      .sort((x, y) => (y.d ?? -1) - (x.d ?? -1));
    for (const p of rows) {
      console.log(`    ${nameOf(a.run, p.id).padEnd(14)} ${p.d === null ? "   n/a" : fixed(p.d, 2).padStart(6)}`);
    }
    console.log(`    worst: ${a.drift.worst ? `${nameOf(a.run, a.drift.worst.id)} (${fixed(a.drift.worst.normalized, 2)})` : "n/a"}`);
  }
}

function printSection4(analyses: RunAnalysis[]): void {
  banner("4. ECHO — how much is restatement?");
  console.log("  Max 4-gram containment of each public speech in any EARLIER speech by a DIFFERENT player;");
  console.log("  mean and max over the run. High = the \"eight bots restating the same case\" failure.");
  for (const a of analyses) {
    const e = a.echo;
    console.log("");
    console.log(`  ${a.run.id.slice(0, 8)}  mean=${e.mean === null ? "n/a" : pct(e.mean)}  max=${e.max === null ? "n/a" : pct(e.max)}  (scored ${e.scored}, skipped ${e.skipped} with <4 words)`);
    if (e.worst) {
      const w = e.worst;
      console.log(`    worst pair: ${w.later.speakerName} ← ${w.earlier.speakerName}  ${pct(w.overlap)}  shared phrase: "${w.phrase}"`);
    }
  }
}

function printSection5(analyses: RunAnalysis[]): void {
  banner("5. REGISTER / SLOP DENSITY — a LENS, not a verdict");
  console.log("  Counts per 1000 characters of: em dash, the \"not just X but Y\" construction, focal/AI vocab,");
  console.log("  -ing tail-padding, hedging. DENSITY, not presence — one em dash means nothing; a rate is the signal.");
  console.log("  The em dash in particular is a tell that good human prose uses too. Read this to compare players");
  console.log("  and runs, not to police a word.");
  for (const a of analyses) {
    const c = a.register.run;
    console.log("");
    console.log(`  ${a.run.id.slice(0, 8)}  chars=${c.chars}  per-1000: em-dash=${fixed(density(c.emDash, c.chars), 2)}  notjust=${fixed(density(c.construction, c.chars), 2)}  focal=${fixed(density(c.focal, c.chars), 2)}  ingpad=${fixed(density(c.ingPad, c.chars), 2)}  hedge=${fixed(density(c.hedge, c.chars), 2)}`);
    const ranked = a.register.perPlayer
      .map((p) => ({ id: p.id, d: density(totalMarks(p.counts), p.counts.chars) }))
      .sort((x, y) => y.d - x.d);
    const top = ranked.slice(0, 3).map((p) => `${nameOf(a.run, p.id)} ${fixed(p.d, 2)}`);
    console.log(`    densest players (marks/1k): ${top.join("   ") || "(none)"}`);
    for (const m of a.register.worstMessages) {
      console.log(`    worst msg ${m.utter.speakerName} ${fixed(m.dens, 2)}/1k: "${clip(m.utter.body, 120)}"`);
    }
  }
}

function printSection6(analyses: RunAnalysis[]): void {
  banner("6. FRAME DETECTOR — the user's hypothesis, made countable");
  console.log("  Hypothesis: an accusation (A->B) draws wolves onto A, so B looks like the manipulator,");
  console.log("  and B should name the frame out loud. Counted over public speeches per run.");
  console.log("  (a) accusations, (b) accused's next message names the frame, (c) accuser then voted/exiled.");
  for (const a of analyses) {
    const f = a.frames;
    console.log("");
    console.log(`  ${a.run.id.slice(0, 8)}  (a) accusations: ${f.accusations.length} across ${f.speechesWithAccusation} of ${f.utterances} public speeches`);
    console.log(`      (a) instances (speaker -> target, cue):`);
    const shownAcc = f.accusations.slice(0, 12);
    for (const acc of shownAcc) {
      console.log(`        ${nameOf(a.run, acc.speakerId)} -> ${nameOf(a.run, acc.targetId)} (${acc.cue}): "${clip(acc.body, 100)}"`);
    }
    if (f.accusations.length > shownAcc.length) {
      console.log(`        (+${f.accusations.length - shownAcc.length} more accusations)`);
    }
    console.log(`      (b) accused had a next message: ${f.withResponse}; of those names the frame: ${ratio(f.frameNamed, f.withResponse)}`);
    console.log(`      (c) accuser subsequently voted/exiled: ${ratio(f.accuserPunished, f.accusations.length)}`);
    for (const fr of f.frames) {
      console.log(`      frame: ${nameOf(a.run, fr.acc.targetId)} ("${fr.phrase}") after ${nameOf(a.run, fr.acc.speakerId)}: "${clip(fr.responseBody, 110)}"`);
    }
    const shown = f.punished.slice(0, 8);
    for (const p of shown) {
      console.log(`      punish: after ${nameOf(a.run, p.acc.speakerId)} accused ${nameOf(a.run, p.acc.targetId)}, ${nameOf(a.run, p.acc.speakerId)} was ${p.kind} (by ${p.by.join(", ") || "nobody recorded"}; wolves ${p.byWolves})`);
    }
    if (f.punished.length > shown.length) {
      console.log(`      (+${f.punished.length - shown.length} more punished accusers)`);
    }
  }
}

function printSection7(analyses: RunAnalysis[]): void {
  banner("7. CROSS-RUN DIGEST");
  console.log("  cast source inferred from config personalities (authored = all non-empty, generated = all empty).");
  console.log("  exiles show (wolf) or (villager); contestedness = share of exile ballots with >1 distinct target.");
  console.log("");
  console.log(
    `  ${"run".padEnd(9)}${"seed".padEnd(21)}${"n".padEnd(4)}${"cast".padEnd(10)}${"surv".padEnd(5)}${"exiles".padEnd(26)}${"kills".padEnd(6)}${"leader".padEnd(8)}contested`,
  );
  for (const a of analyses) {
    const d = a.digest;
    const exiles = d.exiles.map((e) => `${nameOf(a.run, e.id)}(${e.wolf ? "wolf" : "vill"})`).join(" ");
    console.log(
      `  ${d.id.slice(0, 8).padEnd(9)}${(d.seed ?? "?").padEnd(21)}${String(d.playerCount).padEnd(4)}${d.castSource.padEnd(10)}${String(d.survivors.length).padEnd(5)}${clip(exiles, 25).padEnd(26)}${String(d.nightKills.length).padEnd(6)}${(d.leaderExiled ? "yes" : "no").padEnd(8)}${ratio(d.contestedBallots, d.exileBallots)}`,
    );
  }
  if (!analyses.length) console.log("  (no runs)");
}

function printSection1Summary(results: { id: string; path: string; thoughts: number; speeches: number; utterances: number }[]): void {
  banner("1. READING SHEET — written to disk");
  if (!results.length) {
    console.log("  (no sheets written)");
    return;
  }
  for (const r of results) {
    const flag = r.thoughts === 0 ? "   [WARN: ZERO player_thought events — thin sheet]" : "";
    console.log(`  ${r.path}   thoughts=${r.thoughts}  speeches=${r.speeches}${flag}`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

/**
 * Resolve --dir. A CLI path is normally relative to the working directory, but the
 * documented default is written relative to the script (web/scripts/../../data/runs =
 * the repo's data/runs). To make the printed invocation work verbatim from either web/
 * or web/scripts/, prefer the cwd-relative path when it exists, else the script-relative
 * one, and report the cwd-relative candidate in the "cannot read" note if neither exists.
 */
function resolveCorpus(dirArg: string | null): string {
  if (!dirArg) return DEFAULT_DIR;
  const fromCwd = resolve(dirArg);
  if (existsSync(fromCwd)) return fromCwd;
  const fromScript = resolve(import.meta.dirname, dirArg);
  if (existsSync(fromScript)) return fromScript;
  return fromCwd;
}

async function main(): Promise<void> {
  const dirArg = argValue("--dir");
  const outArg = argValue("--out");
  const runPrefix = argValue("--run");
  const corpusDir = resolveCorpus(dirArg);
  const outDir = outArg ? resolve(outArg) : resolve(process.cwd(), "review");

  console.log("=".repeat(80));
  console.log("ROLEPLAY REVIEW — offline, deterministic, no model calls");
  console.log("=".repeat(80));
  console.log(`corpus: ${corpusDir}`);
  console.log(`out:    ${outDir}`);
  console.log(`filter: ${runPrefix ? `${runPrefix}*` : "(none)"}`);

  const { dirs, error } = listRunDirs(corpusDir);
  if (error) console.log(`note: ${error}`);
  const selected = runPrefix ? dirs.filter((d) => d.startsWith(runPrefix)) : dirs;
  if (runPrefix && dirs.length && selected.length === 0) {
    console.log(`note: no run directory matches prefix "${runPrefix}" (${dirs.length} present)`);
  }
  console.log(`found: ${dirs.length} run director(ies), ${selected.length} selected`);
  if (!selected.length) {
    console.log("");
    console.log("Nothing to analyze. (An empty or absent corpus is not an error.)");
    return;
  }

  // Load every run; a run missing a required file is skipped with a printed note.
  const runs: LoadedRun[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of selected) {
    const outcome = await loadRun(join(corpusDir, id), id);
    if (outcome.ok) {
      runs.push(outcome.run);
    } else {
      skipped.push({ id, reason: outcome.reason });
      console.log(`note: skipping ${id} — ${outcome.reason}`);
    }
  }
  console.log(`loaded: ${runs.length}   skipped: ${skipped.length}`);
  if (!runs.length) {
    console.log("");
    console.log("No analyzable runs. (Skipped runs are listed above.)");
    return;
  }

  const analyses = runs.map((run) => analyzeRun(run));

  // Section 1: write the reading sheets as files.
  mkdirSync(outDir, { recursive: true });
  const sheetResults: { id: string; path: string; thoughts: number; speeches: number; utterances: number }[] = [];
  for (const a of analyses) {
    const { path, thoughts, speeches } = writeReadingSheet(a.run, outDir);
    a.sheetThoughts = thoughts;
    a.sheetSpeeches = speeches;
    sheetResults.push({ id: a.run.id, path, thoughts, speeches, utterances: a.utterances.length });
    if (thoughts === 0) {
      console.log(`WARNING: run ${a.run.id.slice(0, 8)} has ZERO player_thought events — its sheet is public-only.`);
    }
  }

  printSection1Summary(sheetResults);
  printSection2(analyses);
  printSection3(analyses);
  printSection4(analyses);
  printSection5(analyses);
  printSection6(analyses);
  printSection7(analyses);

  console.log("");
  console.log("=".repeat(80));
  console.log("done.");
}

main().catch((err) => {
  console.error("roleplay-review: fatal:", err);
  process.exitCode = 1;
});
