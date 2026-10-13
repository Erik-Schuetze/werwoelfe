import assert from "node:assert/strict";
import { test } from "node:test";

import { isGameId } from "./game-id.ts";

/** A real id: the exact shape `randomUUID()` writes in `server/runner.ts`. */
const REAL_ID = "123e4567-e89b-42d3-a456-426614174000";

test("accepts a canonical UUID, upper- or lower-case", () => {
  assert.equal(isGameId(REAL_ID), true);
  assert.equal(isGameId(REAL_ID.toUpperCase()), true);
});

test("rejects a traversal, decoded or still percent-encoded", () => {
  assert.equal(isGameId("../../x"), false);
  assert.equal(isGameId("..%2f..%2fx"), false);
  // The double-encoded form Next hands this process after its single decode of the route param.
  assert.equal(isGameId("%2e%2e%2f%2e%2e%2fx"), false);
  assert.equal(isGameId(".."), false);
  assert.equal(isGameId("/api/games"), false);
  assert.equal(isGameId("a\\b"), false);
});

test("rejects an empty or whitespace-padded id", () => {
  assert.equal(isGameId(""), false);
  assert.equal(isGameId(" "), false);
  assert.equal(isGameId(`${REAL_ID} `), false);
  assert.equal(isGameId(` ${REAL_ID}`), false);
});

test("rejects a value that merely contains a UUID", () => {
  // The anchoring is load-bearing: without it each of these would pass by containment.
  assert.equal(isGameId(`${REAL_ID}/../..`), false);
  assert.equal(isGameId(`x${REAL_ID}`), false);
  assert.equal(isGameId(`${REAL_ID}x`), false);
});
