import type { GameEvent, GamePlayer } from "@/lib/game";
import { findTargetPositions, parseSpeaker, type PlayerIndex } from "@/lib/beats";

/**
 * The dramatic-irony layer: what is actually true, against what the village
 * believes. Ground truth renders solid; belief renders ghosted.
 *
 * Everything here is `sequence`-gated at the playback cursor, with one
 * deliberate exception — the final roster is knowledge about the whole run, so
 * the seats can show a player's true role from the first beat. That gap is the
 * show: the audience watches the village walk past the answer.
 */

export type Role = "werewolf" | "villager" | "seer";
export type TruthLevel = "blind" | "spectator" | "director";

export type GroundTruth = {
  /**
   * `roster`  — every player's final role, already on the wire for a completed
   *             run. Exact.
   * `derived` — rebuilt from the private night recipients. Verified to
   *             reproduce the roster exactly; available from night 1 onwards.
   * `none`    — not enough night evidence yet (or an old-engine run with no
   *             werewolf events at all).
   */
  source: "roster" | "derived" | "none";
  roles: Map<string, Role | "unknown">;
  wolves: string[];
  seerId: string | null;
};

export function deriveGroundTruth(
  players: GamePlayer[],
  events: GameEvent[],
  upToSeq = Number.POSITIVE_INFINITY,
): GroundTruth {
  const rosterComplete = players.length > 0 && players.every((player) => Boolean(player.role));
  if (rosterComplete) {
    const roles = new Map<string, Role | "unknown">();
    const wolves: string[] = [];
    let seerId: string | null = null;
    for (const player of players) {
      const role = player.role as Role;
      roles.set(player.id, role);
      if (role === "werewolf") wolves.push(player.id);
      if (role === "seer") seerId = player.id;
    }
    return { source: "roster", roles, wolves, seerId };
  }

  const wolves: string[] = [];
  let seerId: string | null = null;
  for (const event of events) {
    if (event.sequence > upToSeq) break;
    if (
      event.kind.startsWith("werewolf") ||
      event.kind === "meal_chosen" ||
      event.kind === "meal_choice_tied"
    ) {
      for (const recipient of event.recipients) {
        if (!wolves.includes(recipient)) wolves.push(recipient);
      }
    } else if (event.kind === "investigation_result" && event.recipients[0]) {
      seerId = event.recipients[0];
    }
  }

  const roles = new Map<string, Role | "unknown">();
  if (wolves.length === 0 || !seerId) {
    for (const player of players) roles.set(player.id, "unknown");
    return { source: "none", roles, wolves, seerId };
  }
  for (const player of players) {
    roles.set(player.id, wolves.includes(player.id) ? "werewolf" : player.id === seerId ? "seer" : "villager");
  }
  return { source: "derived", roles, wolves, seerId };
}

export function roleLabel(role: Role | "unknown" | null): string {
  switch (role) {
    case "werewolf":
      return "Werewolf";
    case "seer":
      return "Fortune Teller";
    case "villager":
      return "Villager";
    default:
      return "Unknown";
  }
}

// --------------------------------------------------------------------------
// Belief — what the village is doing, whether or not it is right
// --------------------------------------------------------------------------

export type Beliefs = {
  /** target id -> the players who named them, in order. */
  mentions: Map<string, { byId: string; seq: number; cued: boolean }[]>;
  /** speaker id -> the ids they have named. */
  targetsOf: Map<string, string[]>;
  /** voter id -> target id -> count. */
  voteTargets: Map<string, Map<string, number>>;
  sheriffId: string | null;
};

/** A mention inside a sentence that is actually accusing someone. */
const ACCUSE_CUE =
  /\b(wolf|werewolf|liar|lying|lies|suspect|bluff|guilty|cover|dodge|deflect|throwing|shield|not clean)\b/i;

function sentenceAround(body: string, index: number): string {
  const start = body.lastIndexOf(".", index) + 1;
  const end = body.indexOf(".", index);
  return body.slice(start, end < 0 ? undefined : end);
}

export function deriveBeliefs(
  events: GameEvent[],
  index: PlayerIndex,
  upToSeq = Number.POSITIVE_INFINITY,
): Beliefs {
  const mentions = new Map<string, { byId: string; seq: number; cued: boolean }[]>();
  const targetsOf = new Map<string, string[]>();
  const voteTargets = new Map<string, Map<string, number>>();
  let sheriffId: string | null = null;

  const addMention = (targetId: string, byId: string, seq: number, cued: boolean): void => {
    const list = mentions.get(targetId) ?? [];
    list.push({ byId, seq, cued });
    mentions.set(targetId, list);
  };

  for (const event of events) {
    if (event.sequence > upToSeq) break;
    if (event.visibility !== "public") continue;

    switch (event.kind) {
      case "town_hall_message":
      case "player_introduced": {
        const parsed = parseSpeaker(event, index);
        const speakerId = parsed.speaker?.id ?? null;
        const body = parsed.body.replace(/\s*\[Time is up\.\]$/, "");
        for (const { id: targetId, at } of findTargetPositions(body, speakerId, index)) {
          const cued = ACCUSE_CUE.test(sentenceAround(body, at));
          addMention(targetId, speakerId ?? "?", event.sequence, cued);
          if (speakerId) {
            const list = targetsOf.get(speakerId) ?? [];
            if (!list.includes(targetId)) list.push(targetId);
            targetsOf.set(speakerId, list);
          }
        }
        break;
      }
      case "vote_cast": {
        const match = /^(.+?) votes for (.+)\.$/.exec(event.message);
        if (!match) break;
        const voter = index.byName.get(match[1].trim());
        const target = index.byName.get(match[2].trim());
        if (!voter || !target) break;
        const row = voteTargets.get(voter) ?? new Map<string, number>();
        row.set(target, (row.get(target) ?? 0) + 1);
        voteTargets.set(voter, row);
        break;
      }
      case "sheriff_elected":
      case "sheriff_succeeded": {
        const match = /^(.+?) is (?:the new|the) Sheriff\.$/.exec(event.message);
        if (match) sheriffId = index.byName.get(match[1].trim()) ?? sheriffId;
        break;
      }
      default:
        break;
    }
  }

  return { mentions, targetsOf, voteTargets, sheriffId };
}

export function emptyBeliefs(): Beliefs {
  return { mentions: new Map(), targetsOf: new Map(), voteTargets: new Map(), sheriffId: null };
}

export type AlignmentGap = {
  state: "on" | "off" | "clear" | "unknown";
  text: string;
};

/**
 * The payoff line: is the village's live suspect the truth, or a villager?
 * Never rendered in blind mode — it would give the game away.
 */
export function alignmentGap(
  truth: GroundTruth,
  suspectId: string | null,
  eliminated: Set<string>,
): AlignmentGap {
  if (truth.source === "none") {
    return { state: "unknown", text: "The village has no leads yet." };
  }
  const stillAtLarge = truth.wolves.filter((id) => !eliminated.has(id));
  if (stillAtLarge.length === 0) {
    return { state: "clear", text: "The pack is gone — the village only has to finish it." };
  }
  if (!suspectId) {
    return { state: "unknown", text: "The village has no live suspect." };
  }
  if (truth.roles.get(suspectId) === "werewolf") {
    return { state: "on", text: "The village has its hands on a werewolf." };
  }
  return {
    state: "off",
    text:
      stillAtLarge.length === 1
        ? "The village is walking toward a villager. The wolf is untouched."
        : `The village is walking toward a villager. All ${stillAtLarge.length} werewolves are untouched.`,
  };
}
