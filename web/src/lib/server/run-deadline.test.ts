import assert from "node:assert/strict";
import { test } from "node:test";

import {
  arm,
  clear,
  deadlineSecondsForJob,
  type DeadlineState,
  extendForPause,
  pause,
  remainingMs,
  resume,
  resumeDeadline,
  type RunTimer,
} from "./run-deadline.ts";

test("remainingMs decreases linearly with the clock", () => {
  const state: DeadlineState = { deadlineAt: 1_000_000, pausedAt: null };
  assert.equal(remainingMs(state, 0), 1_000_000);
  assert.equal(remainingMs(state, 250_000), 750_000);
  assert.equal(remainingMs(state, 750_000), 250_000);
  assert.equal(remainingMs(state, 1_000_000), 0);
  assert.equal(remainingMs(state, 1_250_000), -250_000);
});

test("a 600s pause costs the run nothing", () => {
  const start: DeadlineState = { deadlineAt: 1_000_000, pausedAt: null };
  const before = remainingMs(start, 400_000);

  const paused = extendForPause(start, 400_000);
  const resumed = resumeDeadline(paused, 400_000 + 600_000);

  // The whole point: a ten-minute pause leaves the run exactly the budget it had.
  assert.equal(before, 600_000);
  assert.equal(remainingMs(resumed, 400_000 + 600_000), before);
  assert.equal(remainingMs(resumed, 1_000_000), before);
});

test("remainingMs is frozen while paused", () => {
  const paused: DeadlineState = { deadlineAt: 1_000_000, pausedAt: 400_000 };
  assert.equal(remainingMs(paused, 400_000), 600_000);
  assert.equal(remainingMs(paused, 700_000), 600_000);
  assert.equal(remainingMs(paused, 1_400_000), 600_000);
});

test("extendForPause is idempotent and resumeDeadline is a no-op when running", () => {
  const running: DeadlineState = { deadlineAt: 1_000_000, pausedAt: null };
  const once = extendForPause(running, 100);
  const twice = extendForPause(once, 900);
  assert.deepEqual(twice, once); // re-pausing keeps the original pause instant
  assert.deepEqual(resumeDeadline(running, 5_000), running);
});

test("deadlineSecondsForJob is the job age plus the remaining budget plus 60s", () => {
  // Job created at t=0; it is now t=1000ms; the run's deadline is t=10_000_000ms.
  const state: DeadlineState = { deadlineAt: 10_000_000, pausedAt: null };
  // age 1_000 + remaining 9_999_000 + cushion 60_000 = 10_060_000ms -> 10_060 whole seconds.
  assert.equal(deadlineSecondsForJob(state, 0, 1_000), 10_060);
});

test("deadlineSecondsForJob never returns less than the Job already carries", () => {
  // computed = age 4_000 + remaining 1_000 + cushion 60_000 = 65_000ms -> 65s
  const state: DeadlineState = { deadlineAt: 5_000, pausedAt: null };
  assert.equal(deadlineSecondsForJob(state, 0, 4_000), 65);
  assert.equal(deadlineSecondsForJob(state, 0, 4_000, 0), 65);
  // A Job already carrying a *larger* deadline must keep it: a lower value would fail instantly.
  assert.equal(deadlineSecondsForJob(state, 0, 4_000, 300), 300);
  assert.equal(deadlineSecondsForJob(state, 0, 4_000, 65), 65);
});

test("a pause extends the Job deadline by exactly the pause duration", () => {
  const state: DeadlineState = { deadlineAt: 5_000_000, pausedAt: null };
  const paused = extendForPause(state, 1_000_000);
  const resumed = resumeDeadline(paused, 1_600_000);

  // Once resumed, the Job deadline no longer depends on when we ask, only on how long we paused.
  assert.equal(
    deadlineSecondsForJob(resumed, 0, 1_600_000),
    deadlineSecondsForJob(resumed, 0, 1_700_000),
  );
  assert.equal(deadlineSecondsForJob(resumed, 0, 1_600_000), 5_660);
});

test("the timer registry banks and restores a run's budget across a pause", (t) => {
  t.mock.timers.enable({ apis: ["Date"] });
  t.mock.timers.setTime(0);

  let fired = 0;
  const timer: RunTimer = {
    handle: null,
    remainingMs: 600_000,
    startedAt: null,
    onExpire: () => {
      fired += 1;
    },
  };

  arm("run-1", timer);
  assert.notEqual(timer.handle, null);
  assert.equal(timer.startedAt, 0);

  // 120s of the 600s budget elapses, then the operator pauses.
  t.mock.timers.setTime(120_000);
  pause("run-1");
  assert.equal(timer.handle, null);
  assert.equal(timer.remainingMs, 480_000);

  // Ten minutes pass while paused; the budget is untouched.
  t.mock.timers.setTime(720_000);
  assert.equal(timer.remainingMs, 480_000);

  // Resuming re-arms with the banked budget, and the clock restarts from now.
  resume("run-1");
  assert.notEqual(timer.handle, null);
  assert.equal(timer.startedAt, 720_000);
  assert.equal(timer.remainingMs, 480_000);
  assert.equal(fired, 0);

  clear("run-1");
});

test("clear forgets a run's timer and pause/resume are no-ops on an unknown run", () => {
  assert.doesNotThrow(() => {
    pause("never-armed");
    resume("never-armed");
    clear("never-armed");
  });
});
