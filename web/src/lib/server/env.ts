import "server-only";

import path from "node:path";

import { deploymentMode } from "@/lib/mode";

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("Environment value must be a positive integer.");
  }
  return parsed;
}

function gameImage(value: string | undefined): string {
  const image = value || "werwoelfe-game:local";
  if (!/^[a-zA-Z0-9._/:@-]+$/.test(image)) {
    throw new Error("WERWOELFE_GAME_IMAGE contains unsupported characters.");
  }
  return image;
}

/**
 * The runtime this process should use, or `undefined` to auto-detect.
 *
 * `runtimeKind()` in `./runtime.ts` is the authority on the *effective* kind (it also consults
 * `KUBERNETES_SERVICE_HOST`); this value is the raw, validated override so other modules can read
 * the operator's intent without re-parsing the environment.
 */
function runtime(value: string | undefined): "docker" | "kubernetes" | undefined {
  const configured = value?.trim();
  if (!configured) {
    return undefined;
  }
  if (configured !== "docker" && configured !== "kubernetes") {
    throw new Error(`WERWOELFE_RUNTIME must be "docker" or "kubernetes", not "${configured}".`);
  }
  return configured;
}

const dataDir = path.resolve(/* turbopackIgnore: true */ process.env.WERWOELFE_DATA_DIR || path.join(process.cwd(), "data"));

export const environment = {
  dataDir,
  dockerDataDir: path.resolve(/* turbopackIgnore: true */ process.env.WERWOELFE_DOCKER_DATA_DIR || dataDir),
  gameImage: gameImage(process.env.WERWOELFE_GAME_IMAGE),
  maxConcurrentRuns: positiveInteger(process.env.WERWOELFE_MAX_CONCURRENT_RUNS, 1),
  maxRunMinutes: positiveInteger(process.env.WERWOELFE_MAX_RUN_MINUTES, 30),

  // Which game runtime to use; `undefined` means "detect" (see `runtimeKind()`).
  runtime: runtime(process.env.WERWOELFE_RUNTIME),
  // The namespace the console's game Jobs are created in. The in-cluster Deployment sets
  // WERWOELFE_NAMESPACE from the downward API, with POD_NAMESPACE as the documented fallback.
  namespace: process.env.WERWOELFE_NAMESPACE?.trim() || process.env.POD_NAMESPACE?.trim() || "default",
  // The node the console runs on, from the downward API (`spec.nodeName`). The run's PVC is
  // Longhorn RWO — single-attach — so every game Job must be pinned to this node.
  nodeName: process.env.POD_NODE_NAME?.trim() || "",
  // The PVC holding `runs/<id>/{input,output,control}`.
  pvcName: process.env.WERWOELFE_PVC_NAME?.trim() || "",
  // The Secret the game pod reads DEEPSEEK_API_KEY from. The console never reads it: it is
  // mounted into the pod with `secretKeyRef`, so the key never passes through this process.
  deepseekSecret: process.env.WERWOELFE_DEEPSEEK_SECRET?.trim() || "werwoelfe-secrets",
  deepseekSecretKey: process.env.WERWOELFE_DEEPSEEK_SECRET_KEY?.trim() || "DEEPSEEK_API_KEY",

  // How long a finished Job (and its pod logs) is kept for post-mortem debugging.
  jobTTLSeconds: positiveInteger(process.env.WERWOELFE_JOB_TTL_SECONDS, 3600),
  // How often the poller joins the cluster's Jobs against the console's non-terminal games.
  pollSeconds: positiveInteger(process.env.WERWOELFE_POLL_SECONDS, 5),
  // Every Kubernetes API call is bounded by this, so a hung apiserver cannot wedge a request.
  kubeTimeoutMs: positiveInteger(process.env.WERWOELFE_KUBE_TIMEOUT_MS, 10000),

  // Which half of the console this process is. Read per call, not frozen here, so the Node-runtime
  // proxy sees the live value on every request.
  mode: deploymentMode(),
  // The operator this viewer proxies. Empty is the operator's own (and every build's) value: the
  // viewer is the only process that ever reads it, and it is validated at use, not here — see
  // `assertViewerEnvironment`.
  operatorUrl: process.env.WERWOELFE_OPERATOR_URL?.trim() || "",
  // Bound on every call the viewer makes to the operator, so a hung one cannot wedge a page.
  operatorTimeoutMs: positiveInteger(process.env.WERWOELFE_OPERATOR_TIMEOUT_MS, 5000),
  // How often the viewer's pages re-poll for a live game. The operator's own 1.5s is a privilege of
  // being on the LAN; the audience is served a slower, coalesced poll.
  viewerPollMs: positiveInteger(process.env.WERWOELFE_VIEWER_POLL_MS, 5000),
  // How long a viewer caches an operator response, so a crowd of concurrent viewers collapses into
  // one operator call. Must be shorter than `operatorTimeoutMs` *and* `viewerPollMs` to stay useful.
  viewerCacheMs: positiveInteger(process.env.WERWOELFE_VIEWER_CACHE_MS, 1500),
};

export function deepSeekAPIKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) {
    throw new Error("DEEPSEEK_API_KEY must be set in the operator server environment.");
  }
  return key;
}

/**
 * Is `image` qualified with a registry component?
 *
 * Docker/containerd decide this the same way: the reference names a registry only when it has a
 * `/` *and* the segment before the first `/` looks like a host (contains `.` or `:`, or is
 * `localhost`). Everything else — `werwoelfe-game:local`, and `werwoelfe/game:local` alike — is
 * resolved against Docker Hub (`docker.io/library/...` or `docker.io/werwoelfe/...`). A private
 * in-cluster image is never there, so the pod sits in `ImagePullBackOff` and the console's only
 * clue is a Job that never starts a container.
 */
function hasRegistryComponent(image: string): boolean {
  const withoutDigest = image.split("@")[0];
  const firstSlash = withoutDigest.indexOf("/");
  if (firstSlash === -1) {
    return false;
  }
  const firstSegment = withoutDigest.slice(0, firstSlash);
  return firstSegment.includes(".") || firstSegment.includes(":") || firstSegment === "localhost";
}

/**
 * Fail fast when the Kubernetes runtime is missing what its Jobs need.
 *
 * Deliberately *not* a module-scope check: `next build` imports this module for static analysis
 * with no cluster and no downward-API variables, so absent values must keep taking their defaults
 * here and be rejected only at the point of use — `startGame` and `reconcileRuns`.
 *
 * The three rejections are the first-run failures that otherwise surface as an opaque
 * `ImagePullBackOff` or a VolumeMount error deep in the Job's events.
 */
export function assertKubernetesEnvironment(): void {
  if (!hasRegistryComponent(environment.gameImage)) {
    throw new Error(
      `WERWOELFE_GAME_IMAGE ("${environment.gameImage}") has no registry component, so in-cluster ` +
        `it would be pulled from Docker Hub as ${registryLessWarning(environment.gameImage)} and fail. ` +
        `Set a fully qualified reference, e.g. ghcr.io/<org>/werwoelfe-game:<tag>.`,
    );
  }
  if (!environment.pvcName) {
    throw new Error(
      "WERWOELFE_PVC_NAME must name the PersistentVolumeClaim holding runs/<id>/{input,output,control}.",
    );
  }
  if (!environment.nodeName) {
    throw new Error(
      "POD_NODE_NAME must be set (the Deployment supplies it from spec.nodeName). The run's PVC is " +
        "Longhorn RWO, so every game Job must be pinned to the console's own node.",
    );
  }
}

/**
 * Fail fast when the viewer has nowhere to proxy to.
 *
 * Deliberately *not* a module-scope check, for the same reason as `assertKubernetesEnvironment`:
 * `next build` imports this module with no environment at all (and the operator sets no
 * `WERWOELFE_OPERATOR_URL`), so absent values must be tolerated here and rejected only at the point
 * of use. That point is `operator-client.ts`, the viewer's single network seam, so a misconfigured
 * viewer fails loudly with a 500 naming the variable instead of rendering "the live feed is
 * temporarily unavailable" — an outage no amount of retrying would clear.
 */
export function assertViewerEnvironment(): void {
  const configured = environment.operatorUrl;
  if (!configured) {
    throw new Error("WERWOELFE_OPERATOR_URL must be set in the viewer's server environment.");
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`WERWOELFE_OPERATOR_URL ("${configured}") is not an absolute URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`WERWOELFE_OPERATOR_URL ("${configured}") must be an http(s) URL.`);
  }
}

/** How a bare reference would be resolved against Docker Hub, for the error above. */
function registryLessWarning(image: string): string {
  const withoutTag = image.split(":")[0];
  return withoutTag.includes("/") ? `docker.io/${image}` : `docker.io/library/${image}`;
}
