import type { PlayerIndex } from "@/lib/beats";
import type { GameEvent } from "@/lib/game";

/**
 * The cast: each player's speaking voice, as generated once at the top of a run.
 *
 * The engine writes one private `character_defined` event per player whose voice
 * it produced — `"<name>: <description>"`, with the player it belongs to in
 * `recipients` — and every description is role-agnostic by construction: it
 * describes a manner, never a trade and never a side. Nothing here reads a role,
 * so the cast is safe to show at every truth level.
 *
 * A run may have no cast at all (`character_temperature: 0` disables generation)
 * or only a partial one — generation is best-effort — so "no voice" is an
 * ordinary state the callers have to name rather than a defect.
 */

export const CHARACTER_KIND = "character_defined";

/**
 * Player id → their voice, verbatim.
 *
 * The player is resolved from `recipients[0]` and never from the message: a
 * description may itself contain a colon, so splitting the text on the first
 * `:` would misread both halves. With the id in hand the name is already known,
 * and only the exact `"<name>: "` prefix is stripped. A message that does not
 * carry that prefix is left out rather than guessed at.
 */
export function buildCast(events: GameEvent[], index: PlayerIndex): Map<string, string> {
  const cast = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== CHARACTER_KIND) continue;
    const playerId = event.recipients[0];
    if (!playerId) continue;
    const name = index.byId.get(playerId);
    if (!name) continue;
    const prefix = `${name}: `;
    if (!event.message.startsWith(prefix)) continue;
    // A later event for the same player wins: on a retry the newest definition is
    // the one the run actually spoke with.
    cast.set(playerId, event.message.slice(prefix.length));
  }
  return cast;
}
