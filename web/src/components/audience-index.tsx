"use client";

import { useEffect, useMemo, useState } from "react";

import type { GameSummary } from "@/lib/game";
import { gamePath, gamesApiPath } from "@/lib/viewer-routes";
import { RunCard } from "@/components/run-card";

/**
 * The public run list.
 *
 * It is the operator dashboard's history section with everything an operator knows and an
 * audience does not stripped out: no launch panel, no configuration, no table-rules briefing and
 * no count of what the console is doing. What is left is the runs themselves, split into the ones
 * that can still be watched and the ones that have finished.
 *
 * `failed` and `cancelled` runs are filtered out here as well as on the operator, so a run that
 * ends while the page is open cannot flash into the list before the next server render.
 */
export function AudienceIndex({ initialGames, pollMs }: { initialGames: GameSummary[]; pollMs: number }) {
  const [games, setGames] = useState(initialGames);

  useEffect(() => {
    const refresh = async () => {
      const response = await fetch(gamesApiPath("viewer"), { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { games: GameSummary[] };
      setGames(payload.games);
    };
    const interval = window.setInterval(() => {
      void refresh();
    }, pollMs);
    return () => window.clearInterval(interval);
  }, [pollMs]);

  const liveGames = useMemo(
    () => games.filter((game) => game.status === "queued" || game.status === "running" || game.status === "paused"),
    [games],
  );
  const finishedGames = useMemo(() => games.filter((game) => game.status === "completed"), [games]);

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Public viewer</p>
          <h1>Millers Hollow</h1>
          <p className="lede">Watch the village talk, accuse and vote — live, or from the archive.</p>
        </div>
      </header>

      <section className="history-section" aria-labelledby="audience-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Game desk</p>
            <h2 id="audience-heading">Runs at a glance</h2>
          </div>
        </div>
        {games.length === 0 ? (
          <div className="empty-state">No games have been played yet. Check back soon.</div>
        ) : (
          <>
            <div className="run-group" aria-labelledby="live-runs-heading">
              <div className="run-group-heading">
                <h3 id="live-runs-heading">Live now</h3>
                <span>{liveGames.length} active</span>
              </div>
              {liveGames.length === 0 ? (
                <p className="run-group-empty">Nothing is running right now. The next village will appear here.</p>
              ) : (
                <div className="run-list active-run-list">
                  {liveGames.map((game) => (
                    <RunCard active game={game} href={gamePath("viewer", game.id)} key={game.id} />
                  ))}
                </div>
              )}
            </div>
            {finishedGames.length > 0 ? (
              <div className="run-group archive-group" aria-labelledby="finished-runs-heading">
                <div className="run-group-heading">
                  <h3 id="finished-runs-heading">Finished</h3>
                  <span>{finishedGames.length} saved</span>
                </div>
                <div className="run-list">
                  {finishedGames.map((game) => (
                    <RunCard game={game} href={gamePath("viewer", game.id)} key={game.id} />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
