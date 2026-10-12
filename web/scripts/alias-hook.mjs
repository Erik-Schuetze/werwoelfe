/**
 * Dev-only resolver hook so the corpus harness can import the app modules that
 * use the `@/*` path alias. Never shipped — only loaded via `node --import`.
 *
 * It also lets a module be imported by its neighbour without an extension
 * ("./control-file"), which Node's ESM resolver does not do on its own: the
 * specifier is retried against the same `.ts`/`.tsx`/`.js` suffixes. That keeps
 * the app sources free of import extensions while `node --test` still runs them.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const SRC = new URL("../src/", import.meta.url);
const SUFFIXES = ["", ".ts", ".tsx", ".js"];

// `base` is a URL href; try it verbatim, then with each suffix appended.
function resolveWithSuffixes(base) {
  for (const suffix of SUFFIXES) {
    const candidate = new URL(base + suffix);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = new URL(specifier.slice(2), SRC).href;
      return resolveWithSuffixes(base) ?? nextResolve(specifier, context);
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL) {
      const resolved = resolveWithSuffixes(new URL(specifier, context.parentURL).href);
      if (resolved) {
        return resolved;
      }
    }
    return nextResolve(specifier, context);
  },
});
