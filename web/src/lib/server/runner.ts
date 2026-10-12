import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import type { GameDetail, GameEvent } from "@/lib/game";
import {
  addGameEvent,
  cancelGame,
  completeGame,
  createGame,
  failExitedGame,
  failGame,
  getGameDetail,
  getRunConfiguration,
  pauseGame as markGamePaused,
  resumeGame as markGameRunning,
  setGameRunning,
} from "@/lib/server/db";
import { deepSeekAPIKey, environment } from "@/lib/server/env";
import type { ValidGameConfig } from "@/lib/server/schema";

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

declare global {
  var werwoelfeProcesses: Map<string, ChildProcess> | undefined;
  var werwoelfeRunTimeouts: Map<string, RunTimeout> | undefined;
}

const processes = globalThis.werwoelfeProcesses ?? new Map<string, ChildProcess>();
globalThis.werwoelfeProcesses = processes;
type RunTimeout = {
  handle: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number | null;
};
const runTimeouts = globalThis.werwoelfeRunTimeouts ?? new Map<string, RunTimeout>();
globalThis.werwoelfeRunTimeouts = runTimeouts;

function runDirectory(id: string): string {
  return path.join(environment.dataDir, "runs", id);
}

function dockerRunDirectory(id: string): string {
  return path.join(environment.dockerDataDir, "runs", id);
}

function containerName(id: string): string {
  return `werwoelfe-${id}`;
}

function seed(): string {
  return randomBytes(8).readBigUInt64BE().toString();
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : "The game runner failed unexpectedly.";
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

  for (const line of contents.split("\n")) {
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

async function finalizeProcess(id: string, code: number | null): Promise<void> {
  await ingestEvents(id);
  const detail = getGameDetail(id);
  if (!detail || detail.status === "completed" || detail.status === "failed" || detail.status === "cancelled") {
    return;
  }
  failExitedGame(id, code === 0 ? "The game runner exited without a terminal result." : `The game runner exited with code ${code ?? "unknown"}.`);
}

function armTimeout(id: string, timeout: RunTimeout): void {
  if (timeout.remainingMs <= 0) {
    void stopContainer(containerName(id));
    return;
  }
  timeout.startedAt = Date.now();
  timeout.handle = setTimeout(() => {
    timeout.handle = null;
    timeout.startedAt = null;
    timeout.remainingMs = 0;
    void stopContainer(containerName(id));
  }, timeout.remainingMs);
  timeout.handle.unref();
}

function pauseTimeout(id: string): void {
  const timeout = runTimeouts.get(id);
  if (!timeout || timeout.handle === null || timeout.startedAt === null) {
    return;
  }
  clearTimeout(timeout.handle);
  timeout.remainingMs = Math.max(0, timeout.remainingMs - (Date.now() - timeout.startedAt));
  timeout.handle = null;
  timeout.startedAt = null;
}

function resumeTimeout(id: string): void {
  const timeout = runTimeouts.get(id);
  if (timeout && timeout.handle === null) {
    armTimeout(id, timeout);
  }
}

function clearTimeoutForRun(id: string): void {
  const timeout = runTimeouts.get(id);
  if (timeout?.handle !== null && timeout?.handle !== undefined) {
    clearTimeout(timeout.handle);
  }
  runTimeouts.delete(id);
}

export async function startGame(config: ValidGameConfig, seedOverride?: string): Promise<GameDetail> {
  const apiKey = deepSeekAPIKey();
  const id = randomUUID();
  const artifactDir = runDirectory(id);
  const inputDir = path.join(artifactDir, "input");
  const outputDir = path.join(artifactDir, "output");
  const dockerArtifactDir = dockerRunDirectory(id);
  const dockerInputDir = path.join(dockerArtifactDir, "input");
  const dockerOutputDir = path.join(dockerArtifactDir, "output");
  await fs.mkdir(inputDir, { recursive: true });
  await fs.mkdir(outputDir, { recursive: true });
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
  const created = createGame(id, config, runSeed, artifactDir);
  const name = containerName(id);
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      "app.werwoelfe.managed=true",
      "--pids-limit",
      "256",
      "--memory",
      "1g",
      "--cpus",
      "1",
      "--mount",
      `type=bind,src=${dockerInputDir},dst=/config,readonly`,
      "--mount",
      `type=bind,src=${dockerOutputDir},dst=/output`,
      "-e",
      "DEEPSEEK_API_KEY",
      environment.gameImage,
      "-config",
      "/config/config.json",
      "-events",
      "/output/events.ndjson",
      "-result",
      "/output/game-result.json",
      "-seed",
      created.seed,
      "-timeout",
      "0",
    ],
    { env: { ...process.env, DEEPSEEK_API_KEY: apiKey }, stdio: ["ignore", "pipe", "pipe"] },
  );
  processes.set(id, child);
  setGameRunning(id);

  const timeout: RunTimeout = {
    handle: null,
    remainingMs: environment.maxRunMinutes * 60_000,
    startedAt: null,
  };
  runTimeouts.set(id, timeout);
  armTimeout(id, timeout);

  child.stdout?.resume();
  child.stderr?.resume();
  child.on("error", async (error) => {
    clearTimeoutForRun(id);
    processes.delete(id);
    failGame(id, `Could not start Docker: ${safeError(error)}`);
  });
  child.on("close", async (code) => {
    clearTimeoutForRun(id);
    processes.delete(id);
    await finalizeProcess(id, code);
  });

  return getGameDetail(id)!;
}

function stopContainer(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["stop", "--time", "10", name], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

function dockerLifecycleCommand(command: "pause" | "unpause", name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", [command, name], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

export async function pauseRunningGame(id: string): Promise<GameDetail> {
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (!markGamePaused(id)) {
    throw new Error("Only running games can be paused.");
  }
  pauseTimeout(id);
  if (!await dockerLifecycleCommand("pause", containerName(id))) {
    markGameRunning(id);
    resumeTimeout(id);
    throw new Error("Could not pause the game container.");
  }
  return getGameDetail(id)!;
}

export async function resumePausedGame(id: string): Promise<GameDetail> {
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (!markGameRunning(id)) {
    throw new Error("Only paused games can be resumed.");
  }
  if (!await dockerLifecycleCommand("unpause", containerName(id))) {
    markGamePaused(id);
    throw new Error("Could not resume the game container.");
  }
  resumeTimeout(id);
  return getGameDetail(id)!;
}

export async function stopGame(id: string): Promise<GameDetail> {
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (!cancelGame(id)) {
    throw new Error("Only queued, running, or paused games can be stopped.");
  }
  clearTimeoutForRun(id);
  if (!await stopContainer(containerName(id))) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await stopContainer(containerName(id));
  }
  await ingestEvents(id);
  return getGameDetail(id)!;
}

export async function restartGame(id: string): Promise<GameDetail> {
  const run = getRunConfiguration(id);
  if (!run) {
    throw new Error("Game not found.");
  }
  if (run.status === "queued" || run.status === "running") {
    await stopGame(id);
  }
  return startGame(run.config as ValidGameConfig);
}

export async function refreshGame(id: string): Promise<GameDetail | null> {
  await ingestEvents(id);
  return getGameDetail(id);
}
