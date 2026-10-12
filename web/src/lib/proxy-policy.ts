/**
 * The read-only gate: which requests the viewer process will answer at all.
 *
 * Every mutating route in this app is unauthenticated and the operator process holds the
 * ServiceAccount that creates game Jobs, so the public viewer must not be able to reach *any* of
 * them. Rather than trying to enumerate the routes that are dangerous, viewer mode allows an
 * explicit, tiny allow-list — `GET` on the audience pages and on the `/api/viewer/*` proxy — and
 * answers **404 to everything else**. A route added later is then private by default instead of
 * exposed by omission, which is the failure mode that matters.
 *
 * This is a gate, not the whole defence: the `notFound()` guards in the pages and the API routes
 * are the second layer, and the operator's `/api/public/*` is a pure read, so public traffic can
 * never drive a write even if this file were wrong.
 *
 * Dependency-free on purpose, so bare `node --test` can load it — `proxy.ts` bundles it.
 */

import type { DeploymentMode } from "@/lib/mode";

export type RequestDecision = { allow: true } | { allow: false; status: 404 | 405 };

/** `/api/viewer` or a path beneath it — the viewer's own proxy to the operator. */
function isViewerApi(pathname: string): boolean {
  return pathname === "/api/viewer" || pathname.startsWith("/api/viewer/");
}

/** The audience index and its game pages. */
function isViewerPage(pathname: string): boolean {
  return pathname === "/viewer" || pathname.startsWith("/viewer/");
}

/**
 * Decide a request in `mode`.
 *
 * In operator mode nothing is gated — the operator's own console is unchanged, and it is reachable
 * only on the LAN. In viewer mode the allow-list above is the entire permitted surface.
 */
export function decideRequest(
  mode: DeploymentMode,
  pathname: string,
  method: string,
): RequestDecision {
  if (mode === "operator") {
    return { allow: true };
  }

  const verb = method.toUpperCase();
  if (isViewerApi(pathname)) {
    // 405, not 404: the path exists and is public, it just does not take that verb. A mutation
    // aimed at the proxy is a client error, not a missing route.
    return verb === "GET" ? { allow: true } : { allow: false, status: 405 };
  }
  if (isViewerPage(pathname)) {
    return verb === "GET" ? { allow: true } : { allow: false, status: 404 };
  }
  return { allow: false, status: 404 };
}
