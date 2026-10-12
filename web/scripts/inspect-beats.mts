/**
 * Dev harness: run the beat builder and cadence over the recorded corpus and
 * print what the spectator page would actually render. No build step —
 * Node strips the types natively.
 *
 *   node scripts/inspect-beats.mts               # every run in ../data/runs
 *   node scripts/inspect-beats.mts <run-id>      # one run, beat by beat
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GameEvent, GamePlayer } from "../src/lib/game.ts";
import { buildBeats, buildPlayerIndex, groupBeatsByAct, type Beat } from "../src/lib/beats.ts";
import { dwellMs } from "../src/lib/cadence.ts";
import { alignmentGap, deriveBeliefs, deriveGroundTruth, roleLabel } from "../src/lib/truth.ts";

const DATA_DIR = resolve(import.meta.dirname, "..", "..", "data", "runs");

type Loaded = {
  players: GamePlayer[];
  /** Final roles from the sanitized result artifact, when the run completed. */
  roster: Map<string, string> | null;
  events: GameEvent[];
};

function loadRun(dir: string): Loaded {
  const config = JSON.parse(readFileSync(join(dir, "input", "config.json"), "utf8")) as {
    players: { id: string; name: string }[];
  };
  const players: GamePlayer[] = config.players.map((player) => ({
    id: player.id,
    name: player.name,
    role: null,
    alive: null,
  }));
  const raw = readFileSync(join(dir, "output", "events.ndjson"), "utf8");
  const events: GameEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const record = JSON.parse(line) as { type?: string; event?: GameEvent };
    if (record.type === "event" && record.event) events.push(record.event);
  }
  let roster: Map<string, string> | null = null;
  try {
    const result = JSON.parse(readFileSync(join(dir, "output", "game-result.json"), "utf8")) as {
      players?: { id: string; role: string }[];
    };
    if (result.players?.length) {
      roster = new Map(result.players.map((player) => [player.id, player.role]));
    }
  } catch {
    roster = null;
  }
  return { players, roster, events };
}

function oneLine(beat: Beat): string {
  switch (beat.kind) {
    case "speech":
      return `speech ${beat.speaker?.name ?? "?"} · ${beat.body.length}c${beat.truncated ? " [cut]" : ""}`;
    case "pileOn":
      return `pileOn → ${beat.target?.name ?? "?"} · ${beat.voices.length} voices`;
    case "passRun":
      return `pass ×${beat.voices.length}`;
    case "declaration":
      return `declare ${beat.speaker?.name ?? "?"} → ${beat.target?.name ?? "(none)"} · ${beat.body.length}c${beat.truncated ? " [cut]" : ""}`;
    case "ballot":
      return `ballot ${beat.scope} · ${beat.votes.length} votes`;
    case "voteTally":
      return `tally ${beat.raw}`;
    case "elimination":
      return `elim ${beat.player?.name ?? "?"} (${beat.cause}) role=${beat.role ?? "?"}`;
    case "night":
      return `night ${beat.night} · wolves=[${beat.wolves.join(",")}] meal=${beat.mealVictim?.name ?? "?"} plans=${beat.plans.length} checks=${beat.checks.length}`;
    case "marker":
      return `marker ${beat.title}`;
    case "text":
      return `text ${beat.event.kind}`;
  }
}

const target = process.argv[2];
const dirs = readdirSync(DATA_DIR)
  .filter((name) => statSync(join(DATA_DIR, name)).isDirectory())
  .filter((name) => (target ? name.startsWith(target) : true))
  .sort();

const totals = { events: 0, beats: 0, ms: 0 };

for (const name of dirs) {
  let run;
  try {
    run = loadRun(join(DATA_DIR, name));
  } catch {
    console.log(`${name.slice(0, 8)}  (no events.ndjson)`);
    continue;
  }
  const beats = buildBeats(run.events, run.players);
  const ms = beats.reduce((sum, beat) => sum + dwellMs(beat, 1), 0);
  const kinds = new Map<string, number>();
  for (const beat of beats) kinds.set(beat.kind, (kinds.get(beat.kind) ?? 0) + 1);

  totals.events += run.events.length;
  totals.beats += beats.length;
  totals.ms += ms;

  // Ground truth: the live derivation must reproduce the sanitized roster exactly.
  const truth = deriveGroundTruth(run.players, run.events);
  let verdict = "—";
  if (run.roster) {
    const expectedWolves = [...run.roster].filter(([, role]) => role === "werewolf").map(([id]) => id).sort();
    const expectedSeer = [...run.roster].find(([, role]) => role === "seer")?.[0] ?? null;
    const wolvesOk = expectedWolves.join(",") === [...truth.wolves].sort().join(",");
    const seerOk = expectedSeer === truth.seerId;
    verdict = truth.source === "derived" ? (wolvesOk && seerOk ? "exact" : `MISMATCH ${expectedWolves} vs ${truth.wolves}`) : truth.source;
  }

  const spread = [...kinds.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key}:${count}`)
    .join(" ");

  console.log(
    `${name.slice(0, 8)}  events=${String(run.events.length).padStart(4)}  beats=${String(beats.length).padStart(4)}  watch=${(ms / 60000).toFixed(1)}m  truth=${verdict.padEnd(6)}  ${spread}`,
  );

  if (target) {
    console.log("");
    for (const group of groupBeatsByAct(beats)) {
      console.log(`  ${group.title}`);
      for (const beat of group.beats) {
        const dwell = (dwellMs(beat, 1) / 1000).toFixed(1);
        console.log(`    [${String(beat.firstSeq).padStart(3)}–${String(beat.lastSeq).padStart(3)}] ${dwell}s  ${oneLine(beat)}`);
      }
    }
    console.log("");
    console.log(
      `  1x=${(ms / 60000).toFixed(1)}m  2x=${(ms / 2 / 60000).toFixed(1)}m  4x=${(ms / 4 / 60000).toFixed(1)}m  instant=${(beats.length * 0.04).toFixed(1)}s`,
    );
    console.log(`  last beat dwell check: ${dwellMs(beats[beats.length - 1], 1)}ms`);
  }
}

console.log(
  `\nTOTAL events=${totals.events} beats=${totals.beats} ratio=${(totals.events / Math.max(1, totals.beats)).toFixed(2)}× watch=${(totals.ms / 60000).toFixed(1)}m`,
);
