#!/usr/bin/env node
/**
 * launch-batch.mts — launch a defined batch of games through the operator console,
 * one at a time, waiting for each run to finish before starting the next.
 *
 * Sequential on purpose. The console enforces WERWOELFE_MAX_CONCURRENT_RUNS (1 by
 * default), so a parallel launch would mostly return 409s; and since every run costs
 * real model calls, "wait for the one before it" is the cost control, not an
 * inconvenience to work around.
 *
 * Usage, from web/:
 *   node --experimental-strip-types scripts/launch-batch.mts [options]
 *
 * Options:
 *   --batch <path>   batch definition JSON (default scripts/batches/2026-10-11.json)
 *   --base <url>     console origin (default http://localhost:3000)
 *   --only <name>    launch just the named run (repeatable), then stop
 *   --dry-run        resolve and print the exact request bodies, launch nothing
 *   --poll <ms>      status poll interval (default 5000)
 *
 * The batch file defines casts once and runs that reference them by name, so the four
 * runs of one cast are identical by construction rather than by hand-copying. A cast may
 * `deriveFrom` another cast (see `generated` in the 2026-10-11 batch), which copies its
 * roster — ids, names and temperatures included — guaranteeing that a paired contrast
 * differs only in the field being blanked.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Player = { id: string; name: string; personality: string; temperature?: number };
type Cast = {
  note?: string;
  players?: Player[];
  deriveFrom?: string;
  blankPersonality?: boolean;
  model?: Record<string, unknown>;
};
type BatchRun = { name: string; cast: string; seed: string };
type Batch = {
  batch: string;
  description?: string;
  model: Record<string, unknown>;
  casts: Record<string, Cast>;
  runs: BatchRun[];
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

const scriptDir = dirname(fileURLToPath(import.meta.url));

function arg(flag: string, fallback: string | null = null): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function argAll(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

function resolveCast(batch: Batch, name: string, seen: string[] = []): Player[] {
  const cast = batch.casts[name];
  if (!cast) {
    throw new Error(`batch has no cast named "${name}"`);
  }
  if (seen.includes(name)) {
    throw new Error(`cast "${name}" derives from itself: ${[...seen, name].join(" -> ")}`);
  }
  if (cast.players) {
    return cast.players.map((player) => ({ ...player }));
  }
  if (!cast.deriveFrom) {
    throw new Error(`cast "${name}" has neither players nor deriveFrom`);
  }
  const base = resolveCast(batch, cast.deriveFrom, [...seen, name]);
  // Copy wholesale, blank only what was asked for: ids, names and temperatures must
  // survive untouched or the paired contrast stops being a contrast.
  return base.map((player) => ({
    ...player,
    personality: cast.blankPersonality ? "" : player.personality,
  }));
}

function resolveModel(batch: Batch, name: string): Record<string, unknown> {
  return { ...batch.model, ...(batch.casts[name]?.model ?? {}) };
}

type LaunchBody = {
  config: { players: Player[]; model: Record<string, unknown> };
  seed: string;
};

function bodyFor(batch: Batch, run: BatchRun): LaunchBody {
  return {
    config: { players: resolveCast(batch, run.cast), model: resolveModel(batch, run.cast) },
    seed: run.seed,
  };
}

// The console wraps its payloads: POST /api/games answers { game }, the list answers { games }.
// Response bodies come back as `unknown` and are narrowed at the point of use, so a shape change
// surfaces at the read rather than silently serving `any` through the whole script.
type RunPayload = { game?: { id?: string; status?: string; eventCount?: number } };
type ListPayload = { games?: Array<{ status: string }> };

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

async function get(base: string, path: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: await response.json().catch(() => null) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitForTerminal(base: string, id: string, pollMs: number, budgetMs: number): Promise<string> {
  const deadline = Date.now() + budgetMs;
  let last = "";
  while (Date.now() < deadline) {
    await sleep(pollMs);
    // GET /api/games/[id] wraps its payload as { game }, exactly like POST /api/games.
    const { json } = await get(base, `/api/games/${id}`);
    const payload = json as RunPayload | null;
    const status: string = payload?.game?.status ?? "unknown";
    if (status !== last) {
      const events = payload?.game?.eventCount ?? "?";
      process.stdout.write(`    ${status} (events: ${events})\n`);
      last = status;
    }
    if (TERMINAL.has(status)) {
      return status;
    }
  }
  return "timed-out";
}

// Active means queued or running: the console's concurrency limit counts both, so a launch
// attempted while either is present comes back 409. Waiting here rather than retrying the
// POST also avoids the orphan input directory a rejected launch leaves behind (startGame
// writes input/ before createGame checks the limit).
async function waitForFreeSlot(base: string, pollMs: number, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let announced = "";
  while (Date.now() < deadline) {
    const { json } = await get(base, "/api/games");
    const active = ((json as ListPayload | null)?.games ?? []).filter(
      (game) => game.status === "queued" || game.status === "running",
    );
    if (!active.length) {
      if (announced) {
        process.stdout.write("    slot free\n");
      }
      return;
    }
    const label = active.map((game) => game.status).join(",");
    if (label !== announced) {
      process.stdout.write(`    waiting for ${active.length} active run(s) [${label}]...\n`);
      announced = label;
    }
    await sleep(pollMs);
  }
}

async function main(): Promise<void> {
  const batchPath = resolve(scriptDir, arg("--batch", "batches/2026-10-11.json") as string);
  const base = (arg("--base", "http://localhost:3000") as string).replace(/\/$/, "");
  const only = argAll("--only");
  const dryRun = process.argv.includes("--dry-run");
  const pollMs = Number(arg("--poll", "5000"));
  const budgetMs = 45 * 60 * 1000;

  const batch = JSON.parse(readFileSync(batchPath, "utf8")) as Batch;
  const runs = only.length ? batch.runs.filter((run) => only.includes(run.name)) : batch.runs;
  if (!runs.length) {
    throw new Error(`no runs selected; batch "${batch.batch}" has: ${batch.runs.map((r) => r.name).join(", ")}`);
  }

  console.log(`batch   : ${batch.batch}  (${batchPath})`);
  console.log(`console : ${base}`);
  console.log(`runs    : ${runs.map((run) => run.name).join(", ")}`);
  const calls = runs.reduce((sum, run) => sum + resolveCast(batch, run.cast).length, 0);
  console.log(`seats   : ${calls} across ${runs.length} run(s)`);
  console.log("");

  if (dryRun) {
    for (const run of runs) {
      const body = bodyFor(batch, run);
      console.log(`--- ${run.name} (cast ${run.cast}, seed ${run.seed}) ---`);
      console.log(`  players    : ${body.config.players.map((player) => player.name).join(", ")}`);
      console.log(`  model      : ${JSON.stringify(body.config.model)}`);
      console.log(`  blanked    : ${body.config.players.filter((p: Player) => !p.personality).length} of ${body.config.players.length}`);
      console.log(`  personalit.: ${JSON.stringify(body.config.players.map((p: Player) => p.personality.length))}`);
      console.log("");
    }
    return;
  }

  const launched: Array<{ name: string; id: string; status: string }> = [];
  for (const run of runs) {
    const body = bodyFor(batch, run);
    console.log(`--- ${run.name} (cast ${run.cast}, seed ${run.seed}) ---`);

    await waitForFreeSlot(base, pollMs, budgetMs);

    let attempt = 0;
    let id: string | null = null;
    while (attempt < 3 && !id) {
      attempt += 1;
      const { status, json } = await post(base, "/api/games", body);
      if (status === 201 || status === 200) {
        // POST /api/games answers { game }, not the detail directly.
        id = (json as RunPayload | null)?.game?.id ?? null;
        console.log(`  launched : ${id}`);
        console.log(`  watch    : ${base}/games/${id}`);
      } else if (status === 409) {
        console.log(`  busy (409), waiting ${pollMs}ms before retrying [attempt ${attempt}]`);
        await sleep(pollMs);
      } else {
        console.log(`  FAILED   : HTTP ${status} ${JSON.stringify(json)}`);
        break;
      }
    }

    if (!id) {
      launched.push({ name: run.name, id: "-", status: "not-launched" });
      console.log("");
      continue;
    }

    const status = await waitForTerminal(base, id, pollMs, budgetMs);
    launched.push({ name: run.name, id, status });
    console.log("");
  }

  console.log("=== summary ===");
  for (const entry of launched) {
    console.log(`  ${entry.name.padEnd(14)} ${entry.status.padEnd(12)} ${entry.id}`);
  }
  const bad = launched.filter((entry) => entry.status !== "completed");
  if (bad.length) {
    console.log("");
    console.log(`${bad.length} run(s) did not complete: ${bad.map((entry) => `${entry.name}=${entry.status}`).join(", ")}`);
    process.exitCode = 1;
  }
}

await main();
