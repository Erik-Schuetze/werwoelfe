import { connection } from "next/server";

import { isGameId } from "@/lib/game-id";
import { isViewerMode } from "@/lib/mode";
import { proxyOperatorGet } from "@/lib/server/operator-client";

/**
 * One run's detail, proxied to the operator's read-only `/api/public/games/<id>`.
 *
 * Viewer-only, mirroring the index route and the operator-only guard on the other side. The path is
 * built here rather than passed through whole, so nothing a client sends can steer this proxy off
 * the `/api/public/` prefix it is meant to front.
 *
 * The id is validated first, before any path exists to be steered. Only a UUID passes — the exact
 * shape `randomUUID()` writes in `runner.ts` — so a traversal, whether it arrives decoded
 * (`../../api/games`) or still encoded after Next's single decode (`..%2f..%2fapi%2fgames`,
 * `%2e%2e%2f…`), is answered 404 here rather than handed to `resolvePublicPath` to reason about. The
 * proxy still confines every request to `/api/public/` as its own layer; this is the gate in front.
 */
export async function GET(_request: Request, context: RouteContext<"/api/viewer/games/[id]">) {
  await connection();
  if (!isViewerMode()) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const { id } = await context.params;
  if (!isGameId(id)) {
    return Response.json({ error: "Game not found." }, { status: 404 });
  }
  return proxyOperatorGet(`/api/public/games/${id}`);
}
