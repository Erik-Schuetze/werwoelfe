/**
 * The Kubernetes runtime: one Job per game, for the in-cluster console.
 *
 * There is no Docker daemon in the cluster (k3s + containerd), so a run is a batch/v1 Job built by
 * `./job-manifest.ts` — that module owns the manifest's every bullet, and this one only submits it
 * and reads the cluster's answer back.
 *
 * ## The client (verified against the installed @kubernetes/client-node@2.0.0)
 *
 * v2 is ESM and reshapes the generated API. Two things differ from v1 and are load-bearing here:
 *
 *  - A client is made the same way the package's README documents —
 *    `kc.makeApiClient(CoreV1Api)` — but the v2 generated classes take a single *request object*
 *    (`{ namespace, body }`, `{ name, namespace }`) and **return the Kubernetes object directly**
 *    (`Promise<V1Job>`, `Promise<V1PodList>`), not a `{ body, response }` wrapper. The classes the
 *    package exports as `BatchV1Api`/`CoreV1Api` are the param-object variants
 *    (`ObjectBatchV1Api`/`ObjectCoreV1Api`).
 *  - HTTP failures are `ApiException` (exported from the root) carrying `.code`, the numeric status.
 *    A missing object is `code === 404`; a timeout is not an `ApiException` at all.
 *
 * Rather than `makeApiClient` we build the equivalent `Configuration` by hand, for one reason: the
 * per-call `options` parameter is typed as the *observable* middleware variant while the runtime
 * `wrapOptions` treats it as the promise variant, so there is no clean, cast-free way to attach a
 * timeout per call. Building the configuration once with `promiseMiddleware` gives every request a
 * fresh `AbortSignal.timeout(...)` and stays fully typed.
 *
 * ## Laziness
 *
 * Nothing here may touch a `KubeConfig` at module scope: `next build` imports route modules for
 * static analysis, and `loadFromCluster()` throws outside a cluster. The client is built on first
 * use and cached on `globalThis`, the same HMR-safe idiom the process map and database use.
 */
import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import {
  ApiException,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  ServerConfiguration,
  createConfiguration,
} from "@kubernetes/client-node";
import type { Configuration, Middleware as PromiseMiddleware, V1Job, V1Pod } from "@kubernetes/client-node";

import { writeControlFile } from "@/lib/server/control-file";
import { environment } from "@/lib/server/env";
import { jobManifest } from "@/lib/server/runtimes/job-manifest";
import type { GameRuntime, RunObservation, StartRunRequest } from "@/lib/server/runtime";

/** How many pod-log lines to keep when the engine died without writing anything. */
const TAIL_LINES = 50;

/** The Job name `job-manifest.ts` stamps for a run, and the pods' `job-name` label value. */
const JOB_PREFIX = "werwoelfe-";

/**
 * Every cluster call this runtime makes, behind one narrow interface so it can be faked in a test
 * without a cluster. The methods are the smallest set the runner's model needs, not the client's
 * surface.
 */
export interface KubeApi {
  createJob(job: object): Promise<void>;
  deleteJob(name: string): Promise<void>;
  readJob(name: string): Promise<V1Job>;
  listJobs(labelSelector: string): Promise<V1Job[]>;
  patchJobDeadline(name: string, seconds: number): Promise<void>;
  listPods(labelSelector: string): Promise<V1Pod[]>;
  readPodLog(podName: string, container: string, tailLines: number): Promise<string>;
}

/**
 * A run the cluster holds: the Job's name, and the game its label claims it is.
 *
 * `gameId` is null when the label is absent or blank — an unattributable Job, which is precisely
 * the case the sweep exists to reclaim. It is never inferred from the Job's name.
 */
export type ManagedRun = {
  jobName: string;
  gameId: string | null;
};

/**
 * A runtime that can enumerate and reap its own runs; the poller uses it for orphan detection.
 *
 * `deleteUnownedJob` is deliberately *not* `stopRun`: stopping is a lifecycle action on a run the
 * console owns, reaping is the disposal of a Job that belongs to no game row. They must not be
 * confused, because reaping a run the console still owns would destroy the job's post-mortem.
 */
export type ManagedRunLister = {
  listManagedRuns(): Promise<ManagedRun[]>;
  deleteUnownedJob(jobName: string): Promise<void>;
};

declare global {
  var werwoelfeKubeApi: KubeApi | undefined;
}

function jobName(id: string): string {
  return `${JOB_PREFIX}${id}`;
}

/** The host path holding every run's artifacts — the PVC mounted at the console's data root. */
function runControlDir(id: string): string {
  return path.join(environment.dataDir, "runs", id, "control");
}

/** Bound every call. A hung apiserver must not wedge a request or a poll tick. */
function requestTimeoutMiddleware(): PromiseMiddleware {
  return {
    pre: async (context) => {
      context.setSignal(AbortSignal.timeout(environment.kubeTimeoutMs));
      return context;
    },
    post: async (context) => context,
  };
}

function createKubeApi(config: KubeConfig): KubeApi {
  const cluster = config.getCurrentCluster();
  if (!cluster) {
    throw new Error("The Kubernetes configuration has no current cluster.");
  }
  const configuration: Configuration = createConfiguration({
    baseServer: new ServerConfiguration(cluster.server, {}),
    // The KubeConfig is itself the authenticator; this is exactly what `makeApiClient` wires up.
    authMethods: { default: config },
    promiseMiddleware: [requestTimeoutMiddleware()],
  });
  const batch = new BatchV1Api(configuration);
  const core = new CoreV1Api(configuration);
  const namespace = environment.namespace;

  return {
    async createJob(job) {
      await batch.createNamespacedJob({ namespace, body: job as V1Job });
    },
    async deleteJob(name) {
      // Background propagation: the Job goes now, its pod is reclaimed asynchronously.
      await batch.deleteNamespacedJob({ name, namespace, propagationPolicy: "Background" });
    },
    async readJob(name) {
      return batch.readNamespacedJob({ name, namespace });
    },
    async listJobs(labelSelector) {
      return (await batch.listNamespacedJob({ namespace, labelSelector })).items ?? [];
    },
    async patchJobDeadline(name, seconds) {
      // A JSON merge patch: only the one field is touched.
      await batch.patchNamespacedJob({ name, namespace, body: { spec: { activeDeadlineSeconds: seconds } } });
    },
    async listPods(labelSelector) {
      return (await core.listNamespacedPod({ namespace, labelSelector })).items ?? [];
    },
    async readPodLog(podName, container, tailLines) {
      return core.readNamespacedPodLog({ name: podName, namespace, container, tailLines });
    },
  };
}

function loadKubeConfig(): KubeConfig {
  const inCluster = new KubeConfig();
  try {
    inCluster.loadFromCluster();
    return inCluster;
  } catch {
    // Outside a cluster there is no service account to read. Fall back to the operator's own
    // kubeconfig so a local console can still drive a cluster when asked to.
  }
  const local = new KubeConfig();
  local.loadFromDefault();
  return local;
}

function kubeApi(): KubeApi {
  if (!globalThis.werwoelfeKubeApi) {
    globalThis.werwoelfeKubeApi = createKubeApi(loadKubeConfig());
  }
  return globalThis.werwoelfeKubeApi;
}

function isNotFound(error: unknown): boolean {
  return error instanceof ApiException && error.code === 404;
}

type PodFailure = {
  /** The container's exit code, if one was ever recorded. */
  exitCode: number | null;
  /** Why a container is stuck before starting: ImagePullBackOff, CreateContainerConfigError, ... */
  waitingReason: string | null;
};

/**
 * The exit code a Job's own status does not carry. The *pod* does.
 *
 * A container that never ran (a bad image, a bad Secret reference) has no `terminated` state at
 * all — it sits in `state.waiting` — so the waiting reason is read *before* falling back to
 * `lastState.terminated`: those are the most likely first-run failures, and they would otherwise
 * all look identical ("no exit code").
 */
async function describePod(id: string): Promise<PodFailure> {
  let pods: V1Pod[];
  try {
    pods = await kubeApi().listPods(`job-name=${jobName(id)}`);
  } catch {
    return { exitCode: null, waitingReason: null };
  }
  let exitCode: number | null = null;
  let waitingReason: string | null = null;
  for (const pod of pods) {
    for (const status of pod.status?.containerStatuses ?? []) {
      const terminated = status.state?.terminated;
      if (terminated) {
        exitCode = terminated.exitCode ?? null;
        continue;
      }
      const waiting = status.state?.waiting?.reason;
      if (waiting) {
        waitingReason = waiting;
        continue;
      }
      const last = status.lastState?.terminated;
      if (last) {
        exitCode = last.exitCode ?? null;
      }
    }
  }
  return { exitCode, waitingReason };
}

/** Does the run's event stream already hold a terminal record (a result or a failure)? */
async function hasTerminalRecord(id: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await fs.readFile(
      path.join(environment.dataDir, "runs", id, "output", "events.ndjson"),
      "utf8",
    );
  } catch {
    return false;
  }
  return contents.split("\n").some((line) => {
    if (!line.trim()) {
      return false;
    }
    try {
      const record = JSON.parse(line) as { type?: string };
      return record.type === "result" || record.type === "failure";
    } catch {
      return false;
    }
  });
}

/** The tail of the game container's log, for a run that failed without writing a record. */
async function tailPodLogs(id: string): Promise<string> {
  try {
    const pods = await kubeApi().listPods(`job-name=${jobName(id)}`);
    const pod = pods[0];
    const name = pod?.metadata?.name;
    if (!name) {
      return "";
    }
    const container = pod?.spec?.containers?.[0]?.name ?? "game";
    const logs = await kubeApi().readPodLog(name, container, TAIL_LINES);
    return logs.trim().split("\n").slice(-TAIL_LINES).join("\n").slice(0, 2_000);
  } catch {
    return "";
  }
}

/**
 * A failed run's diagnosis, handed to the console log.
 *
 * The engine exits on a missing API key *before* it opens its event stream, so the likeliest
 * misconfiguration would otherwise surface as a bare "exited with code 1" with nothing behind it.
 * The pod's own log is the only place the real reason exists.
 */
async function reportFailure(id: string, failure: PodFailure): Promise<void> {
  if (await hasTerminalRecord(id)) {
    return;
  }
  const parts = [`[werwoelfe] game ${id} failed before writing a result record.`];
  if (failure.waitingReason) {
    parts.push(`The game container never started: ${failure.waitingReason}.`);
  }
  const logs = await tailPodLogs(id);
  if (logs) {
    parts.push(`Last ${TAIL_LINES} lines of pod logs:`, logs);
  }
  console.error(parts.join("\n"));
}

export const kubernetesRuntime: GameRuntime & ManagedRunLister = {
  kind: "kubernetes",

  async startRun(request: StartRunRequest): Promise<void> {
    // The manifest is built elsewhere and submitted as-is; nothing here re-derives it.
    const job = jobManifestRequest(request);
    await kubeApi().createJob(job);
  },

  async stopRun(id: string): Promise<void> {
    try {
      await kubeApi().deleteJob(jobName(id));
    } catch (error) {
      // Deleting an already-deleted Job is the run being over, not a failure.
      if (!isNotFound(error)) {
        throw error;
      }
    }
  },

  async observeRun(id: string): Promise<RunObservation> {
    let job: V1Job;
    try {
      job = await kubeApi().readJob(jobName(id));
    } catch (error) {
      if (isNotFound(error)) {
        return { state: "terminal", exitCode: null, reason: "missing" };
      }
      // An unreachable apiserver is not evidence of anything: let the caller skip this run.
      throw error;
    }

    const conditions = job.status?.conditions ?? [];
    if (conditions.some((condition) => condition.type === "Complete")) {
      return { state: "terminal", exitCode: 0, reason: "completed" };
    }
    const failed = conditions.find((condition) => condition.type === "Failed");
    if (!failed) {
      return { state: "active" };
    }

    const failure = await describePod(id);
    await reportFailure(id, failure);
    if (failed.reason === "DeadlineExceeded") {
      return { state: "terminal", exitCode: failure.exitCode, reason: "deadline" };
    }
    return { state: "terminal", exitCode: failure.exitCode, reason: "failed" };
  },

  async setPaused(id: string, paused: boolean): Promise<void> {
    // No API call: the pause channel is the control file the engine polls between turns.
    await writeControlFile(runControlDir(id), paused);
  },

  async setJobDeadline(id: string, seconds: number): Promise<void> {
    const api = kubeApi();
    const job = await api.readJob(jobName(id));
    const current = job.spec?.activeDeadlineSeconds ?? 0;
    // Never lower it. Kubernetes rejects a Job whose deadline is already in the past, so patching
    // a stale (smaller) value would kill a run that is still perfectly fine.
    const next = Math.max(seconds, current);
    if (next > current) {
      await api.patchJobDeadline(jobName(id), next);
    }
  },

  runRoot(): string {
    return environment.dataDir;
  },

  async listManagedRuns(): Promise<ManagedRun[]> {
    const jobs = await kubeApi().listJobs("app.werwoelfe.managed=true");
    const runs: ManagedRun[] = [];
    for (const job of jobs) {
      const name = job.metadata?.name;
      if (!name) {
        continue;
      }
      runs.push({
        jobName: name,
        // The label is the *only* attribution accepted. A Job whose name starts with
        // `werwoelfe-` is not evidence of ownership, so it is never mined for an id: doing so
        // would let a Job the console does not own inherit the identity of a game that happens
        // to share the name, and be spared the sweep forever.
        gameId: job.metadata?.labels?.["app.werwoelfe.game"]?.trim() || null,
      });
    }
    return runs;
  },

  async deleteUnownedJob(jobName: string): Promise<void> {
    try {
      await kubeApi().deleteJob(jobName);
    } catch (error) {
      // Already gone is the outcome we wanted; anything else is the caller's to retry.
      if (!isNotFound(error)) {
        throw error;
      }
    }
  },
};

/**
 * The manifest, exactly as `job-manifest.ts` builds it. Kept as a thin adapter so this module
 * never grows a second copy of the Job's shape.
 */
function jobManifestRequest(request: StartRunRequest): object {
  return jobManifest({
    id: request.id,
    namespace: environment.namespace,
    image: request.image,
    seed: request.seed,
    nodeName: environment.nodeName,
    pvcName: environment.pvcName,
    secretName: environment.deepseekSecret,
    secretKey: environment.deepseekSecretKey,
    // The manifest's TTL is fixed at 3600 by job-manifest.ts; env.jobTTLSeconds documents it.
    activeDeadlineSeconds: request.activeDeadlineSeconds,
  });
}
