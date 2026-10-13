/**
 * The viewer's confinement to the operator's public API: one function that turns a path into the
 * single resource the viewer is allowed to name.
 *
 * The viewer is a proxy in front of the operator's read-only `/api/public/*` API and nothing more,
 * so every upstream path must be confined to that prefix. The subtlety — and the reason this is a
 * separate, tested module rather than two lines inside `operator-client.ts` — is that `new URL`
 * *normalises* the path while resolving it: `/api/public/games/../../../api/games` collapses to
 * `/api/games`. A check on the *input* string therefore proves nothing, because a traversal is still
 * textually inside `/api/public/` right up until the instant it is not. The check must run on the
 * **resolved** `url.pathname`, after normalisation has already happened.
 *
 * That is exactly the defect this replaces: the route param was interpolated raw and `new URL`
 * quietly collapsed the traversal, so `/api/viewer/games/..%2f..%2f..%2f..%2fapi%2fgames` reached the
 * operator's unfiltered `/api/games` (and `/api/games/<id>`, which writes).
 *
 * A second escape exists that `new URL` does *not* normalise away: a percent-encoded separator
 * (`%2f`) survives resolution as literal text. `/api/public/games/..%2f..%2fapi%2fgames` therefore
 * still reads as `/api/public/…` here and is only re-interpreted as a traversal by the upstream
 * server that decodes it. The resolved pathname is refused for that too, along with an embedded
 * backslash, which some servers also treat as a separator.
 *
 * Dependency-free on purpose — no `server-only`, no Next import, no module-scope environment read —
 * so bare `node --test` can load it, the same doctrine as `./mode.ts` and `./proxy-policy.ts`.
 */

/** The one prefix the viewer may ever request from the operator. */
const PUBLIC_PREFIX = "/api/public/";

/**
 * The absolute URL `pathname` names against `operatorUrl`, or `ok: false` when it escapes the public
 * API.
 *
 * `ok: false` is returned, never thrown: a refused path is ordinary untrusted input, and the caller
 * renders it as a 404 rather than letting it become a 500.
 */
export function resolvePublicPath(
  operatorUrl: string,
  pathname: string,
): { ok: true; url: URL } | { ok: false } {
  let base: URL;
  let url: URL;
  try {
    base = new URL(operatorUrl);
    url = new URL(pathname, base);
  } catch {
    // An unparseable operator URL (empty, or not absolute) or an unparseable pathname. The entry
    // points assert the environment before reaching here, so this is belt-and-braces rather than
    // the misconfiguration path — but a refusal is still the right answer for it.
    return { ok: false };
  }

  // Defence in depth against an authority escape: a scheme-relative (`//host/x`) or absolute
  // pathname resolves against its own authority, not the operator's.
  if (url.origin !== base.origin) {
    return { ok: false };
  }

  // The whole point: this is the pathname *after* `new URL` collapsed its `.` and `..` segments, so
  // a traversal that climbed out of `/api/public/` no longer reads as though it were inside it.
  if (!url.pathname.startsWith(PUBLIC_PREFIX)) {
    return { ok: false };
  }

  // An encoded separator (`%2f`) or a backslash is not normalised away above, so it would reach the
  // upstream as literal text and could be decoded there into the very traversal this module exists
  // to stop. A real public resource is `/api/public/games` or `/api/public/games/<uuid>`; neither
  // contains one, so nothing legitimate is refused.
  if (/%2f|\\/i.test(url.pathname)) {
    return { ok: false };
  }

  return { ok: true, url };
}
