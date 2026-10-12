/**
 * Dev-only resolver hook so the corpus harness can import the app modules that
 * use the `@/*` path alias. Never shipped — only loaded via `node --import`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = new URL(specifier.slice(2), SRC).href;
      for (const suffix of ["", ".ts", ".tsx", ".js"]) {
        const candidate = new URL(base + suffix);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
