import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { readControlFile, writeControlFile } from "./control-file.ts";

let root: string;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "werwoelfe-control-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("round-trips false then true", async () => {
  const dir = path.join(root, "round-trip");
  await writeControlFile(dir, false);
  assert.deepEqual(await readControlFile(dir), { paused: false });
  await writeControlFile(dir, true);
  assert.deepEqual(await readControlFile(dir), { paused: true });
  await writeControlFile(dir, false);
  assert.deepEqual(await readControlFile(dir), { paused: false });
});

test("writes the engine's contract shape", async () => {
  const dir = path.join(root, "contract");
  await writeControlFile(dir, true);
  const body = JSON.parse(await readFile(path.join(dir, "control.json"), "utf8")) as {
    schema_version: number;
    paused: boolean;
    requested_at: string;
  };
  assert.equal(body.schema_version, 1);
  assert.equal(body.paused, true);
  assert.equal(typeof body.requested_at, "string");
  // ISO 8601, which is what the engine's `time.Time`-shaped string is expected to parse as.
  assert.equal(new Date(body.requested_at).toISOString(), body.requested_at);
});

test("creates the directory and leaves no stray temp file behind", async () => {
  const dir = path.join(root, "atomic");
  await writeControlFile(dir, true);
  await writeControlFile(dir, true); // idempotent rewrite
  assert.deepEqual(await readControlFile(dir), { paused: true });
  // The temp-then-rename write is atomic precisely because nothing else survives it.
  assert.deepEqual(await readdir(dir), ["control.json"]);
});

test("fails open on a missing directory", async () => {
  assert.equal(await readControlFile(path.join(root, "never-created")), null);
});

test("fails open on malformed JSON", async () => {
  const dir = path.join(root, "malformed");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "control.json"), "{ paused: true", "utf8");
  assert.equal(await readControlFile(dir), null);
});

test("fails open when paused is not a boolean", async () => {
  const dir = path.join(root, "wrong-shape");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "control.json"),
    JSON.stringify({ schema_version: 1, paused: "yes", requested_at: "2026-10-12T08:41:48.688Z" }),
    "utf8",
  );
  assert.equal(await readControlFile(dir), null);
});

test("fails open on a missing file in an existing directory", async () => {
  const dir = path.join(root, "empty");
  await mkdir(dir, { recursive: true });
  assert.equal(await readControlFile(dir), null);
});

test("never overwrites the live file in place (atomic rename)", async () => {
  const dir = path.join(root, "rename");
  await writeControlFile(dir, false);
  const inodeBefore = await readFile(path.join(dir, "control.json"), "utf8");
  await writeControlFile(dir, true);
  const inodeAfter = await readFile(path.join(dir, "control.json"), "utf8");
  assert.notEqual(inodeBefore, inodeAfter);
  assert.deepEqual(await readControlFile(dir), { paused: true });
});
