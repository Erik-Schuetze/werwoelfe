import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GameDetail } from "@/components/game-detail";
import { isViewerMode } from "@/lib/mode";
import { refreshGame } from "@/lib/server/runner";

export const instant = false;

export default async function GamePage({ params }: PageProps<"/games/[id]">) {
  await connection();
  // The proxy already 404s this path in viewer mode; the audience reaches the same run under
  // /viewer. The guard sits before `refreshGame` so the viewer never ingests.
  if (isViewerMode()) {
    notFound();
  }
  const { id } = await params;
  const game = await refreshGame(id);
  if (!game) {
    notFound();
  }
  return <GameDetail initialGame={game} mode="operator" />;
}
