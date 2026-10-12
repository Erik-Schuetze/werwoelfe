import { connection } from "next/server";

import { isViewerMode } from "@/lib/mode";
import { proxyOperatorGet } from "@/lib/server/operator-client";

/**
 * One run's detail, proxied to the operator's read-only `/api/public/games/<id>`.
 *
 * Viewer-only, mirroring the index route and the operator-only guard on the other side. The path is
 * built here rather than passed through whole, so nothing a client sends can steer this proxy off
 * the `/api/public/` prefix it is meant to front.
 */
export async function GET(_request: Request, context: RouteContext<"/api/viewer/games/[id]">) {
  await connection();
  if (!isViewerMode()) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const { id } = await context.params;
  return proxyOperatorGet(`/api/public/games/${id}`);
}
