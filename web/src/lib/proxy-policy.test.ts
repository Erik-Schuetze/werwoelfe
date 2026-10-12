import assert from "node:assert/strict";
import { test } from "node:test";

import type { DeploymentMode } from "./mode.ts";
import { decideRequest } from "./proxy-policy.ts";

/** The status a request is denied with, failing loudly if it was allowed instead. */
function denialStatus(mode: DeploymentMode, method: string, pathname: string): number {
  const decision = decideRequest(mode, pathname, method);
  if (decision.allow) {
    assert.fail(`expected ${method} ${pathname} to be denied in ${mode} mode`);
  }
  return decision.status;
}

function isAllowed(mode: DeploymentMode, method: string, pathname: string): boolean {
  return decideRequest(mode, pathname, method).allow;
}

test("viewer mode 404s every operator route", () => {
  assert.equal(denialStatus("viewer", "GET", "/"), 404);
  assert.equal(denialStatus("viewer", "GET", "/games/abc"), 404);
  assert.equal(denialStatus("viewer", "GET", "/api/games"), 404);
  assert.equal(denialStatus("viewer", "POST", "/api/games"), 404);
  assert.equal(denialStatus("viewer", "DELETE", "/api/games/abc"), 404);
  assert.equal(denialStatus("viewer", "PATCH", "/api/games/abc"), 404);
  assert.equal(denialStatus("viewer", "POST", "/api/games/abc"), 404);
  // The operator's own read API stays on the operator; the viewer proxies it instead.
  assert.equal(denialStatus("viewer", "GET", "/api/public/games"), 404);
  assert.equal(denialStatus("viewer", "GET", "/api/public/games/abc"), 404);
});

test("viewer mode answers 405 to a mutation aimed at its own read proxy", () => {
  assert.equal(denialStatus("viewer", "POST", "/api/viewer/games"), 405);
  assert.equal(denialStatus("viewer", "DELETE", "/api/viewer/games/abc"), 405);
  assert.equal(denialStatus("viewer", "PATCH", "/api/viewer/health"), 405);
  assert.equal(denialStatus("viewer", "PUT", "/api/viewer"), 405);
});

test("viewer mode allows exactly the audience surface", () => {
  assert.equal(isAllowed("viewer", "GET", "/viewer"), true);
  assert.equal(isAllowed("viewer", "GET", "/viewer/"), true);
  assert.equal(isAllowed("viewer", "GET", "/viewer/games/abc"), true);
  assert.equal(isAllowed("viewer", "GET", "/api/viewer"), true);
  assert.equal(isAllowed("viewer", "GET", "/api/viewer/games"), true);
  assert.equal(isAllowed("viewer", "GET", "/api/viewer/games/abc"), true);
  assert.equal(isAllowed("viewer", "GET", "/api/viewer/health"), true);
});

test("viewer mode 404s a non-GET aimed at an audience page", () => {
  assert.equal(denialStatus("viewer", "POST", "/viewer"), 404);
});

test("operator mode gates nothing", () => {
  const paths = ["/", "/games/abc", "/api/games", "/api/games/abc", "/api/public/games", "/viewer"];
  for (const pathname of paths) {
    assert.equal(isAllowed("operator", "GET", pathname), true);
    assert.equal(isAllowed("operator", "POST", pathname), true);
    assert.equal(isAllowed("operator", "DELETE", pathname), true);
  }
});
