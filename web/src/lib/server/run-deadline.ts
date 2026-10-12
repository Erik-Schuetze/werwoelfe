/**
 * Run deadline arithmetic, and the pausable in-memory timer registry that backs the Docker
 * runtime.
 *
 * Two halves, deliberately kept together because they are the two faces of the same clock:
 *
 *  - `DeadlineState` and the pure functions below are plain arithmetic over an injected `now`.
 *    They hold no timers, touch no fs, and are what the Kubernetes runtime uses to size a Job's
 *    `activeDeadlineSeconds` while honouring an operator pause.
 *  - `arm`/`pause`/`resume`/`clear` are the imperative timer registry (the old
 *    `armTimeout`/`pauseTimeout`/`resumeTimeout`/`clearTimeoutForRun` from `runner.ts`), for the
 *    Docker runtime where the clock is a real `setTimeout`. They read `Date.now()` directly.
 *
 * The invariant that ties them together: a pause must cost the run *nothing*. `extendForPause`
 * at T followed by `resumeDeadline` at T + Δ yields the same `remainingMs` as before — so a run
 * paused for ten minutes still has exactly the budget it had when it was paused.
 *
 * Dependency-free on purpose: no `server-only`, no fs, no Kubernetes client, so `node --test`
 * can import it directly.
 */

export type DeadlineState = {
  /** Wall-clock ms (`Date.now()`-based) at which the run's budget runs out. */
  deadlineAt: number;
  /** Wall-clock ms at which the run was paused, or `null` while the run is live. */
  pausedAt: number | null;
};

/**
 * Milliseconds of budget left at `now`. While paused the clock is frozen at `pausedAt`, so a
 * paused run's remaining time does not tick down.
 */
export function remainingMs(state: DeadlineState, now: number): number {
  return state.deadlineAt - (state.pausedAt ?? now);
}

/**
 * Freeze the deadline clock at `now`. Idempotent: pausing an already-paused clock keeps the
 * original pause instant rather than restarting the freeze.
 */
export function extendForPause(state: DeadlineState, now: number): DeadlineState {
  return { deadlineAt: state.deadlineAt, pausedAt: state.pausedAt ?? now };
}

/**
 * Resume the deadline clock, pushing `deadlineAt` out by however long the pause lasted so the
 * pause costs the run nothing. A no-op when the clock is already running.
 */
export function resumeDeadline(state: DeadlineState, now: number): DeadlineState {
  if (state.pausedAt === null) {
    return state;
  }
  return { deadlineAt: state.deadlineAt + (now - state.pausedAt), pausedAt: null };
}

/** Cushion added to a Job's deadline so the console's own clock wins the race, not the kubelet. */
export const JOB_DEADLINE_CUSHION_MS = 60_000;

/**
 * The `activeDeadlineSeconds` to put on a Kubernetes Job.
 *
 * The Job's clock starts when the Job is created, so the value must be the run's *total* wall
 * time allowance from that instant: the time already elapsed (`now - jobStartMs`) plus the
 * remaining budget, plus a cushion so the console — not the kubelet — is what stops the run.
 * Note that while paused the remaining budget is frozen but the Job's age still grows, so this
 * value grows by exactly the pause duration: the Job's own deadline is extended by the pause
 * too, not just the console's idea of it.
 *
 * Guard: Kubernetes rejects a Job whose `activeDeadlineSeconds` is already in the past, and a
 * Job whose deadline is *shortened* below its current age fails instantly. Re-applying a stale
 * (smaller) value would therefore kill a run that is still fine, so the result is never lower
 * than `currentSeconds` — the value already on the Job, if any. Pass the Job's current
 * `activeDeadlineSeconds` (0 when unset) as the fourth argument to engage the guard.
 */
export function deadlineSecondsForJob(
  state: DeadlineState,
  jobStartMs: number,
  now: number,
  currentSeconds = 0,
): number {
  const jobAgeMs = now - jobStartMs;
  const computedSeconds = Math.ceil(
    (jobAgeMs + remainingMs(state, now) + JOB_DEADLINE_CUSHION_MS) / 1000,
  );
  return Math.max(computedSeconds, currentSeconds);
}

/**
 * In-memory, pausable timeout for a single run. `remainingMs` is the budget left ("wall" time,
 * not wall-clock); `startedAt` is when the current `setTimeout` was armed. `onExpire` is the
 * action taken when the budget runs out — for the Docker runtime, stopping the container.
 */
export type RunTimer = {
  handle: ReturnType<typeof setTimeout> | null;
  remainingMs: number;
  startedAt: number | null;
  onExpire: () => void;
};

declare global {
  var werwoelfeRunTimers: Map<string, RunTimer> | undefined;
}

// HMR-safe singleton, the same `globalThis` idiom the process map and database use: the module
// may be re-evaluated on a dev reload, but the registry must not be.
const runTimers = globalThis.werwoelfeRunTimers ?? new Map<string, RunTimer>();
globalThis.werwoelfeRunTimers = runTimers;

function schedule(timer: RunTimer): void {
  if (timer.remainingMs <= 0) {
    timer.handle = null;
    timer.startedAt = null;
    timer.remainingMs = 0;
    timer.onExpire();
    return;
  }
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => {
    timer.handle = null;
    timer.startedAt = null;
    timer.remainingMs = 0;
    timer.onExpire();
  }, timer.remainingMs);
  // Never let a pending run timer hold the server process alive.
  timer.handle.unref?.();
}

/** Register `timer` under `id` and start (or immediately fire) it. */
export function arm(id: string, timer: RunTimer): void {
  runTimers.set(id, timer);
  schedule(timer);
}

/**
 * Suspend a run's timer, banking the budget consumed so far. A no-op when the timer is unarmed
 * (already paused, already expired, or never registered).
 */
export function pause(id: string): void {
  const timer = runTimers.get(id);
  if (!timer || timer.handle === null || timer.startedAt === null) {
    return;
  }
  clearTimeout(timer.handle);
  timer.remainingMs = Math.max(0, timer.remainingMs - (Date.now() - timer.startedAt));
  timer.handle = null;
  timer.startedAt = null;
}

/** Re-arm a paused run's timer with its banked budget. A no-op unless it is currently paused. */
export function resume(id: string): void {
  const timer = runTimers.get(id);
  if (timer && timer.handle === null) {
    schedule(timer);
  }
}

/** Forget a run's timer entirely (the run finished, was stopped, or failed to start). */
export function clear(id: string): void {
  const timer = runTimers.get(id);
  if (timer?.handle !== null && timer?.handle !== undefined) {
    clearTimeout(timer.handle);
  }
  runTimers.delete(id);
}
