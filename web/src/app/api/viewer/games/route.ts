import { connection } from "next/server";

import { isViewerMode } from "@/lib/mode";
import { proxyOperatorGet } from "@/lib/server/operator-client";

/**
 * The audience's run index: a pass-through to the operator's read-only `/api/public/games`.
 *
 * Viewer-only. The operator serves the audience pages directly from its own database and has no
 * `/api/viewer/*` of its own, so answering here in operator mode would only be a confusing alias.
 * The guard mirrors the operator-only guard on `/api/public/*`, so each surface answers in exactly
 * the mode that owns it. All the proxying — and the caching, and the 502 on an unreachable operator
 * — lives in `operator-client.ts`, the viewer's single network seam.
 */
export async function GET() {
  await connection();
  if (!isViewerMode()) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  return proxyOperatorGet("/api/public/games");
}
