/**
 * Next.js's one startup hook, and the only place the game runtime is constructed.
 *
 * The runtime implementations are chosen by `runtimeKind()` and registered process-wide here, so
 * every other module can reach them through `selectRuntime()` without importing either one. This
 * layer is allowed to `await import(...)` them precisely because it is not the selector — the
 * selector has to stay synchronous and cannot name the files.
 */
export async function register(): Promise<void> {
  // Instrumentation runs once per runtime (nodejs and edge). Only the Node.js server owns the
  // filesystem, SQLite and the Kubernetes client, so any other runtime returns immediately.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const [{ runtimeKind, registerRuntime }, runner] = await Promise.all([
    import("@/lib/server/runtime"),
    import("@/lib/server/runner"),
  ]);

  const kind = runtimeKind();
  const implementation =
    kind === "kubernetes"
      ? (await import("@/lib/server/runtimes/kubernetes")).kubernetesRuntime
      : (await import("@/lib/server/runtimes/docker")).dockerRuntime;
  registerRuntime(implementation);

  // Fire and forget, deliberately. `reconcileRuns` sweeps the cluster and re-arms every live run's
  // clock, which means it talks to the API server — and an awaited `register()` would mean a
  // console that never serves a single request while the API server is unreachable. The function
  // itself never throws, so nothing escapes this call.
  void runner.reconcileRuns();
}
