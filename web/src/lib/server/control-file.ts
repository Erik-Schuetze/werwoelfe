/**
 * The console -> engine pause channel.
 *
 * The engine (a Go binary, written separately) polls `<run>/control/control.json` and blocks
 * between turns while the file says `paused: true`. Everything about this module is shaped by
 * two facts:
 *
 *  - Fail-open is the contract. A missing, unreadable or malformed file means "not paused".
 *    A console that crashed between two writes, or a run that never had a control file written
 *    at all, must never be able to strand a game forever. `readControlFile` therefore returns
 *    `null` instead of throwing for every fault.
 *  - Writes must be atomic. The engine may read at any instant, so a half-written file must be
 *    impossible: we write a temp file *in the same directory* (same filesystem, so the rename
 *    is atomic) and then `fs.rename` it over the target. The engine only ever sees the old
 *    complete file or the new complete file.
 *
 * Deliberately free of `server-only`: this runs under `node --test` as well as inside Next.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Version the engine's `controlFile` struct expects. Bump only alongside that struct. */
const CONTROL_SCHEMA_VERSION = 1;

const CONTROL_FILE_NAME = "control.json";

/**
 * Write the pause request for a run. `dir` is the run's `control/` directory; it is created if
 * needed. The write is atomic — the engine never observes a partial file.
 */
export async function writeControlFile(dir: string, paused: boolean): Promise<void> {
  const target = path.join(dir, CONTROL_FILE_NAME);
  const body = JSON.stringify({
    schema_version: CONTROL_SCHEMA_VERSION,
    paused,
    requested_at: new Date().toISOString(),
  });
  await fs.mkdir(dir, { recursive: true });
  // Dot-prefixed and suffixed so it can never be mistaken for the control file itself, and
  // unique so two concurrent writers cannot clobber each other's temp file.
  const temp = path.join(dir, `.control.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, body, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temp, target);
  } catch (error) {
    // A failed rename (or write) must not leave the temp file behind for the engine to trip on.
    await fs.rm(temp, { force: true });
    throw error;
  }
}

/**
 * Read the pause request for a run. Returns `null` — never throws — when the directory or file
 * is missing, unreadable, or does not carry a boolean `paused`. Callers treat `null` as
 * "not paused" (the fail-open contract).
 *
 * Unknown fields (including `schema_version`) are ignored, mirroring the engine's forward-
 * compatible parse so an older reader tolerates a newer writer.
 */
export async function readControlFile(dir: string): Promise<{ paused: boolean } | null> {
  let body: string;
  try {
    body = await fs.readFile(path.join(dir, CONTROL_FILE_NAME), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { paused?: unknown }).paused !== "boolean"
  ) {
    return null;
  }
  return { paused: (parsed as { paused: boolean }).paused };
}
