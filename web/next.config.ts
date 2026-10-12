import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Keep the Kubernetes client (and its many CJS/ESM sub-dependencies) out of the server bundle:
  // it must be required from node_modules at runtime, not traced and inlined by Turbopack.
  serverExternalPackages: ["@kubernetes/client-node"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
