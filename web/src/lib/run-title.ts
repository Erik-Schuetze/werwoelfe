/**
 * The name a run is shown under.
 *
 * A finished run carries a title its own engine wrote at the end of the game —
 * playful, and passed through a spoiler gate before it was stored, because the
 * whole run (outcome included) is in that namer's context. But titles only exist
 * from now on: every run recorded before this, and any run whose naming failed,
 * arrives with `null`.
 *
 * So the fallback matters as much as the title: it is built from non-revealing
 * facts only. The outcome is deliberately absent from the furniture — the heading
 * and the run cards — because a run reveals how it ends at its final beat, as part
 * of watching it. Nothing you glance at should tell you.
 *
 * The parameter is structural rather than `GameSummary` so this stays independent
 * of the type gaining its `title` field.
 */
type TitledRun = {
  title?: string | null;
  status: string;
  playerCount: number;
};

export function runTitle(game: TitledRun): string {
  const named = game.title?.trim();
  if (named) return named;

  const live = game.status === "queued" || game.status === "running" || game.status === "paused";
  return live ? "The table is gathering" : `Village of ${game.playerCount}`;
}
