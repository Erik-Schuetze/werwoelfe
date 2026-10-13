import "server-only";

import { resolvePublicPath } from "@/lib/public-path";
import { assertViewerEnvironment, environment } from "@/lib/server/env";

/**
 * The viewer's only connection to the network: everything it knows about a game comes through here.
 *
 * The viewer holds no database and no ServiceAccount, so it is a proxy in front of the operator's
 * read-only `/api/public/*` API and nothing more. Two consumers share this seam — the server
 * components, which want parsed JSON, and the `/api/viewer/*` routes, which want to hand the
 * operator's response straight back to the browser — so it exposes both shapes over one fetch and
 * one cache.
 *
 * ## Every request is confined to `/api/public/`
 *
 * `resolvePublicPath` is the single choke point every upstream path passes through: it resolves the
 * path against the operator and refuses it unless the *resolved* URL keeps the operator's origin and
 * a `/api/public/` pathname. Resolving is what matters — `new URL` collapses `..` segments while it
 * builds the URL, so a check on the input string would still read `/api/public/…` on the way in
 * while the request went out to `/api/games`. A refused path is turned into a synthetic not-found
 * entry rather than a fetch and is never cached, so it renders as a 404 at both call sites.
 *
 * ## Fail loudly when misconfigured, degrade quietly when the operator is down
 *
 * `assertViewerEnvironment()` runs at the top of both entry points, *outside* any try/catch. A
 * viewer with no `WERWOELFE_OPERATOR_URL` is a deployment bug, and it must surface as a 500 naming
 * the variable rather than as the same "temporarily unavailable" panel the audience sees during a
 * genuine operator outage — retrying never clears a typo.
 *
 * The opposite holds for the operator being unreachable or slow: `AbortSignal.timeout` bounds the
 * call, and a failure becomes `unreachable` (or a 502) instead of an unhandled throw, so one bad
 * operator minute shows a retry panel rather than a wall of 500s.
 *
 * ## The cache
 *
 * The endpoint is internet-facing and unauthenticated, so a crowd of concurrent viewers must not
 * become a crowd of concurrent operator calls. A short `viewerCacheMs` TTL collapses them into one.
 * The key is the **normalised** `url.href`, not the caller's path, so every spelling that resolves
 * to the same resource (`/api/public/./games`, `/api/public/games/../games`, …) shares one entry —
 * keying on the raw path would let an attacker mint unbounded distinct keys for one upstream
 * resource and defeat the cache entirely. Only a healthy (`response.ok`) answer is cached: caching a
 * 500 would pin a transient operator error in front of the audience for the whole TTL, long after it
 * had cleared.
 */

export type OperatorResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: "not-found" | "unreachable" };

/** One operator response, held until `expiresAt` so concurrent viewers can share it. */
type CacheEntry = {
  expiresAt: number;
  status: number;
  body: string;
  contentType: string | null;
};

/** Beyond this the cache is pruned; `viewerCacheMs` alone would let per-game keys accumulate. */
const CACHE_LIMIT = 200;

declare global {
  var werwoelfeOperatorCache: Map<string, CacheEntry> | undefined;
}

/** The process-wide response cache, created once (HMR-safe), like `db.ts`'s database handle. */
function cache(): Map<string, CacheEntry> {
  if (!globalThis.werwoelfeOperatorCache) {
    globalThis.werwoelfeOperatorCache = new Map();
  }
  return globalThis.werwoelfeOperatorCache;
}

/**
 * Store an entry, keeping the map bounded.
 *
 * `viewerCacheMs` stops a *single* path from being fetched repeatedly, but the keys are per game id,
 * so a long-lived pod watching many games would grow the map without limit. When it passes the cap,
 * expired entries go first; if that is not enough, the oldest — which, because a `Map` iterates in
 * insertion order, is simply the first key — is evicted. Everything dropped is reconstructable from
 * the operator, so the eviction order is a performance choice, not a correctness one.
 */
function put(key: string, entry: CacheEntry): void {
  const entries = cache();
  entries.set(key, entry);
  if (entries.size <= CACHE_LIMIT) {
    return;
  }
  const now = Date.now();
  for (const [existingKey, existing] of entries) {
    if (existing.expiresAt <= now) {
      entries.delete(existingKey);
    }
  }
  while (entries.size > CACHE_LIMIT) {
    entries.delete(entries.keys().next().value as string);
  }
}

/**
 * The verdict for a path that escapes `/api/public/`: a 404, shaped like the operator's own.
 *
 * Synthesised rather than fetched, so a refused path never reaches the network. It is a 404 — not a
 * 502 — on purpose: both call sites already treat a 404 as "this resource is not there", so the same
 * `resolvePublicPath` refusal renders as a clean 404 through both (`not-found` for the page, a 404
 * response for the route) instead of the "unavailable, retry" panel an outage would show. It is
 * never inserted into the cache, so a refused path cannot pin an entry.
 */
const REFUSED: CacheEntry = {
  expiresAt: 0,
  status: 404,
  body: JSON.stringify({ error: "Game not found." }),
  contentType: "application/json",
};

/**
 * Fetch `pathname` from the operator, through the cache. `null` means the operator could not be
 * reached at all (timeout, refused connection, DNS); a non-2xx answer still returns its entry, so
 * callers can distinguish "not found" from "unreachable".
 *
 * The path is resolved and confined first, and the cache is keyed on the resolved `url.href`, so
 * every spelling of one resource shares one entry and nothing outside `/api/public/` is ever
 * fetched, cached, or keyed.
 */
async function fetchOperator(pathname: string): Promise<CacheEntry | null> {
  const resolved = resolvePublicPath(environment.operatorUrl, pathname);
  if (!resolved.ok) {
    return REFUSED;
  }
  const key = resolved.url.href;

  const entries = cache();
  const now = Date.now();
  const cached = entries.get(key);
  if (cached && cached.expiresAt > now) {
    return cached;
  }

  let response: Response;
  try {
    response = await fetch(resolved.url, {
      cache: "no-store",
      signal: AbortSignal.timeout(environment.operatorTimeoutMs),
    });
  } catch {
    // A timeout, a refused connection or an unresolvable host are all the same to a viewer: the
    // feed is momentarily gone. The message that reaches the audience is chosen by the caller.
    return null;
  }

  const entry: CacheEntry = {
    expiresAt: now + environment.viewerCacheMs,
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type"),
  };
  if (response.ok) {
    put(key, entry);
  }
  return entry;
}

/**
 * Fetch and parse an operator resource.
 *
 * `not-found` is kept distinct from `unreachable` on purpose: a 404 from the operator is a game that
 * genuinely is not there (or was hidden), which the viewer renders as its own 404, while anything
 * else is an outage the audience should be told to retry. A path `resolvePublicPath` refused lands
 * here too — the synthetic 404 above is indistinguishable from a real one downstream, which is what
 * makes a rejected traversal a clean 404 rather than an outage.
 */
export async function getOperatorJson<T>(path: string): Promise<OperatorResult<T>> {
  assertViewerEnvironment();
  const entry = await fetchOperator(path);
  if (!entry) {
    return { ok: false, reason: "unreachable" };
  }
  if (entry.status === 404) {
    return { ok: false, reason: "not-found" };
  }
  if (entry.status < 200 || entry.status >= 300) {
    return { ok: false, reason: "unreachable" };
  }
  try {
    return { ok: true, data: JSON.parse(entry.body) as T };
  } catch {
    // A 2xx the viewer cannot parse is not a resource it can render; treat it as an outage rather
    // than crashing the page, which keeps one malformed response from taking the whole pod down.
    return { ok: false, reason: "unreachable" };
  }
}

/** Fetch an operator resource and pass its response through, for the `/api/viewer/*` routes. */
export async function proxyOperatorGet(pathname: string): Promise<Response> {
  assertViewerEnvironment();
  const entry = await fetchOperator(pathname);
  if (!entry) {
    return Response.json(
      { error: "The live feed is temporarily unavailable." },
      { status: 502 },
    );
  }
  const headers = new Headers();
  if (entry.contentType) {
    headers.set("content-type", entry.contentType);
  }
  return new Response(entry.body, { status: entry.status, headers });
}
