import { connection } from "next/server";

import { pauseRunningGame, refreshGame, restartGame, resumePausedGame, stopGame } from "@/lib/server/runner";

export async function GET(_request: Request, context: RouteContext<"/api/games/[id]">) {
  await connection();
  const { id } = await context.params;
  const game = await refreshGame(id);
  if (!game) {
    return Response.json({ error: "Game not found." }, { status: 404 });
  }
  return Response.json({ game });
}

export async function DELETE(_request: Request, context: RouteContext<"/api/games/[id]">) {
  await connection();
  const { id } = await context.params;
  try {
    return Response.json({ game: await stopGame(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not stop the game.";
    return Response.json({ error: message }, { status: message === "Game not found." ? 404 : 409 });
  }
}

export async function POST(_request: Request, context: RouteContext<"/api/games/[id]">) {
  await connection();
  const { id } = await context.params;
  try {
    return Response.json({ game: await restartGame(id) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not restart the game.";
    return Response.json({ error: message }, { status: message === "Game not found." ? 404 : 409 });
  }
}

export async function PATCH(request: Request, context: RouteContext<"/api/games/[id]">) {
  await connection();
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("action" in body) || (body.action !== "pause" && body.action !== "resume")) {
    return Response.json({ error: 'action must be either "pause" or "resume".' }, { status: 400 });
  }
  try {
    const game = body.action === "pause" ? await pauseRunningGame(id) : await resumePausedGame(id);
    return Response.json({ game });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the game.";
    return Response.json({ error: message }, { status: message === "Game not found." ? 404 : 409 });
  }
}
