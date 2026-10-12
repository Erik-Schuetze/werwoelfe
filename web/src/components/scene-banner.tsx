"use client";

import type { Beat } from "@/lib/beats";

/**
 * The scene signpost. A zone change — the day's discussion giving way to the
 * vote, the vote to the tally, the day to the night — is the one moment the
 * stage has to answer "where are we now?", and it is made an explicit banner
 * rather than left to be inferred from a header that quietly changed. The
 * research on display momentum is blunt about it: the effort a viewer spends
 * re-placing a new arrangement in context is exactly what kills momentum, and
 * the failure mode is excessive sameness between zones.
 *
 * The wording is not invented here. A marker beat already carries its
 * `MARKER_TITLES` headline; everything else is named by the phase it belongs to,
 * `phase.scene` over `phase.actTitle`, so the banner and the stage header can
 * never disagree about what a scene is called.
 */

/**
 * The stage's scene modes, one per kind — the stage body carries the mode as
 * `data-scene` so a scene can restyle the whole box, and so each kind fills the
 * card alone (a story scene, a ballot, a tally) or hands off to the two-slot
 * dialogue box. There is no growing transcript here: the stage shows the moment.
 */
export type Scene = "dialogue" | "ballot" | "results" | "night" | "elimination" | "banner";

export function sceneOf(beat: Beat | undefined): Scene {
  switch (beat?.kind) {
    case "speech":
    case "pileOn":
    case "passRun":
      return "dialogue";
    case "ballot":
      return "ballot";
    case "voteTally":
      return "results";
    case "night":
      return "night";
    case "elimination":
      return "elimination";
    default:
      // Marker, text, and the empty stage: a bare banner.
      return "banner";
  }
}

export type SceneBannerData = {
  /** Stable per zone, so a change remounts the banner and its entrance replays. */
  key: string;
  title: string;
  detail: string;
};

/**
 * The banner for a scene change, or `null` while the scene holds — and on the
 * very first beat, whose scene the header already establishes.
 *
 * The trigger is a single boolean over the immediately previous beat: the banner
 * shows when the phase scene changed **or** the stage zone changed. The tally
 * shares a phase scene with the ballot that produced it — no phase event sits
 * between `vote_cast` and `votes_tallied` — so a scene-only trigger would leave
 * the voting-results transition silent; the zone catches it. The `or` keeps it
 * to one banner per boundary: the ballot→tally and discussion→ballot flips the
 * user named are each a single transition, so the day reads as a few deliberate
 * signposts, not a wall of them.
 */
/**
 * What a zone is called when the phase itself has not named it. The tally shares
 * its phase scene with the ballot that produced it, so without these the ballot →
 * tally → dawn run would print the *identical* banner three beats running instead
 * of three signposts. Only consulted when the scene did **not** change: where the
 * engine has a name for the moment ("Exile vote"), the engine's name wins.
 */
const ZONE_TITLE: Partial<Record<Scene, string>> = {
  ballot: "The vote",
  results: "The tally",
  night: "Night falls",
  elimination: "Dawn",
};

export function sceneBanner(beat: Beat, previous: Beat | undefined): SceneBannerData | null {
  if (!previous) return null;
  const sameScene = previous.phase.scene === beat.phase.scene;
  const sameZone = sceneOf(previous) === sceneOf(beat);
  if (sameScene && sameZone) return null;
  const zone = sceneOf(beat);
  const zoneTitle = sameScene ? ZONE_TITLE[zone] : undefined;
  return {
    // The zone is part of the key, so a zone change remounts the banner and its
    // entrance replays even when the act and scene are unchanged.
    key: `${beat.phase.actTitle}·${beat.phase.scene}·${zone}`,
    // A marker's headline is its MARKER_TITLES title; otherwise the engine's name
    // for the scene, falling back to the zone's own name for the transitions the
    // phase has no name for.
    title: beat.kind === "marker" ? beat.title : zoneTitle ?? beat.phase.scene,
    detail: beat.phase.actTitle,
  };
}

export function SceneBanner({ banner }: { banner: SceneBannerData }) {
  return (
    <p className="scene-banner">
      <span className="eyebrow">{banner.detail}</span>
      {banner.title}
    </p>
  );
}
