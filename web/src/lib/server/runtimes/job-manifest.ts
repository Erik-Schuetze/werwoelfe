/**
 * The Kubernetes Job that runs one game.
 *
 * A pure function: it builds a `V1Job`-shaped plain object from the request and touches nothing.
 * The only external dependency is the Kubernetes types, and those are imported with `import
 * type` — erased at runtime — so this module carries no `server-only` marker and no runtime
 * import of the client, and `node --test` can load it directly.
 *
 * The shape below mirrors, bullet for bullet, the `docker run` invocation it replaces, so the
 * two runtimes are behaviourally the same run:
 *
 *  - `backoffLimit: 0` is load-bearing. A retry would re-run the game, and the engine opens its
 *    event stream with `O_TRUNC`, so a replay would wipe and collide with events the console has
 *    already ingested.
 *  - `-timeout 0` is kept for the same class of reason: any non-zero engine timeout is a third
 *    clock the operator cannot pause, and it would kill a paused run.
 *  - `nodeName` pins the game pod to the console's node because the run's PVC is Longhorn RWO —
 *    single-attach — so the pod that mounts it must be the node that already has it.
 */
import type { V1Job } from "@kubernetes/client-node";

export function jobManifest(request: {
  id: string;
  namespace: string;
  image: string;
  seed: string;
  nodeName: string;
  pvcName: string;
  secretName: string;
  secretKey: string;
  activeDeadlineSeconds: number;
}): object {
  // Same labels on the Job and on the pod template: the poller and debugging select on the pod
  // labels, and the Job labels make a Job-only `kubectl get` readable.
  const labels = {
    "app.werwoelfe.managed": "true",
    "app.werwoelfe.game": request.id,
  };

  const manifest: V1Job = {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      // "werwoelfe-" + a UUID is 46 characters. The Job controller stamps the Job's name into the
      // pods' `job-name` label, whose value is capped at 63 — and the pod name adds a 6-character
      // suffix on top — so the name must stay comfortably under the limit. It does.
      name: `werwoelfe-${request.id}`,
      namespace: request.namespace,
      labels,
    },
    spec: {
      // A retry re-runs the game and truncates the event stream the console is already consuming.
      backoffLimit: 0,
      activeDeadlineSeconds: request.activeDeadlineSeconds,
      // Keep finished Jobs (and their pod logs) around for an hour of operator debugging.
      ttlSecondsAfterFinished: 3600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: "Never",
          // Matches today's `docker stop --time 10`, so a stop is equally gentle either way.
          terminationGracePeriodSeconds: 10,
          // Longhorn RWO is single-attach: the pod that mounts the run's PVC must be this node.
          nodeName: request.nodeName,
          securityContext: {
            // Pod-wide identity, so every container in the pod runs as the same unprivileged user.
            runAsNonRoot: true,
            runAsUser: 65532,
            runAsGroup: 65532,
            fsGroup: 65532,
            seccompProfile: { type: "RuntimeDefault" },
          },
          volumes: [
            {
              name: "run",
              persistentVolumeClaim: { claimName: request.pvcName },
            },
          ],
          containers: [
            {
              name: "game",
              image: request.image,
              // Exactly the standalone engine's CLI, with `-control` added so the pause channel
              // works. `-timeout 0` is deliberate: a non-zero engine timeout is an unpausable
              // clock that would kill a paused run.
              args: [
                "-config",
                "/config/config.json",
                "-events",
                "/output/events.ndjson",
                "-result",
                "/output/game-result.json",
                "-seed",
                request.seed,
                "-timeout",
                "0",
                "-control",
                "/control/control.json",
              ],
              env: [
                {
                  name: "DEEPSEEK_API_KEY",
                  // The key is mounted from a Secret and never inlined: the console must not route
                  // the API key through itself, and it must not appear in the pod's manifest.
                  valueFrom: {
                    secretKeyRef: { name: request.secretName, key: request.secretKey },
                  },
                },
              ],
              volumeMounts: [
                {
                  name: "run",
                  mountPath: "/config",
                  subPath: `runs/${request.id}/input`,
                  // The engine reads its config from here and must never write back into it.
                  readOnly: true,
                },
                {
                  name: "run",
                  mountPath: "/output",
                  subPath: `runs/${request.id}/output`,
                },
                {
                  name: "run",
                  mountPath: "/control",
                  subPath: `runs/${request.id}/control`,
                },
              ],
              // Docker carried `--pids-limit 256`; Kubernetes has NO per-pod PID limit to translate
              // it to — the only equivalent is the node-wide kubelet `podPidsLimit`, which cannot be
              // set per Job. That is acceptable here: the image is a fixed static Go binary with no
              // shell and no interpreter, so the fork-bomb surface a PID cap defends against does
              // not exist. This omission is a decision, not an oversight.
              resources: {
                // requests == limits on both dimensions: Guaranteed QoS, so this pod — which shares
                // a node with the console — is the last thing the kubelet evicts under pressure.
                requests: { cpu: "1", memory: "1Gi" },
                limits: { cpu: "1", memory: "1Gi" },
              },
              securityContext: {
                // Container-level hardening for a `restricted`-PSA namespace.
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ["ALL"] },
              },
            },
          ],
        },
      },
    },
  };

  return manifest;
}
