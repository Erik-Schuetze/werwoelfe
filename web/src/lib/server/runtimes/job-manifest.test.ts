import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { jobManifest } from "./job-manifest.ts";

// The manifest is returned as `object`; this is the shape the tests reason about. It is
// deliberately hand-written rather than the generated `V1Job` so the test asserts the *contract*
// the console relies on, not whatever the client happens to type this week.
type Manifest = {
  apiVersion: string;
  kind: string;
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    backoffLimit: number;
    activeDeadlineSeconds: number;
    ttlSecondsAfterFinished: number;
    template: {
      metadata: { labels: Record<string, string> };
      spec: {
        restartPolicy: string;
        terminationGracePeriodSeconds: number;
        nodeName: string;
        securityContext: {
          runAsNonRoot: boolean;
          runAsUser: number;
          runAsGroup: number;
          fsGroup: number;
          seccompProfile: { type: string };
        };
        volumes: Array<{ name: string; persistentVolumeClaim: { claimName: string } }>;
        containers: Array<{
          name: string;
          image: string;
          args: string[];
          env: Array<{
            name: string;
            value?: string;
            valueFrom?: { secretKeyRef?: { name?: string; key: string } };
          }>;
          volumeMounts: Array<{
            name: string;
            mountPath: string;
            subPath?: string;
            readOnly?: boolean;
          }>;
          resources: {
            requests: Record<string, string>;
            limits: Record<string, string>;
          };
          securityContext: {
            allowPrivilegeEscalation: boolean;
            readOnlyRootFilesystem: boolean;
            capabilities: { drop: string[] };
          };
        }>;
      };
    };
  };
};

const id = randomUUID();
const seed = "14142135623730951";

const request = {
  id,
  namespace: "werwoelfe",
  image: "registry.example.com/werwoelfe-game:1.2.3",
  seed,
  nodeName: "console-node-1",
  pvcName: "werwoelfe-runs",
  secretName: "werwoelfe-deepseek",
  secretKey: "api-key",
  activeDeadlineSeconds: 3600,
};

function build(): Manifest {
  return jobManifest(request) as Manifest;
}

test("names the Job after the run, short enough for the job-name label", () => {
  const manifest = build();
  assert.equal(manifest.apiVersion, "batch/v1");
  assert.equal(manifest.kind, "Job");
  assert.equal(manifest.metadata.name, `werwoelfe-${id}`);
  assert.equal(manifest.metadata.namespace, "werwoelfe");
  // A UUID makes the name 46 characters. The Job controller copies it into the pods' `job-name`
  // label (63-char cap) and the pod name adds a suffix on top, so it must stay well clear.
  assert.ok(
    manifest.metadata.name.length <= 52,
    `Job name "${manifest.metadata.name}" is too long for the job-name label plus a pod suffix`,
  );
});

test("labels the Job and the pod template identically", () => {
  const manifest = build();
  const expected = { "app.werwoelfe.managed": "true", "app.werwoelfe.game": id };
  assert.deepEqual(manifest.metadata.labels, expected);
  assert.deepEqual(manifest.spec.template.metadata.labels, expected);
});

test("disables retries — a replay would truncate the event stream", () => {
  assert.equal(build().spec.backoffLimit, 0);
});

test("sets the deadline and a one-hour TTL", () => {
  const manifest = build();
  assert.equal(manifest.spec.activeDeadlineSeconds, 3600);
  assert.equal(manifest.spec.ttlSecondsAfterFinished, 3600);
});

test("pins the pod to the console's node and never restarts it", () => {
  const pod = build().spec.template.spec;
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.terminationGracePeriodSeconds, 10);
  assert.equal(pod.nodeName, "console-node-1");
});

test("mounts the run's PVC via subPath, with input read-only", () => {
  const pod = build().spec.template.spec;
  assert.equal(pod.volumes.length, 1);
  assert.equal(pod.volumes[0].name, "run");
  assert.deepEqual(pod.volumes[0].persistentVolumeClaim, { claimName: "werwoelfe-runs" });

  const mounts = pod.containers[0].volumeMounts;
  assert.deepEqual(mounts, [
    { name: "run", mountPath: "/config", subPath: `runs/${id}/input`, readOnly: true },
    { name: "run", mountPath: "/output", subPath: `runs/${id}/output` },
    { name: "run", mountPath: "/control", subPath: `runs/${id}/control` },
  ]);
  const config = mounts.find((mount) => mount.mountPath === "/config")!;
  assert.equal(config.readOnly, true);
});

test("runs exactly the engine's CLI, with -timeout 0 and the control channel", () => {
  const container = build().spec.template.spec.containers[0];
  assert.equal(container.name, "game");
  assert.equal(container.image, "registry.example.com/werwoelfe-game:1.2.3");
  assert.deepEqual(container.args, [
    "-config",
    "/config/config.json",
    "-events",
    "/output/events.ndjson",
    "-result",
    "/output/game-result.json",
    "-seed",
    seed,
    "-timeout",
    "0",
    "-control",
    "/control/control.json",
  ]);
  // Spelled out because it is load-bearing: a non-zero engine timeout is a third, unpausable
  // clock that would kill a paused run.
  assert.equal(container.args[container.args.indexOf("-timeout") + 1], "0");
});

test("takes the API key from a Secret and never inlines it", () => {
  const env = build().spec.template.spec.containers[0].env;
  assert.equal(env.length, 1);
  assert.equal(env[0].name, "DEEPSEEK_API_KEY");
  assert.deepEqual(env[0].valueFrom?.secretKeyRef, {
    name: "werwoelfe-deepseek",
    key: "api-key",
  });
  // The key must never sit in the manifest in plaintext, nor be routed through the console.
  assert.equal(env[0].value, undefined);
  assert.doesNotMatch(JSON.stringify(env), /sk-/);
});

test("requests equal limits, for Guaranteed QoS", () => {
  const resources = build().spec.template.spec.containers[0].resources;
  assert.deepEqual(resources.requests, { cpu: "1", memory: "1Gi" });
  assert.deepEqual(resources.limits, { cpu: "1", memory: "1Gi" });
  assert.deepEqual(resources.requests, resources.limits);
});

test("is hardened for a restricted-PSA namespace", () => {
  const pod = build().spec.template.spec;
  const container = pod.containers[0];

  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.securityContext.runAsUser, 65532);
  assert.equal(pod.securityContext.runAsGroup, 65532);
  assert.equal(pod.securityContext.fsGroup, 65532);
  assert.deepEqual(pod.securityContext.seccompProfile, { type: "RuntimeDefault" });

  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
});

test("has no PID limit — Kubernetes has no per-pod equivalent", () => {
  // Docker carried `--pids-limit 256`; there is deliberately no line here standing in for it.
  // A stray `pids` in the serialized manifest would mean someone added one that the API server
  // silently ignores, which would be worse than the honest omission.
  assert.doesNotMatch(JSON.stringify(jobManifest(request)), /pids/i);
});
