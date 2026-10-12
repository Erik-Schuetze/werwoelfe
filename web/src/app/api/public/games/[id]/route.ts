import { connection } from "next/server";

import { isOperatorMode } from "@/lib/mode";
import { getGameDetail } from "@/lib/server/db";

/**
 * One run's full detail, as the audience sees it.
 *
 * Operator-only and a pure read, for the same reasons as the index: the viewer has no database and
 * must never drive a write on the writer. `getGameDetail` reuses the operator's own shape, so the
 * payload stays `GameDetail`-shaped rather than a narrower public projection — private events are
 * shipped as they are, since "public/private" is a spoiler axis here, not a secrecy boundary.
 *
 * A `failed` or `cancelled` run is a 404 as well as a missing one: those are the two statuses the
 * audience index hides, so a direct link must not resurrect them. Exporting only `GET` is what makes
 * every other verb a structural 405.
 */
export async function GET(_request: Request, context: RouteContext<"/api/public/games/[id]">) {
  await connection();
  if (!isOperatorMode()) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const { id } = await context.params;
  const game = getGameDetail(id);
  if (!game || game.status === "failed" || game.status === "cancelled") {
    return Response.json({ error: "Game not found." }, { status: 404 });
  }
  return Response.json({ game });
}
