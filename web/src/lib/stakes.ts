import type { GamePlayer } from "@/lib/game";
import type { BallotBeat, Beat, NightBeat, SpeakerRef } from "@/lib/beats";
import type { Beliefs, TruthLevel } from "@/lib/truth";

/**
 * The stakes rail: what is being decided, who is on the block, and what the
 * night actually did. Everything is derived from the beats already presented,
 * so the rail can never run ahead of the stage.
 */

// --------------------------------------------------------------------------
// Vote board
// --------------------------------------------------------------------------

export type VoteBoard = {
  scope: "sheriff" | "exile";
  label: string;
  counts: { player: SpeakerRef | null; count: number; voters: SpeakerRef[] }[];
  official: { target: SpeakerRef | null; count: number }[] | null;
  cast: number;
  settled: boolean;
};

function tallyBallot(ballot: BallotBeat): VoteBoard["counts"] {
  const byTarget = new Map<string, { player: SpeakerRef | null; count: number; voters: SpeakerRef[] }>();
  for (const vote of ballot.votes) {
    const key = vote.target?.id ?? "?";
    const row = byTarget.get(key) ?? { player: vote.target, count: 0, voters: [] };
    row.count += 1;
    if (vote.voter) row.voters.push(vote.voter);
    byTarget.set(key, row);
  }
  return [...byTarget.values()].sort((a, b) => b.count - a.count);
}

/** The most recent ballot at or before the cursor, with its official count if published. */
export function currentVoteBoard(beats: Beat[], upToIndex: number): VoteBoard | null {
  let ballotIndex = -1;
  for (let index = Math.min(upToIndex, beats.length - 1); index >= 0; index -= 1) {
    if (beats[index].kind === "ballot") {
      ballotIndex = index;
      break;
    }
  }
  if (ballotIndex < 0) return null;

  const ballot = beats[ballotIndex] as BallotBeat;
  const next = beats[ballotIndex + 1];
  const official = next && next.kind === "voteTally" ? next.counts : null;
  const settled =
    Boolean(official) ||
    Boolean(next && (next.kind === "elimination" || next.kind === "marker"));

  return {
    scope: ballot.scope,
    label: ballot.label,
    counts: tallyBallot(ballot),
    official,
    cast: ballot.votes.length,
    settled,
  };
}

// --------------------------------------------------------------------------
// Night ledger
// --------------------------------------------------------------------------

export type LedgerEntry = {
  night: number;
  wolves: string[];
  mealVictim: SpeakerRef | null;
  mealTied: boolean;
  checks: { target: SpeakerRef | null; result: string }[];
  plans: { speaker: SpeakerRef | null; body: string }[];
  deliberationMs: number | null;
};

export function nightLedger(beats: Beat[], upToIndex: number): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (let index = 0; index <= Math.min(upToIndex, beats.length - 1); index += 1) {
    const beat = beats[index];
    if (beat.kind !== "night") continue;
    const night = beat as NightBeat;
    entries.push({
      night: night.night,
      wolves: night.wolves,
      mealVictim: night.mealVictim,
      mealTied: night.mealTied,
      checks: night.checks,
      plans: night.plans,
      // The engine's one honest use of wall-clock: how long the pack took.
      deliberationMs: night.mealAt
        ? Math.max(0, Date.parse(night.mealAt) - Date.parse(night.at))
        : null,
    });
  }
  return entries;
}

// --------------------------------------------------------------------------
// The case on the table
// --------------------------------------------------------------------------

export type CaseOnTable = {
  suspect: SpeakerRef | null;
  score: number;
  confidence: "low" | "medium" | "high";
  fromVote: boolean;
};

/** The engine's own threshold for a village that has actually settled on someone. */
const DECLARE_AT = 3;
const RECENT_SPEECHES = 20;

/**
 * Who the village is currently pressing. Prefers the vote that is actually on
 * the floor, then a live pile-on, then a recency-weighted read of who is being
 * named. Declares nothing until the evidence reaches the pile-on threshold, so
 * the rail and the runway agree about when a case has formed.
 */
export function caseOnTable(
  beats: Beat[],
  upToIndex: number,
  beliefs: Beliefs,
  maxSeq: number,
): CaseOnTable | null {
  // Nobody is making a case while the village sleeps.
  const stage = beats[Math.min(upToIndex, beats.length - 1)];
  if (stage && (stage.kind === "night" || stage.phase.actKind === "night")) return null;

  // A case is only against someone the village can still act on. Players *talk*
  // about the dead — a villager can be named 22 times in a round and still be in
  // the ground — so without this filter the loudest name on the floor is often a
  // corpse, and the seat grid puts that corpse on the block.
  const dead = new Set<string>();
  for (let index = 0; index <= Math.min(upToIndex, beats.length - 1); index += 1) {
    const beat = beats[index];
    if (beat.kind === "elimination" && beat.player?.id) dead.add(beat.player.id);
  }

  // Only an exile ballot is a case *against* someone; a sheriff election is not.
  // A cast ballot is explicit, so it needs a lower bar than an inferred mention.
  const board = currentVoteBoard(beats, upToIndex);
  if (board?.scope === "exile" && board.cast > 0) {
    const leader = board.counts[0];
    if (leader && leader.count >= 2 && !(leader.player && dead.has(leader.player.id))) {
      return {
        suspect: leader.player,
        score: leader.count,
        confidence: leader.count >= 4 ? "high" : "medium",
        fromVote: true,
      };
    }
  }

  // A pile-on that the runway has already collapsed is a declared case.
  for (let index = Math.min(upToIndex, beats.length - 1); index >= 0; index -= 1) {
    const beat = beats[index];
    if (beat.kind === "pileOn" && beat.collapsed && !(beat.target && dead.has(beat.target.id))) {
      return {
        suspect: beat.target,
        score: beat.voices.length,
        confidence: beat.voices.length >= 4 ? "high" : "medium",
        fromVote: false,
      };
    }
    if (beat.kind === "ballot" || beat.kind === "night") break;
  }

  // Otherwise score the last stretch of speech: a mention inside an accusation
  // counts double.
  const speechSeqs = beats
    .slice(0, Math.min(upToIndex, beats.length - 1) + 1)
    .filter((beat) => beat.kind === "speech")
    .map((beat) => beat.firstSeq);
  const floor = speechSeqs.length > RECENT_SPEECHES ? speechSeqs[speechSeqs.length - RECENT_SPEECHES] : 0;

  const scores = new Map<string, { score: number; ref: SpeakerRef | null }>();
  for (const [targetId, mentions] of beliefs.mentions) {
    if (dead.has(targetId)) continue;
    let score = 0;
    for (const mention of mentions) {
      if (mention.seq > maxSeq || mention.seq < floor) continue;
      score += mention.cued ? 2 : 1;
    }
    if (score > 0) scores.set(targetId, { score, ref: refFor(targetId, beats) });
  }

  let best: { id: string; score: number; ref: SpeakerRef | null } | null = null;
  for (const [id, entry] of scores) {
    if (!best || entry.score > best.score) best = { id, score: entry.score, ref: entry.ref };
  }
  if (!best || best.score < DECLARE_AT) return null;
  return {
    suspect: best.ref,
    score: best.score,
    confidence: best.score >= 6 ? "high" : "medium",
    fromVote: false,
  };
}

/** Resolve an id to a name using any beat that has already spoken about them. */
function refFor(id: string, beats: Beat[]): SpeakerRef | null {
  for (const beat of beats) {
    if (beat.kind === "elimination" && beat.player?.id === id) return beat.player;
    if (beat.kind === "pileOn" && beat.target?.id === id) return beat.target;
    if (beat.kind === "speech" && beat.speaker?.id === id) return beat.speaker;
    if (beat.kind === "ballot") {
      for (const vote of beat.votes) {
        if (vote.voter?.id === id) return vote.voter;
        if (vote.target?.id === id) return vote.target;
      }
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Seats
// --------------------------------------------------------------------------

export type SeatState = {
  id: string;
  name: string;
  alive: boolean;
  fate: "eaten" | "exiled" | null;
  /** Holds the floor in the current beat. */
  speaking: boolean;
  /** The village's live suspect. */
  onBlock: boolean;
  /** Has cast a ballot in the vote currently on the floor. */
  hasVotedIn: boolean;
  votes: number;
};

export function seatStates(
  players: GamePlayer[],
  beats: Beat[],
  upToIndex: number,
  suspectId: string | null,
  level: TruthLevel = "blind",
): Map<string, SeatState> {
  const censor = Math.min(upToIndex, beats.length - 1);
  const seats = new Map<string, SeatState>();
  for (const player of players) {
    seats.set(player.id, {
      id: player.id,
      name: player.name,
      alive: true,
      fate: null,
      speaking: false,
      onBlock: player.id === suspectId,
      hasVotedIn: false,
      votes: 0,
    });
  }

  for (let index = 0; index <= censor; index += 1) {
    const beat = beats[index];
    if (beat.kind === "elimination" && beat.player) {
      const seat = seats.get(beat.player.id);
      if (seat) {
        seat.alive = false;
        seat.fate = beat.cause === "unknown" ? null : beat.cause;
      }
    }
    // Above blind the night scene has already shown what the pack chose, so the
    // meal victim's seat can go dark with it. At blind the removal stays hidden
    // until the public dawn beat above strikes it.
    if (level !== "blind" && beat.kind === "night" && beat.mealVictim) {
      const seat = seats.get(beat.mealVictim.id);
      if (seat) {
        seat.alive = false;
        seat.fate = "eaten";
      }
    }
  }

  // Ballots in the vote currently on the floor only.
  const board = currentVoteBoard(beats, censor);
  if (board && !board.settled) {
    for (let index = censor; index >= 0; index -= 1) {
      const beat = beats[index];
      if (beat.kind !== "ballot") continue;
      for (const vote of beat.votes) {
        const seat = vote.voter ? seats.get(vote.voter.id) : null;
        if (seat) {
          seat.hasVotedIn = true;
          seat.votes += 1;
        }
      }
      break;
    }
  }

  const current = censor >= 0 ? beats[censor] : undefined;
  if (current) {
    if (current.kind === "speech" && current.speaker) {
      const seat = seats.get(current.speaker.id);
      if (seat) seat.speaking = true;
    } else if (current.kind === "pileOn") {
      const last = current.voices[current.voices.length - 1];
      const seat = last?.speaker ? seats.get(last.speaker.id) : null;
      if (seat) seat.speaking = true;
    }
  }

  return seats;
}
