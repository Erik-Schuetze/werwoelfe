"use client";

import Link from "next/link";

import type { GameStatus } from "@/lib/game";
import { runTitle } from "@/lib/run-title";
import { LocalTime } from "@/components/local-time";
import { StatusBadge } from "@/components/status-badge";

/**
 * One run, as both indexes show it: the operator's dashboard and the public
 * audience list.
 *
 * The destination is a prop rather than a hardcoded `/games/<id>`, because the
 * same row leads to `/viewer/games/<id>` for the audience. The prop type is
 * structural, in the spirit of `run-title.ts`: a card reads only these five
 * fields, so stating them here keeps it independent of `GameSummary` growing
 * new ones.
 */
type RunCardGame = {
  id: string;
  status: GameStatus;
  title?: string | null;
  playerCount: number;
  eventCount: number;
  createdAt?: string | null;
};

export function RunCard({ game, active = false, href }: { game: RunCardGame; active?: boolean; href: string }) {
  const title = runTitle(game);

  return (
    <Link className={`run-card${active ? " run-card-active" : ""}${game.status === "paused" ? " run-card-paused" : ""}`} href={href}>
      <div className="run-card-summary">
        <StatusBadge status={game.status} />
        <strong>{title}</strong>
        <span>{game.playerCount} players · {game.eventCount} events</span>
      </div>
      <div className="run-card-meta">
        {game.createdAt ? <LocalTime value={game.createdAt} /> : <span>Not started</span>}
        <span className="run-card-link">Open game <span aria-hidden="true">→</span></span>
      </div>
    </Link>
  );
}
