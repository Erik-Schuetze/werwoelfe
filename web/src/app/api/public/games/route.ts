import { connection } from "next/server";

import { isOperatorMode } from "@/lib/mode";
import { listPublicGames } from "@/lib/server/db";

/**
 * The operator's public run index: everything the audience is allowed to read.
 *
 * Operator-only. The viewer holds no database, so this endpoint answering in a viewer process would
 * only ever fail; the viewer reaches the same data through `/api/viewer/games`, which proxies back
 * here. The guard is the second layer behind the proxy gate, and it is what makes an accidental
 * direct hit on `/api/public/*` a 404 rather than a second, unproxied public surface.
 *
 * A pure read, deliberately: it ingests nothing, so public traffic can never drive a write on the
 * operator no matter how much of it there is. Exporting only `GET` is what makes every other verb a
 * structural 405.
 */
export async function GET() {
  await connection();
  if (!isOperatorMode()) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  return Response.json({ games: listPublicGames() });
}
