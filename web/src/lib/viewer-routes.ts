/**
 * Where a run lives, in either mode.
 *
 * The viewer serves the same shape of page as the operator but under `/viewer`, and proxies its
 * data through `/api/viewer/*` instead of reading SQLite. Server components and the client
 * `GameDetail`/`AudienceIndex` components both need to build those paths, so the mapping lives here
 * once rather than being re-derived at each call site.
 *
 * Dependency-free (a type import only), safe on both sides of the client boundary.
 */

import type { DeploymentMode } from "@/lib/mode";

/** The mode's run index. */
export function homePath(mode: DeploymentMode): string {
  return mode === "viewer" ? "/viewer" : "/";
}

/** The mode's page for one run. */
export function gamePath(mode: DeploymentMode, id: string): string {
  return mode === "viewer" ? `/viewer/games/${id}` : `/games/${id}`;
}

/** The mode's list endpoint. */
export function gamesApiPath(mode: DeploymentMode): string {
  return mode === "viewer" ? "/api/viewer/games" : "/api/games";
}

/** The mode's single-run endpoint. */
export function gameApiPath(mode: DeploymentMode, id: string): string {
  return mode === "viewer" ? `/api/viewer/games/${id}` : `/api/games/${id}`;
}
