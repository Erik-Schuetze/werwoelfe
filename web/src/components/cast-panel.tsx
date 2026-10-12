"use client";

import { useState } from "react";

import type { GamePlayer } from "@/lib/game";

/**
 * The dramatis personae: every player and the voice the engine gave them.
 *
 * The voices are written per player at the start of a run and describe how that
 * person argues — their tempo, how they take being challenged — never a trade
 * and never a side, so this panel reads identically at every truth level and
 * needs no gating. It follows the transcript's collapse idiom, but opens by
 * default: a spectator arriving mid-run should meet the cast, not a button.
 *
 * The list is the players in seat order. A player whose voice never arrived is
 * simply left out — a run with no cast at all says so in one line rather than
 * printing a column of blanks.
 */

type Props = {
  /** Players in seat order — the order the panel lists them in. */
  players: GamePlayer[];
  /** Player id → voice. Empty when the run generated no characters. */
  cast: Map<string, string>;
};

export function CastPanel({ players, cast }: Props) {
  const [open, setOpen] = useState(true);
  const rows = players
    .map((player) => ({ player, voice: cast.get(player.id) }))
    .filter((row): row is { player: GamePlayer; voice: string } => Boolean(row.voice));

  return (
    <section className="panel cast-panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">The cast</p>
          <h2>Who is speaking</h2>
        </div>
        <button className="secondary-button" onClick={() => setOpen((current) => !current)} type="button">
          {open ? "Hide the cast" : "Show the cast"}
        </button>
      </div>

      {open ? (
        rows.length === 0 ? (
          <p className="cast-empty">
            No voices were generated for this run; the players speak with their configured personalities.
          </p>
        ) : (
          <dl className="cast-list">
            {rows.map(({ player, voice }) => (
              <div className="cast-row" key={player.id}>
                <dt className="cast-name">{player.name}</dt>
                <dd className="cast-voice">{voice}</dd>
              </div>
            ))}
          </dl>
        )
      ) : null}
    </section>
  );
}
