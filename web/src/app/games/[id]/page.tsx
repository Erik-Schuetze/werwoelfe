import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GameDetail } from "@/components/game-detail";
import { refreshGame } from "@/lib/server/runner";

export const instant = false;

export default async function GamePage({ params }: PageProps<"/games/[id]">) {
  await connection();
  const { id } = await params;
  const game = await refreshGame(id);
  if (!game) {
    notFound();
  }
  return <GameDetail initialGame={game} />;
}
