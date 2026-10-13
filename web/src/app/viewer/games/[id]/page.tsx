import { notFound } from "next/navigation";
import { connection } from "next/server";

import { GameDetail } from "@/components/game-detail";
import { ViewerUnavailable } from "@/components/viewer-unavailable";
import type { GameDetail as GameDetailData } from "@/lib/game";
import { isGameId } from "@/lib/game-id";
import { isViewerMode } from "@/lib/mode";
import { environment } from "@/lib/server/env";
import { getOperatorJson } from "@/lib/server/operator-client";

export const instant = false;

export default async function ViewerGamePage({ params }: PageProps<"/viewer/games/[id]">) {
  await connection();
  // The proxy in `proxy.ts` is the first gate; this is the second.
  if (!isViewerMode()) {
    notFound();
  }
  const { id } = await params;
  // Only a UUID can name a run, so anything else is the operator's own 404 verdict decided one hop
  // earlier — before the id is ever interpolated into a path. This is the primary gate;
  // `resolvePublicPath` in `operator-client.ts` is the confinement behind it.
  if (!isGameId(id)) {
    notFound();
  }
  const result = await getOperatorJson<{ game: GameDetailData }>("/api/public/games/" + id);
  if (!result.ok) {
    // "not-found" is the operator's own verdict — a run that never existed, or one the audience
    // does not list. "unreachable" is the operator itself being down, which is not the reader's
    // error and gets the friendly panel rather than a 404.
    if (result.reason === "not-found") {
      notFound();
    }
    return <ViewerUnavailable />;
  }
  return <GameDetail initialGame={result.data.game} mode="viewer" pollMs={environment.viewerPollMs} />;
}
