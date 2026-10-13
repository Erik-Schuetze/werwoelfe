import assert from "node:assert/strict";
import { test } from "node:test";

import { resolvePublicPath } from "./public-path.ts";

const OPERATOR = "http://werwoelfe-operator.werwoelfe.svc.cluster.local:3000";
const OTHER_ORIGIN = "https://werwoelfe-operator.werwoelfe.svc.cluster.local:3000";
const GAME_ID = "123e4567-e89b-42d3-a456-426614174000";

/** The resolved href, failing loudly if the path was refused. */
function href(pathname: string, operatorUrl: string = OPERATOR): string {
  const resolved = resolvePublicPath(operatorUrl, pathname);
  if (!resolved.ok) {
    assert.fail(`expected ${pathname} to resolve against ${operatorUrl}`);
  }
  return resolved.url.href;
}

function refused(pathname: string, operatorUrl: string = OPERATOR): boolean {
  return !resolvePublicPath(operatorUrl, pathname).ok;
}

test("accepts the two paths the viewer actually builds", () => {
  assert.equal(href("/api/public/games"), `${OPERATOR}/api/public/games`);
  assert.equal(href(`/api/public/games/${GAME_ID}`), `${OPERATOR}/api/public/games/${GAME_ID}`);
});

test("rejects the traversal that Next decodes the route param into", () => {
  // The vulnerability, mechanically: `new URL` collapses the `..` segments while it resolves, so the
  // request that leaves this process is `/api/games` — outside `/api/public/`. The guard must judge
  // the *resolved* pathname, which is precisely what makes this a refusal. The first assertion pins
  // the collapse itself, so this test fails if `new URL` ever stops normalising.
  assert.equal(
    new URL("/api/public/games/../../../../api/games", OPERATOR).pathname,
    "/api/games",
    "the collapse this fix exists to defeat must still be observable",
  );
  assert.equal(refused("/api/public/games/../../../../api/games"), true);
});

test("rejects the same traversal while it is still percent-encoded", () => {
  // Two more spellings of one attack. `new URL` does NOT normalise an encoded separator, so these
  // reach the resolver with their `/api/public/` prefix intact — the case the id check in each route
  // handler is the primary gate against. The resolver refuses them too, on the resolved pathname
  // (the retained `%2f`), so a caller that skips the id check is still confined.
  assert.equal(refused("/api/public/games/..%2f..%2f..%2f..%2fapi%2fgames"), true);
  assert.equal(refused("/api/public/games/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fapi%2fgames"), true);
  // Proof that a bare prefix check would have let these through: after resolution they still read as
  // `/api/public/…`, so only an explicit encoded-separator guard (or the id check) stops them.
  const encoded = new URL("/api/public/games/..%2f..%2fapi%2fgames", OPERATOR);
  assert.equal(encoded.pathname.startsWith("/api/public/"), true);
});

test("rejects an authority escape and a path that resolves to the root", () => {
  assert.equal(refused("//evil.example/x"), true);
  assert.equal(refused("http://evil.example/x"), true);
  // Same host and path but a different scheme is a different origin, and so is refused.
  assert.equal(refused(`${OTHER_ORIGIN}/api/public/games`), true);
  assert.equal(refused("/"), true);
  assert.equal(refused("/api/public/games/../../../.."), true);
});

test("distinct spellings of one resource share one resolved URL", () => {
  // The cache-bypass regression: the old fetch keyed its cache on the raw pathname, so each spelling
  // minted a fresh entry for the same operator resource and the TTL never coalesced them. Keyed on
  // the resolved href, they collapse to a single entry.
  assert.equal(href("/api/public/./games"), href("/api/public/games"));
  assert.equal(href("/api/public/games/../games"), href("/api/public/games"));
  assert.equal(href("/api/public/games/./../games"), href("/api/public/games"));
});

test("an unparseable pathname or operator URL is refused, not thrown", () => {
  assert.equal(refused("/api/public/games", ""), true);
  assert.equal(refused("not-a-url", "not-a-url"), true);
});
