import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { GameDetail, GameEvent } from "@/lib/game";
import {
  addGameEvent,
  cancelGame,
  completeGame,
  createGame,
  failExitedGame,
  failGame,
  getActiveGames,
  getGameDeadline,
  getGameDetail,
  getKnownGameIds,
  getRunConfiguration,
  pauseGame as markGamePaused,
  resumeGame as markGameRunning,
  setGameDeadline,
  setGameRunning,
} from "@/lib/server/db";
import { assertKubernetesEnvironment, deepSeekAPIKey, environment } from "@/lib/server/env";
import {
  arm,
  clear,
  deadlineSecondsForJob,
  extendForPause,
  pause as pauseTimer,
  remainingMs,
  resume as resumeTimer,
  resumeDeadline,
  type DeadlineState,
  type RunTimer,
} from "@/lib/server/run-deadline";
import { selectRuntime, type GameRuntime, type RunObservation } from "@/lib/server/runtime";
import type { ValidGameConfig } from "@/lib/server/schema";

/**
 * The run lifecycle, over whichever runtime `selectRuntime()` hands back.
 *
 * The console no longer holds a child process. A run is *observed* — a Kubernetes Job's conditions
 * or a container's inspect output — so the only thing this module drives is the state machine:
 * start, pause, resume, stop, and the terminal verdict. Two clocks run underneath it and both are
 * durable across a restart: the wall-clock budget in `run-deadline.ts` (in memory) mirrored onto
 * the `games` row (on disk), and the poller that notices a run has ended.
 *
 * `registerRuntime(...)` must have run first; that is `src/instrumentation.ts`'s job. Until then
 * `selectRuntime()` throws a message that names the missing registration.
 */

type StreamRecord = {
  schema_version: number;
  type: "event" | "result" | "failure";
  event?: Omit<GameEvent, "recipients" | "playerId" | "revealedRole"> & {
    recipients?: string[];
    player_id?: string;
    revealed_role?: string;
  };
  result?: {
    winner: string;
    // The engine's spoiler-free run title. Absent on records written before titles existed.
    title?: string | null;
    players: Array<{ id: string; name: string; role: string; alive: boolean }>;
  };
  error?: string;
};

/**
 * A run the cluster holds, as the sweep sees it: the Job's name, and the game the Job *claims* to
 * be. The claim comes from the `app.werwoelfe.game` label and from nothing else — see the sweep
 * below for why no other evidence is accepted.
 */
type ManagedRun = {
  jobName: string;
  gameId: string | null;
};

/** A runtime that can enumerate and reap its own runs — used only for the orphan sweep. Optional. */
type ManagedRunLister = {
  listManagedRuns(): Promise<ManagedRun[]>;
  deleteUnownedJob(jobName: string): Promise<void>;
};

type Poller = { handle: ReturnType<typeof setInterval>; inFlight: boolean };

declare global {
  var werwoelfeRunPoller: Poller | undefined;
}

function runDirectory(id: string): string {
  return path.join(environment.dataDir, "runs", id);
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function seed(): string {
  return randomBytes(8).readBigUInt64BE().toString();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "The game runner failed unexpectedly.";
}

function runBudgetMs(): number {
  return environment.maxRunMinutes * 60_000;
}

/** The persisted deadline clock, defaulting to a fresh budget when nothing was recorded. */
function deadlineState(deadlineAtISO: string | null, pausedAtISO: string | null): DeadlineState {
  const deadlineAt = deadlineAtISO === null ? Number.NaN : Date.parse(deadlineAtISO);
  const pausedAt = pausedAtISO === null ? null : Date.parse(pausedAtISO);
  return {
    deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : Date.now() + runBudgetMs(),
    pausedAt: pausedAt !== null && Number.isFinite(pausedAt) ? pausedAt : null,
  };
}

function persistDeadline(id: string, state: DeadlineState): void {
  setGameDeadline(
    id,
    new Date(state.deadlineAt).toISOString(),
    state.pausedAt === null ? null : new Date(state.pausedAt).toISOString(),
  );
}

/**
 * The `activeDeadlineSeconds` a Job should carry right now.
 *
 * The Job's clock starts when the Job is created, so its value is the run's *total* allowance from
 * that instant; the game row's `started_at` is the closest thing the console records to that.
 */
function jobDeadlineSeconds(startedAt: string | null, state: DeadlineState, now: number): number {
  const parsed = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const jobStartMs = Number.isFinite(parsed) ? parsed : now;
  return deadlineSecondsForJob(state, jobStartMs, now);
}

async function ingestEvents(id: string): Promise<void> {
  const run = getRunConfiguration(id);
  if (!run) {
    return;
  }
  const eventPath = path.join(run.artifactDir, "output", "events.ndjson");
  let contents: string;
  try {
    const stat = await fs.stat(eventPath);
    if (stat.size > 8 * 1024 * 1024) {
      failGame(id, "The operator event stream exceeded the 8 MB safety limit.");
      return;
    }
    contents = await fs.readFile(eventPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    failGame(id, `Could not read the operator event stream: ${safeError(error)}`);
    return;
  }

  // Parse only newline-terminated records. A process killed mid-write leaves a partial trailing
  // line, and treating that fragment as a record is how a half-written event becomes a spurious
  // "invalid operator event record". A partial record is simply not yet an event.
  const complete = contents.endsWith("\n") ? contents : contents.slice(0, contents.lastIndexOf("\n") + 1);
  for (const line of complete.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let record: StreamRecord;
    try {
      record = JSON.parse(line) as StreamRecord;
    } catch {
      failGame(id, "The game runner wrote an invalid operator event record.");
      return;
    }
    if (record.schema_version !== 1) {
      failGame(id, "The game runner used an unsupported operator event schema.");
      return;
    }
    if (record.type === "event" && record.event) {
      addGameEvent(id, {
        sequence: record.event.sequence,
        at: record.event.at,
        kind: record.event.kind,
        visibility: record.event.visibility,
        recipients: record.event.recipients ?? [],
        playerId: record.event.player_id ?? null,
        revealedRole: record.event.revealed_role ?? null,
        message: record.event.message,
      });
    }
    if (record.type === "result" && record.result) {
      completeGame(id, record.result);
    }
    if (record.type === "failure") {
      failGame(id, record.error || "The game runner reported a failure.");
    }
  }
}

/**
 * Apply a run's terminal observation.
 *
 * The event stream is ingested *first*, always: a real result on the PVC beats any conclusion
 * drawn from the run having vanished. A Job that has been garbage-collected, or a container removed
 * by `--rm`, would otherwise turn a finished game into a failed one.
 */
async function finalizeRun(
  id: string,
  observation: Extract<RunObservation, { state: "terminal" }>,
): Promise<void> {
  clear(id);
  await ingestEvents(id);
  const detail = getGameDetail(id);
  if (!detail || isTerminal(detail.status)) {
    return;
  }
  if (observation.reason === "deadline") {
    failExitedGame(id, "The game runner exceeded its time limit.");
    return;
  }
  if (observation.reason === "missing") {
    failExitedGame(id, "The game runner disappeared before it recorded a result.");
    return;
  }
  // "completed" and "failed" alike are judged by the exit code, exactly as the child process's
  // `close` code was. A clean exit with no result record is still a failure to produce a game.
  failExitedGame(
    id,
    observation.exitCode === 0 || observation.exitCode === null
      ? "The game runner exited without a terminal result."
      : `The game runner exited with code ${observation.exitCode}.`,
  );
}

/**
 * The run's budget ran out.
 *
 * The engine's own clock is disabled (`-timeout 0`) precisely so this is the only limit, and a
 * non-zero engine timeout would kill a paused run. Ingesting before the verdict lets a result
 * written in the final moments still win; stopping the run after it reclaims the container.
 */
async function expireRun(id: string): Promise<void> {
  const run = getRunConfiguration(id);
  if (!run || isTerminal(run.status)) {
    return;
  }
  await ingestEvents(id);
  failExitedGame(id, "The game runner exceeded its time limit.");
  clear(id);
  try {
    await selectRuntime().stopRun(id);
  } catch (error) {
    // The orphan sweep retries this; the run is already failed either way.
    console.error(`[werwoelfe] could not stop the timed-out run ${id}: ${safeError(error)}`);
  }
}

/** Register a run's durable timer, with `onExpire` wired to the stop path. */
function armRunDeadline(id: string, state: DeadlineState): void {
  const timer: RunTimer = {
    handle: null,
    remainingMs: Math.max(0, remainingMs(state, Date.now())),
    startedAt: null,
    onExpire: () => {
      void expireRun(id);
    },
  };
  arm(id, timer);
}

function managedRunLister(runtime: GameRuntime): ManagedRunLister | null {
  const candidate = runtime as Partial<ManagedRunLister>;
  return typeof candidate.listManagedRuns === "function" ? (candidate as ManagedRunLister) : null;
}

/**
 * One pass of the join between the runtime's runs and the console's non-terminal games.
 *
 * Everything here is per-game guarded: an unreachable API is not evidence that anything failed.
 */
async function sweepRuns(runtime: GameRuntime): Promise<void> {
  const active = getActiveGames();

  // One list per tick, when the runtime can enumerate its runs (Kubernetes Jobs). The Docker
  // runtime answers per run through `observeRun` instead, so both stay null there.
  const lister = managedRunLister(runtime);
  let runs: ManagedRun[] | null = null;
  let managedIds: Set<string> | null = null;
  if (lister) {
    try {
      runs = await lister.listManagedRuns();
      managedIds = new Set(
        runs.flatMap((run) => (run.gameId === null ? [] : [run.gameId])),
      );
    } catch {
      // An empty answer and an unanswerable API must not look the same: infer nothing, sweep
      // nothing. A failed list must never read as "these runs are gone".
      runs = null;
      managedIds = null;
    }
  }

  for (const game of active) {
    if (managedIds && !managedIds.has(game.id)) {
      // A live game with no run is gone. The join already knows it, so no per-run call is needed.
      try {
        await finalizeRun(game.id, { state: "terminal", exitCode: null, reason: "missing" });
      } catch (error) {
        console.error(`[werwoelfe] could not finalize the missing run ${game.id}: ${safeError(error)}`);
      }
      continue;
    }

    // Ingest the run's stream every tick, so a live game's events are current in the database even
    // when no one has the operator's detail page open. Without this the only thing that ingests a
    // live run is `refreshGame` on the detail GET, which would force the public read-only endpoint
    // to ingest to stay live — and then public load would reach this process's write path. The call
    // is idempotent and does not throw, but it is guarded like its neighbours so one unreadable
    // stream skips a tick rather than ending the sweep.
    try {
      await ingestEvents(game.id);
    } catch (error) {
      console.error(`[werwoelfe] could not ingest events for run ${game.id}: ${safeError(error)}`);
    }

    let observation: RunObservation;
    try {
      observation = await runtime.observeRun(game.id);
    } catch {
      // Skip, never fail: a run that could not be reached is not a run that failed.
      continue;
    }
    if (observation.state !== "terminal") {
      continue;
    }
    try {
      await finalizeRun(game.id, observation);
    } catch (error) {
      console.error(`[werwoelfe] could not finalize run ${game.id}: ${safeError(error)}`);
    }
  }

  // Orphan sweep: delete a Job only when it belongs to no game row at all.
  //
  // In a cluster the Job *is* the post-mortem. `kubectl describe job` holds the Failed reason
  // (DeadlineExceeded, BackoffLimitExceeded) and the pod's status — OOMKilled, ImagePullBackOff,
  // CreateContainerConfigError — while the pod's logs are the only place a run that died before
  // writing an event record explains itself. That is exactly why the manifest sets
  // `ttlSecondsAfterFinished`, so the sweep must not fight it. Hence: a Job whose label names a
  // game that exists is left strictly alone, whatever that game's status is — a *finished* run
  // keeps its Job and ages out on the TTL, where an operator can still read it. That is the
  // opposite of what this sweep used to do, and the change is deliberate.
  //
  // Reclaim only a Job that cannot be attributed: no `app.werwoelfe.game` label at all, or a label
  // naming an id with no row — a console redeployed over a reset database, or a stray Job left by
  // a wipe. A Job whose *name* merely looks like `werwoelfe-<id>` is not attributable; the name is
  // not a record of ownership, and guessing from it would both spare genuine strays and, worse,
  // make an unlabelled Job look like it belonged to whichever game happened to share the name.
  //
  // The list this walks is bounded, not growing without limit: the label selector scopes it to
  // managed Jobs and `ttlSecondsAfterFinished` reaps each one an hour after it finishes, so at
  // most one hour of finished Jobs is ever seen. Each entry costs one Set lookup — a finished Job
  // is never re-observed and never re-finalized, because the loop above iterates `active`, the
  // non-terminal set, and a terminal row is not in it.
  if (runs && lister) {
    const known = getKnownGameIds();
    for (const run of runs) {
      if (run.gameId !== null && known.has(run.gameId)) {
        continue;
      }
      try {
        await lister.deleteUnownedJob(run.jobName);
        console.error(`[werwoelfe] reclaimed unowned Job ${run.jobName}.`);
      } catch (error) {
        // Next tick; the Job is not going anywhere, and it is not blocking a run.
        console.error(`[werwoelfe] could not reclaim unowned Job ${run.jobName}: ${safeError(error)}`);
      }
    }
  }
}

async function pollOnce(poller: Poller): Promise<void> {
  if (poller.inFlight) {
    return;
  }
  poller.inFlight = true;
  try {
    await sweepRuns(selectRuntime());
  } catch (error) {
    console.error(`[werwoelfe] run poll failed: ${safeError(error)}`);
  } finally {
    poller.inFlight = false;
  }
}

/**
 * Start the poller, once. Unreferenced so it never holds the server's event loop open, and started
 * lazily by whoever first needs it (`startGame`, `reconcileRuns`) — a console with no runtime
 * registered must not spin one.
 */
function ensurePoller(): void {
  if (globalThis.werwoelfeRunPoller) {
    return;
  }
  const poller: Poller = {
    handle: setInterval(() => {
      void pollOnce(poller);
    }, environment.pollSeconds * 1000),
    inFlight: false,
  };
  poller.handle.unref?.();
  globalThis.werwoelfeRunPoller = poller;
}

/**
 * Restore a live run's two clocks and its pause state after a console restart.
 *
 * The control file is re-asserted to match the database: a console that crashed between the status
 * change and the control-file write leaves the engine running when the operator believes it is
 * paused (or blocked when the operator believes it is running). Writing the file is the repair.
 */
async function reconcileGame(runtime: GameRuntime, game: { id: string; status: string; started_at: string | null; deadline_at: string | null; paused_at: string | null }): Promise<void> {
  const paused = game.status === "paused";
  await runtime.setPaused(game.id, paused);

  const state = deadlineState(game.deadline_at, game.paused_at);
  armRunDeadline(game.id, state);
  if (paused) {
    // `arm` schedules immediately; a paused run's clock must be banked, not ticking.
    pauseTimer(game.id);
  }

  try {
    await runtime.setJobDeadline(game.id, jobDeadlineSeconds(game.started_at, state, Date.now()));
  } catch (error) {
    console.error(`[werwoelfe] could not re-apply the deadline for run ${game.id}: ${safeError(error)}`);
  }
}

/**
 * Run the sweep once at startup, then start the poller.
 *
 * Never throws: `instrumentation.ts` fire-and-forgets it, and an awaited failure there would be a
 * server that never serves a request.
 */
export async function reconcileRuns(): Promise<void> {
  let runtime: GameRuntime;
  try {
    runtime = selectRuntime();
  } catch (error) {
    console.error(`[werwoelfe] cannot reconcile runs: ${safeError(error)}`);
    return;
  }

  if (runtime.kind === "kubernetes") {
    try {
      assertKubernetesEnvironment();
    } catch (error) {
      console.error(`[werwoelfe] ${safeError(error)}`);
    }
  }

  // Repair before judging: put every live run's pause state and clock back in step first.
  for (const game of getActiveGames()) {
    try {
      await reconcileGame(runtime, game);
    } catch (error) {
      console.error(`[werwoelfe] could not restore run ${game.id}: ${safeError(error)}`);
    }
  }

  try {
    await sweepRuns(runtime);
  } catch (error) {
    console.error(`[werwoelfe] the startup run sweep failed: ${safeError(error)}`);
  }

  ensurePoller();
}

export async function startGame(config: ValidGameConfig, seedOverride?: string): Promise<GameDetail> {
  const runtime = selectRuntime();
  // Select on the runtime kind, because the two need opposite things from this process. The Docker
  // runtime runs the engine here, so it needs the key in the environment; the Kubernetes runtime
  // must never read it at all — the game pod gets DEEPSEEK_API_KEY straight from its Secret.
  if (runtime.kind === "kubernetes") {
    assertKubernetesEnvironment();
  } else {
    deepSeekAPIKey();
  }

  const id = randomUUID();
  const artifactDir = runDirectory(id);
  const inputDir = path.join(artifactDir, "input");
  const outputDir = path.join(artifactDir, "output");
  const controlDir = path.join(artifactDir, "control");
  // Every directory the Job's mounts point into must exist *before* the Job is created. A
  // `subPath` whose directory is missing fails the volume mount at kubelet time, before a single
  // container starts, and the Job would sit there as an unstartable pod.
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(controlDir, { recursive: true });
  await fs.writeFile(path.join(inputDir, "config.json"), JSON.stringify(config, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  // Keep the existing random generation as the default; use a supplied seed verbatim. The seed
  // stays a string end to end (uint64 exceeds float64), so it is never parsed as a JS number.
  const runSeed = seedOverride === undefined ? seed() : seedOverride;
  // Record the seed in a sibling of config.json so a run that dies before it can write a result
  // artifact — and so never reaches the operator database — still has a recoverable seed for
  // same-seed pairing. It is deliberately NOT a key in config.json: that file is the engine's
  // config, and an unexpected key there risks a load failure.
  await fs.writeFile(
    path.join(inputDir, "launch.json"),
    JSON.stringify({ seed: runSeed }, null, 2),
    { encoding: "utf8", mode: 0o600 },
  );

  // A throw here is the "only N games at once" rejection. It must happen before the run exists,
  // so a refused launch leaves nothing behind.
  const created = createGame(id, config, runSeed, artifactDir);

  const jobStartMs = Date.now();
  const state: DeadlineState = { deadlineAt: jobStartMs + runBudgetMs(), pausedAt: null };
  try {
    await runtime.startRun({
      id,
      seed: created.seed,
      image: environment.gameImage,
      activeDeadlineSeconds: deadlineSecondsForJob(state, jobStartMs, jobStartMs),
    });
  } catch (error) {
    // A leaked 'queued' row counts against MAX_CONCURRENT_RUNS forever, so a run that could not be
    // created must not leave one behind.
    failGame(id, safeError(error));
    throw error;
  }

  setGameRunning(id);
  persistDeadline(id, state);
  armRunDeadline(id, state);
  ensurePoller();
  return getGameDetail(id)!;
}

export async function pauseRunningGame(id: string): Promise<GameDetail> {
  const runtime = selectRuntime();
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (!markGamePaused(id)) {
    throw new Error("Only running games can be paused.");
  }
  pauseTimer(id);
  const paused = extendForPause(deadlineState(...deadlineColumns(id)), Date.now());
  try {
    await runtime.setPaused(id, true);
  } catch {
    // The pause never reached the engine: put the row back and let the clock run again.
    markGameRunning(id);
    resumeTimer(id);
    throw new Error("Could not pause the game.");
  }
  persistDeadline(id, paused);
  try {
    await runtime.setJobDeadline(id, jobDeadlineSeconds(run.startedAt, paused, Date.now()));
  } catch (error) {
    // Deliberately NOT rolled back. The pause is already in effect — the engine is blocked between
    // turns, and the operator asked for it. Failing a working pause because a deadline bump did
    // not land would be strictly worse; `reconcileRuns` re-applies the deadline on the next start.
    console.error(`[werwoelfe] paused run ${id} but could not extend its job deadline: ${safeError(error)}`);
  }
  return getGameDetail(id)!;
}

export async function resumePausedGame(id: string): Promise<GameDetail> {
  const runtime = selectRuntime();
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (!markGameRunning(id)) {
    throw new Error("Only paused games can be resumed.");
  }
  const resumed = resumeDeadline(deadlineState(...deadlineColumns(id)), Date.now());
  try {
    await runtime.setPaused(id, false);
  } catch {
    // Still paused as far as the engine is concerned, so the row (and the clock) go back too.
    markGamePaused(id);
    throw new Error("Could not resume the game.");
  }
  resumeTimer(id);
  persistDeadline(id, resumed);
  try {
    await runtime.setJobDeadline(id, jobDeadlineSeconds(run.startedAt, resumed, Date.now()));
  } catch (error) {
    // Same reasoning as the pause path: a failed deadline bump must not undo the operator's action.
    console.error(`[werwoelfe] resumed run ${id} but could not extend its job deadline: ${safeError(error)}`);
  }
  return getGameDetail(id)!;
}

export async function stopGame(id: string): Promise<GameDetail> {
  const runtime = selectRuntime();
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (!cancelGame(id)) {
    throw new Error("Only queued, running, or paused games can be stopped.");
  }
  clear(id);
  try {
    await runtime.stopRun(id);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await runtime.stopRun(id).catch((error) => {
      console.error(`[werwoelfe] could not stop run ${id}: ${safeError(error)}`);
    });
  }
  await ingestEvents(id);
  return getGameDetail(id)!;
}

export async function restartGame(id: string): Promise<GameDetail> {
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (run.status === "queued" || run.status === "running" || run.status === "paused") {
    await stopGame(id);
  }
  return startGame(run.config as ValidGameConfig);
}

export async function refreshGame(id: string): Promise<GameDetail | null> {
  await ingestEvents(id);
  return getGameDetail(id);
}

/** The persisted deadline columns for a run, as a tuple for `deadlineState`. */
function deadlineColumns(id: string): [string | null, string | null] {
  const deadline = getGameDeadline(id);
  return [deadline?.deadlineAt ?? null, deadline?.pausedAt ?? null];
}
