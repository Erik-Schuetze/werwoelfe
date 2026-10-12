/**
 * The seam between the operator console and whatever physically runs a game.
 *
 * This module is interface plus selector only: no fs, no Kubernetes client, no Docker. The two
 * implementations live in `./runtimes/{docker,kubernetes}.ts` and are owned separately. Keeping
 * the shape here means the console does not care whether a run is a `docker run` child process or
 * a Kubernetes Job — the two differ in how they are started and observed, nothing else.
 *
 * ## Why the selector throws instead of importing the implementations
 *
 * `selectRuntime()` is synchronous by contract (`(): GameRuntime`), and the two files it would
 * name do not exist yet. A static `import` would make `next build` try to resolve them and fail;
 * a dynamic `import("./runtimes/docker")` cannot be awaited from a synchronous function, and
 * even a dead one is resolved by the bundler at build time. So the selector reads a
 * registry that the implementation registers itself into.
 *
 * Wiring: `registerRuntime` is called once, from code that owns the implementations
 * (`instrumentation.ts`), which may `await import("./runtimes/docker")` freely — that is the
 * layer allowed to reference the files. `selectRuntime()` then hands every caller the cached,
 * HMR-safe instance. Until a runtime is registered it throws a message that says exactly what is
 * missing, rather than failing with an obscure `undefined`.
 *
 * Dependency-free on purpose: no `server-only`, so it can be imported outside Next's bundler.
 */

export type StartRunRequest = {
  /** The run's id. Doubles as the container/Job name suffix and the artifact directory name. */
  id: string;
  /** Deterministic RNG seed, carried as a string end to end (a uint64 exceeds float64). */
  seed: string;
  /** The game engine image reference. */
  image: string;
  /** The run's total wall-clock allowance, for a Kubernetes Job's `activeDeadlineSeconds`. */
  activeDeadlineSeconds: number;
};

/** Why a run is no longer active. `missing` covers a Job/container that vanished unexpectedly. */
export type TerminalReason = "completed" | "deadline" | "failed" | "missing";

export type RunObservation =
  | { state: "active" }
  | { state: "terminal"; exitCode: number | null; reason: TerminalReason };

export interface GameRuntime {
  readonly kind: "docker" | "kubernetes";
  /** Launch a run. Returns once the run has been created, not once it finishes. */
  startRun(request: StartRunRequest): Promise<void>;
  /** Stop a run, giving it the same grace period as today's `docker stop --time 10`. */
  stopRun(id: string): Promise<void>;
  /** Observe a run's current state. Cheap enough to poll. */
  observeRun(id: string): Promise<RunObservation>;
  /** Pause or resume a run: the container pause/unpause, or the control file plus the clock. */
  setPaused(id: string, paused: boolean): Promise<void>;
  /** Re-apply a run's Kubernetes Job deadline (no-op for a runtime without one). */
  setJobDeadline(id: string, activeDeadlineSeconds: number): Promise<void>;
  /** Host path holding every run's artifacts. */
  runRoot(): string;
}

export type RuntimeKind = GameRuntime["kind"];

declare global {
  var werwoelfeRuntime: GameRuntime | undefined;
}

/**
 * The runtime kind this process should use: an explicit `WERWOELFE_RUNTIME`, else the presence
 * of a Kubernetes service-account environment (running in-cluster), else Docker.
 */
export function runtimeKind(): RuntimeKind {
  const configured = process.env.WERWOELFE_RUNTIME?.trim();
  if (configured) {
    if (configured !== "docker" && configured !== "kubernetes") {
      throw new Error(`WERWOELFE_RUNTIME must be "docker" or "kubernetes", not "${configured}".`);
    }
    return configured;
  }
  return process.env.KUBERNETES_SERVICE_HOST ? "kubernetes" : "docker";
}

/** Install the process-wide runtime instance. Called once, by whoever owns the implementations. */
export function registerRuntime(runtime: GameRuntime): GameRuntime {
  globalThis.werwoelfeRuntime = runtime;
  return runtime;
}

/** The process-wide runtime, cached the first time it is registered (HMR-safe). */
export function selectRuntime(): GameRuntime {
  const runtime = globalThis.werwoelfeRuntime;
  if (runtime) {
    return runtime;
  }
  const kind = runtimeKind();
  throw new Error(
    `The ${kind} game runtime has not been registered yet. ` +
      `Call registerRuntime() with the ./runtimes/${kind} implementation during server startup ` +
      `(see src/instrumentation.ts) before any run is started.`,
  );
}
