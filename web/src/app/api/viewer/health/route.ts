import { connection } from "next/server";

/**
 * The viewer's own liveness/readiness endpoint, answering locally.
 *
 * It deliberately does not probe the operator. Were readiness to depend on the operator's health, an
 * operator blip would fail every viewer replica at once and the Deployment would restart them into
 * the same outage — the pages themselves already degrade to the "unavailable, retrying" panel, which
 * is the right place to absorb an operator outage. This endpoint answers only "is this process able
 * to serve at all". Exporting only `GET` makes every other verb a structural 405.
 */
export async function GET() {
  await connection();
  return Response.json({ ok: true });
}
