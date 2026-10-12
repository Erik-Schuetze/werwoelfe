import "server-only";

import path from "node:path";

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

const dataDir = path.resolve(/* turbopackIgnore: true */ process.env.WERWOELFE_DATA_DIR || path.join(process.cwd(), "data"));

export const environment = {
  dataDir,
  dockerDataDir: path.resolve(/* turbopackIgnore: true */ process.env.WERWOELFE_DOCKER_DATA_DIR || dataDir),
  gameImage: gameImage(process.env.WERWOELFE_GAME_IMAGE),
  maxConcurrentRuns: positiveInteger(process.env.WERWOELFE_MAX_CONCURRENT_RUNS, 1),
  maxRunMinutes: positiveInteger(process.env.WERWOELFE_MAX_RUN_MINUTES, 30),
};

export function deepSeekAPIKey(): string {
  const key = process.env.DEEPSEEK_API_KEY?.trim();
  if (!key) {
    throw new Error("DEEPSEEK_API_KEY must be set in the operator server environment.");
  }
  return key;
}
