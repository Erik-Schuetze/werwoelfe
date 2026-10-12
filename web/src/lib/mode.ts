/**
 * Which half of the console this process is.
 *
 * One image serves two deployments, and the difference between them is the whole security story:
 * the operator holds the Kubernetes ServiceAccount, the SQLite file and the run directory, while
 * the public viewer holds none of them and is only a proxy in front of the operator's read-only
 * `/api/public/*` API. So the mode decides whether a process registers a game runtime at all
 * (`instrumentation.ts`), which routes exist (`proxy.ts`, the `notFound()` guards) and which API
 * surfaces answer.
 *
 * Dependency-free on purpose: no `server-only`, no Next import, and no module-scope environment
 * read, so bare `node --test` can load it — the same doctrine as `./server/runtime.ts`. The value
 * is read per call, not once at import, so the Node-runtime proxy can consult the live
 * environment on every request.
 */

export type DeploymentMode = "operator" | "viewer";

/**
 * Parse `WERWOELFE_MODE`.
 *
 * Absent, empty and `"operator"` all mean operator, because that is the default this process has
 * always been. Anything that is not `"viewer"` *throws* rather than falling back: a typo
 * (`WERWOELFE_MODE=public`) must fail the pod loudly. Silently defaulting an intended public
 * deployment to operator would stand up the privileged half of the console behind an
 * internet-facing hostname.
 */
export function parseDeploymentMode(value: string | undefined): DeploymentMode {
  const configured = value?.trim();
  if (!configured || configured === "operator") {
    return "operator";
  }
  if (configured === "viewer") {
    return "viewer";
  }
  throw new Error(`WERWOELFE_MODE must be "operator" or "viewer", not "${configured}".`);
}

/** The mode of this process, from `WERWOELFE_MODE`. */
export function deploymentMode(): DeploymentMode {
  return parseDeploymentMode(process.env.WERWOELFE_MODE);
}

export function isViewerMode(): boolean {
  return deploymentMode() === "viewer";
}

export function isOperatorMode(): boolean {
  return deploymentMode() === "operator";
}
