import { notFound } from "next/navigation";
import { connection } from "next/server";

import { AudienceIndex } from "@/components/audience-index";
import { ViewerUnavailable } from "@/components/viewer-unavailable";
import type { GameSummary } from "@/lib/game";
import { isViewerMode } from "@/lib/mode";
import { environment } from "@/lib/server/env";
import { getOperatorJson } from "@/lib/server/operator-client";

export const instant = false;

export default async function ViewerHome() {
  await connection();
  // The proxy in `proxy.ts` is the first gate; this is the second, so the operator's own pages
  // can never be served from a viewer process even if the gate is misconfigured.
  if (!isViewerMode()) {
    notFound();
  }
  const result = await getOperatorJson<{ games: GameSummary[] }>("/api/public/games");
  if (!result.ok) {
    return <ViewerUnavailable />;
  }
  return <AudienceIndex initialGames={result.data.games} pollMs={environment.viewerPollMs} />;
}
