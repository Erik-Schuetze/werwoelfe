import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBeats, type NightBeat } from "./beats.ts";
import type { GameEvent, GamePlayer } from "./game.ts";

const players: GamePlayer[] = [
  { id: "p1", name: "Mira", role: null, alive: null },
  { id: "p3", name: "Ruth", role: null, alive: null },
  { id: "p5", name: "Fen", role: null, alive: null },
];

function event(sequence: number, kind: string, message: string, recipients: string[] = []): GameEvent {
  return {
    sequence,
    at: new Date(1_700_000_000_000 + sequence * 1_000).toISOString(),
    kind,
    visibility: recipients.length > 0 ? "private" : "public",
    recipients,
    playerId: null,
    revealedRole: null,
    message,
  };
}

function nights(events: GameEvent[]): NightBeat[] {
  return buildBeats(events, players).filter((beat): beat is NightBeat => beat.kind === "night");
}

test("a reading names both ends, taken from the message and the recipients", () => {
  // The shape of a real run: the reading is addressed to the Fortune Teller
  // alone, so `recipients` is who read and the message is whom and what.
  const beats = nights([
    event(1, "game_started", "8 players have joined the village."),
    event(2, "night_started", "Night 1 falls."),
    event(3, "investigation_result", "Fen is a werewolf.", ["p3"]),
  ]);

  assert.equal(beats.length, 1);
  assert.deepEqual(beats[0].checks, [
    { reader: { id: "p3", name: "Ruth" }, target: { id: "p5", name: "Fen" }, result: "werewolf" },
  ]);
});

test("a night with no reading carries no check", () => {
  // Night 2 after the Fortune Teller was eaten: the night still happens, and
  // still has its pack and its meal, but nothing was read.
  const beats = nights([
    event(1, "game_started", "8 players have joined the village."),
    event(2, "night_started", "Night 1 falls."),
    event(3, "investigation_result", "Fen is a werewolf.", ["p3"]),
    event(4, "night_started", "Night 2 falls."),
  ]);

  assert.equal(beats.length, 2);
  assert.equal(beats[0].checks.length, 1);
  assert.deepEqual(beats[1].checks, []);
});

test("an unattributed reading keeps its target rather than dropping the check", () => {
  // Defensive: nothing in the engine omits `recipients`, but a check with no
  // reader must still show whom was read and what was seen.
  const beats = nights([
    event(1, "game_started", "8 players have joined the village."),
    event(2, "night_started", "Night 1 falls."),
    { ...event(3, "investigation_result", "Mira is a villager."), visibility: "private" },
  ]);

  assert.equal(beats.length, 1);
  assert.deepEqual(beats[0].checks, [
    { reader: null, target: { id: "p1", name: "Mira" }, result: "villager" },
  ]);
});
