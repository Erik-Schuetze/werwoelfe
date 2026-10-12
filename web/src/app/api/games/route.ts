import { connection } from "next/server";

import { listGames } from "@/lib/server/db";
import { startGame } from "@/lib/server/runner";
import { launchRequestSchema } from "@/lib/server/schema";

export async function GET() {
  await connection();
  return Response.json({ games: listGames() });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsed = launchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "The game configuration is invalid.", details: parsed.error.issues },
      { status: 400 },
    );
  }
  try {
    const game = await startGame(parsed.data.config, parsed.data.seed);
    return Response.json({ game }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not launch the game.";
    const status = /can run at once/.test(message) ? 409 : 500;
    return Response.json({ error: message }, { status });
  }
}
