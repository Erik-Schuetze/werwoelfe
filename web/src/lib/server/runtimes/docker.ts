/**
 * The Docker runtime: one `docker run` per game, for local development.
 *
 * This is the near-verbatim port of the process model that used to live in `runner.ts`. What
 * changed is *who watches the run*: there is no longer a `ChildProcess` handle the console keeps
 * so it can hear about `close`. Instead the run is a detached-ish `docker run` whose completion
 * the console discovers by polling `docker inspect` — so `observeRun` is the single source of
 * truth, and the same poller drives both runtimes.
 *
 * The child process is still kept (unref'd, with its output discarded) for one reason: it is the
 * only place a real exit code is available. `--rm` removes the container the instant it exits, so
 * `docker inspect` afterwards reports "no such object"; the code the child reports on `close` is
 * recorded and handed out by `observeRun` while it is fresh. After a console restart that record
 * is gone, and the run is reported `missing` — which is safe, because `finalizeRun` ingests the
 * event stream (a real result on the PVC) before it acts on any verdict.
 *
 * Pausing is the control file, never `docker pause`: both runtimes must exercise one pause
 * mechanism, and a frozen-by-the-kernel container is invisible to the engine's cooperative pause.
 */
import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { writeControlFile } from "@/lib/server/control-file";
import { deepSeekAPIKey, environment } from "@/lib/server/env";
import type { GameRuntime, RunObservation, StartRunRequest } from "@/lib/server/runtime";

declare global {
  var werwoelfeDockerChildren: Map<string, ChildProcess> | undefined;
  var werwoelfeDockerExitCodes: Map<string, number | null> | undefined;
}

// HMR-safe, the house idiom: a dev reload may re-evaluate this module but must not orphan a
// running container or forget an exit code that is still owed to the poller.
const children = globalThis.werwoelfeDockerChildren ?? new Map<string, ChildProcess>();
globalThis.werwoelfeDockerChildren = children;
const exitCodes = globalThis.werwoelfeDockerExitCodes ?? new Map<string, number | null>();
globalThis.werwoelfeDockerExitCodes = exitCodes;

function containerName(id: string): string {
  return `werwoelfe-${id}`;
}

/** The host path Docker mounts for a run: the *docker-visible* root, which may differ from the
 * console's own `dataDir` when the console itself runs in a container. */
function dockerRunDirectory(id: string): string {
  return path.join(environment.dockerDataDir, "runs", id);
}

/** The control directory the console writes into. In both real configurations this is the same
 * host directory Docker mounts at `/control`, reached under the console's own data root. */
function runControlDir(id: string): string {
  return path.join(environment.dataDir, "runs", id, "control");
}

type Command = { code: number | null; stdout: string; stderr: string };

function runDocker(args: string[]): Promise<Command> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export const dockerRuntime: GameRuntime = {
  kind: "docker",

  async startRun(request: StartRunRequest): Promise<void> {
    const apiKey = deepSeekAPIKey();
    const dir = dockerRunDirectory(request.id);
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--name",
        containerName(request.id),
        "--label",
        "app.werwoelfe.managed=true",
        // Docker-only hardening. There is deliberately no Kubernetes equivalent: the only
        // per-pod PID limit is the node-wide kubelet `podPidsLimit`, which cannot be set per Job.
        // That is acceptable there — the engine image is a fixed static Go binary with no shell
        // and no interpreter, so there is no fork-bomb surface for a PID cap to defend against.
        "--pids-limit",
        "256",
        "--memory",
        "1g",
        "--cpus",
        "1",
        "--mount",
        `type=bind,src=${path.join(dir, "input")},dst=/config,readonly`,
        "--mount",
        `type=bind,src=${path.join(dir, "output")},dst=/output`,
        "--mount",
        `type=bind,src=${path.join(dir, "control")},dst=/control`,
        "-e",
        "DEEPSEEK_API_KEY",
        request.image,
        "-config",
        "/config/config.json",
        "-events",
        "/output/events.ndjson",
        "-result",
        "/output/game-result.json",
        "-seed",
        request.seed,
        "-timeout",
        "0",
        "-control",
        "/control/control.json",
      ],
      { env: { ...process.env, DEEPSEEK_API_KEY: apiKey }, stdio: "ignore" },
    );

    children.set(request.id, child);
    child.once("close", (code) => {
      children.delete(request.id);
      exitCodes.set(request.id, code);
    });

    // Resolve once the CLI has actually started (or failed to): a missing `docker` binary must
    // surface as a thrown startRun, not as a run that silently never begins.
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => resolve());
    });
    // The container outlives this process; do not let it hold the server's event loop open.
    child.unref();
  },

  async stopRun(id: string): Promise<void> {
    const result = await runDocker(["stop", "--time", "10", containerName(id)]);
    if (result.code !== 0) {
      const message = result.stderr.trim() || "docker stop failed";
      // A container that has already gone is not an error: the run is simply over.
      if (/No such container/i.test(message)) {
        return;
      }
      throw new Error(message);
    }
  },

  async observeRun(id: string): Promise<RunObservation> {
    const recorded = exitCodes.get(id);
    if (recorded !== undefined) {
      return terminalFromExitCode(recorded);
    }

    const result = await runDocker([
      "inspect",
      "--format",
      "{{.State.Status}} {{.State.ExitCode}}",
      containerName(id),
    ]);
    // Absent container, or `docker inspect` itself failing: either way the run is not here. A
    // console that restarted mid-run has no exit code record and lands here for a run that has
    // since finished and been removed by `--rm`; finalizeRun ingests the event stream first.
    if (result.code !== 0) {
      return { state: "terminal", exitCode: null, reason: "missing" };
    }
    const [status, exitCodeText] = result.stdout.trim().split(/\s+/);
    if (status === "running" || status === "paused" || status === "created" || status === "restarting") {
      return { state: "active" };
    }
    if (status === "exited") {
      const exitCode = Number(exitCodeText);
      return terminalFromExitCode(Number.isFinite(exitCode) ? exitCode : null);
    }
    // "dead", "removing", or anything unexpected: there is no verdict to read.
    return { state: "terminal", exitCode: null, reason: "missing" };
  },

  async setPaused(id: string, paused: boolean): Promise<void> {
    await writeControlFile(runControlDir(id), paused);
  },

  async setJobDeadline(): Promise<void> {
    // Docker has no Job and no server-enforced deadline; the console's own timer is the limit.
  },

  runRoot(): string {
    return environment.dockerDataDir;
  },
};

function terminalFromExitCode(exitCode: number | null): RunObservation {
  return {
    state: "terminal",
    exitCode,
    reason: exitCode === 0 ? "completed" : "failed",
  };
}
