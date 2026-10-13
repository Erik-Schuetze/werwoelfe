/**
 * What a game id is, and how to recognise one.
 *
 * A run's id is generated in exactly one place — `randomUUID()` in `./server/runner.ts` — and it is
 * used verbatim as the `games.id` primary key, the run directory name (`data/runs/<id>`), the
 * Kubernetes Job name suffix, and the URL segment of the operator's `/api/public/games/<id>`. So
 * every real id is a canonical UUID: `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
 *
 * This is the primary defence against the path-traversal this module's sibling `./public-path.ts`
 * also guards, and it exists for a reason that a prefix check alone cannot cover. The id is
 * untrusted, internet-supplied input that gets interpolated into an upstream path. `resolvePublicPath`
 * confines every request to `/api/public/` by inspecting the *resolved* URL, but Next.js decodes the
 * route parameter exactly once, so a double-encoded payload (`%252e%252e%252f…`) arrives here still
 * containing `%2e%2e%2f` — an escape `new URL` does not normalise away. A strict, exact-shape id
 * check refuses it before any upstream path is built at all, and turns a refused proxy into a plain
 * 404 rather than an attempt the proxy layer has to survive.
 *
 * Dependency-free on purpose — no `server-only`, no Next import, no module-scope environment read —
 * so bare `node --test` can load it, the same doctrine as `./mode.ts` and `./public-path.ts`.
 */

/**
 * A canonical UUID, anchored: the shape `randomUUID()` emits and nothing else.
 *
 * The anchors are load-bearing. Without them a value like `..%2f..%2fapi%2fgames` would only have to
 * *contain* a UUID-shaped run somewhere to pass. `[0-9a-f]` excludes `%`, `.`, `/`, `\` and
 * whitespace by construction, so a traversal, an encoded escape (single- or double-encoded), and an
 * empty string all fail the same check. Matching is case-insensitive because a UUID is
 * conventionally case-insensitive; `randomUUID()` itself emits lower-case, and an upper-case
 * spelling of a real id still resolves to the same row through the operator's exact lookup.
 */
export function isGameId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
