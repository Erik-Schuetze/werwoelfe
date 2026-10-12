"use client";

import { memo } from "react";

import type { Beat, SpeakerRef, Voice } from "@/lib/beats";
import { GROUPING } from "@/lib/beats";
import { roleLabel, type GroundTruth, type Role, type TruthLevel } from "@/lib/truth";

export type BeatCardProps = {
  beat: Beat;
  level: TruthLevel;
  reasoning: boolean;
  truth: GroundTruth;
  /** Resolve a player id to a display name. Stable identity keeps this memoised. */
  nameOf: (id: string) => string;
  /**
   * The current speaker's voice — a short description of how they talk. Supplied
   * only by the stage's live slot, so the transcript and the greyed past slot
   * carry no copy of it; absent, nothing renders.
   */
  voiceOf?: (id: string) => string | undefined;
  expanded: boolean;
  onToggle: (key: string) => void;
  /** The rail already shows the night ledger; the log keeps it terse. */
  compact?: boolean;
  /**
   * How many characters of the beat's prose to show. `null`/absent renders the
   * text plain and never animates — the full-transcript log and the greyed past
   * slot both pass nothing. The stage passes `revealedChars`.
   */
  reveal?: number | null;
};

/** Clamp a bar ratio to 0..1. Pure, so it stays clear of the render-compiler rules. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Start offset of each token, so a word can be compared to the reveal cursor. */
function tokenStarts(tokens: string[]): number[] {
  const starts: number[] = [];
  let at = 0;
  for (const token of tokens) {
    starts.push(at);
    at += token.length;
  }
  return starts;
}

/**
 * Where each body starts once the bodies are joined with single spaces — the
 * same shape `revealText` produces — so a per-voice reveal budget can be read
 * off the one shared cursor.
 */
function joinOffsets(bodies: string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const body of bodies) {
    offsets.push(at);
    at += body.length + 1;
  }
  return offsets;
}

/**
 * The word-by-word reveal, shared by every prose beat.
 *
 * The whole line is in the DOM from the first paint: words past the reveal
 * cursor only lose their opacity, never their box, so the text can never reflow
 * as it types on. That is the whole point — a reveal that reflows the box is
 * worse than no reveal at all.
 *
 * Accessibility is not optional. The stage is an `aria-live` region, so the
 * word fragments must never reach a screen reader or the line would be
 * announced one word at a time. The fragments are hidden and the finished line
 * is exposed once, beside them, through `.visually-hidden` — one announcement
 * per beat, never per word.
 *
 * `revealed === null` means "render plain": under instant and reduced motion the
 * stage itself passes the full length, so nothing is ever pending.
 */
function RevealText({ text, revealed }: { text: string; revealed: number | null }) {
  if (revealed === null) return <>{text}</>;
  const tokens = text.split(/(\s+)/);
  const starts = tokenStarts(tokens);
  return (
    <>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">
        {tokens.map((token, index) => {
          // Whitespace runs are kept verbatim so the offsets match `revealText`.
          if (token.trim() === "") return token;
          const pending = starts[index] >= revealed;
          return (
            <span className={pending ? "reveal-word is-pending" : "reveal-word"} key={index}>
              {token}
            </span>
          );
        })}
      </span>
    </>
  );
}

function RoleChip({
  playerId,
  truth,
  level,
}: {
  playerId: string | null | undefined;
  truth: GroundTruth;
  level: TruthLevel;
}) {
  if (level === "blind" || !playerId) return null;
  const role = truth.roles.get(playerId);
  if (!role || role === "unknown") return null;
  return <em className={`role-chip is-${role}`}>{roleLabel(role)}</em>;
}

function SpeakerTag({
  speaker,
  truth,
  level,
}: {
  speaker: SpeakerRef | null;
  truth: GroundTruth;
  level: TruthLevel;
}) {
  if (!speaker) return <span className="beat-speaker is-unknown">Unattributed</span>;
  return (
    <span className="beat-speaker">
      <strong>{speaker.name}</strong>
      <RoleChip playerId={speaker.id} truth={truth} level={level} />
    </span>
  );
}

/**
 * Has this prose finished typing on?
 *
 * `null` is the stage's "render plain" value — instant speed, reduced motion, or
 * a voice the reader expanded out past the reveal budget — and it means the whole
 * line is in the DOM from the first paint, so it counts as finished.
 */
function isRevealed(text: string, revealed: number | null): boolean {
  return revealed === null || revealed >= text.length;
}

function Body({ voice, reveal }: { voice: Voice; reveal: number | null }) {
  // The cut marker belongs to the *end* of the sentence, so it lands with the
  // last word rather than sitting at the head of a line that has not been written
  // yet — a reader who sees "cut off" before the text it annotates reads the
  // message as cut short before it even began.
  return (
    <p className="beat-body">
      <RevealText text={voice.body} revealed={reveal} />
      {voice.truncated && isRevealed(voice.body, reveal) ? (
        <span className="beat-cut">cut off</span>
      ) : null}
    </p>
  );
}

function Speech({ props, beat }: { props: BeatCardProps; beat: Extract<Beat, { kind: "speech" }> }) {
  const showThought = Boolean(beat.thought) && (props.reasoning || props.level === "director");
  // A speech has exactly one speaker, so its voice can sit under the name. The
  // line is aria-hidden: the stage is a live region and the voice must not be
  // announced as a beat of its own — the cast panel carries the same text for a
  // reader who wants it. It is deliberately not part of the reveal: the prose
  // below it is the point, and this must not type on with it.
  const voice = beat.speaker ? props.voiceOf?.(beat.speaker.id) : undefined;
  return (
    <article className="beat beat-speech">
      <SpeakerTag speaker={beat.speaker} truth={props.truth} level={props.level} />
      {voice ? (
        <p aria-hidden="true" className="beat-voice">
          {voice}
        </p>
      ) : null}
      <Body
        voice={{ speaker: beat.speaker, body: beat.body, seq: beat.firstSeq, truncated: beat.truncated }}
        reveal={props.reveal ?? null}
      />
      {showThought ? (
        <p className="beat-thought">
          <span>thinking</span>
          {beat.thought}
        </p>
      ) : null}
    </article>
  );
}

function PileOn({ props, beat }: { props: BeatCardProps; beat: Extract<Beat, { kind: "pileOn" }> }) {
  const collapsible = beat.voices.length >= GROUPING.PILE_ON_MIN;
  const collapsed = collapsible && !props.expanded;
  const shown = collapsed ? beat.voices.slice(0, 1) : beat.voices;
  const hidden = beat.voices.length - shown.length;
  // The reveal budget covers `revealText`, which is the joined bodies of the
  // voices the fold kept — the head alone once a run has collapsed. A voice the
  // reader expands out past that budget renders plain rather than sit forever
  // pending, and the offsets count the joining spaces so they land exactly.
  const reveal = props.reveal ?? null;
  const offsets = joinOffsets(shown.map((voice) => voice.body));
  const budgets = shown.map((voice, index) => {
    const inside = !beat.collapsed || index === 0;
    if (reveal === null || !inside) return null;
    return Math.max(0, Math.min(voice.body.length, reveal - offsets[index]));
  });
  return (
    <article className="beat beat-pileon">
      <header className="pileon-head">
        <span className="eyebrow">The room turns on</span>
        <SpeakerTag speaker={beat.target} truth={props.truth} level={props.level} />
        <span className="pileon-count">
          {beat.voices.length} {beat.voices.length === 1 ? "voice" : "voices"}
        </span>
      </header>
      {shown.map((voice, index) => (
        <div className="pileon-voice" key={voice.seq}>
          <SpeakerTag speaker={voice.speaker} truth={props.truth} level={props.level} />
          <Body voice={voice} reveal={budgets[index]} />
        </div>
      ))}
      {collapsible ? (
        <button className="beat-toggle" type="button" onClick={() => props.onToggle(beat.key)}>
          {collapsed ? `Show ${hidden} more ${hidden === 1 ? "voice" : "voices"}` : "Collapse"}
        </button>
      ) : null}
    </article>
  );
}

function Ballot({ props, beat }: { props: BeatCardProps; beat: Extract<Beat, { kind: "ballot" }> }) {
  const counts = new Map<string, { player: SpeakerRef | null; count: number }>();
  for (const vote of beat.votes) {
    const key = vote.target?.id ?? "?";
    const row = counts.get(key) ?? { player: vote.target, count: 0 };
    row.count += 1;
    counts.set(key, row);
  }
  const rows = [...counts.values()].sort((a, b) => b.count - a.count);
  return (
    <article className="beat beat-ballot">
      <header className="beat-meta">
        <span className="eyebrow">{beat.label}</span>
        <span className="beat-count">
          {beat.votes.length} {beat.votes.length === 1 ? "ballot" : "ballots"} cast
        </span>
      </header>
      <div className="ballot-tally">
        {rows.map((row) => (
          <div className="tally-row" key={row.player?.id ?? "?"}>
            <span>{row.player?.name ?? "?"}</span>
            <RoleChip playerId={row.player?.id} truth={props.truth} level={props.level} />
            <span className="tally-count">{row.count}</span>
          </div>
        ))}
      </div>
      <ul className="ballot-list">
        {beat.votes.map((vote) => (
          <li key={vote.seq}>
            <span className="ballot-voter">{vote.voter?.name ?? "?"}</span>
            <span aria-hidden="true">→</span>
            <span>{vote.target?.name ?? "?"}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function VoteTally({ beat }: { beat: Extract<Beat, { kind: "voteTally" }> }) {
  const total = beat.counts.reduce((sum, entry) => sum + entry.count, 0) || 1;
  return (
    <article className="beat beat-tally">
      <p className="eyebrow">The tally is published</p>
      {beat.counts.map((entry) => (
        <div className="tally-bar" key={entry.target?.id ?? entry.target?.name ?? "?"}>
          <span className="tally-bar-name">{entry.target?.name ?? "?"}</span>
          <span className="tally-track">
            <span
              aria-hidden="true"
              className="tally-fill"
              style={{ transform: `scaleX(${clamp01(entry.count / total)})` }}
            />
          </span>
          <span className="tally-count">{entry.count}</span>
        </div>
      ))}
    </article>
  );
}

function Elimination({
  props,
  beat,
}: {
  props: BeatCardProps;
  beat: Extract<Beat, { kind: "elimination" }>;
}) {
  const role: Role | "unknown" | null =
    (beat.role as Role | null) ??
    (beat.player ? props.truth.roles.get(beat.player.id) ?? null : null);
  return (
    <article className={`beat beat-elimination ${role === "werewolf" ? "is-wolf" : ""}`}>
      <p className="eyebrow">
        {beat.cause === "eaten"
          ? "Taken in the night"
          : beat.cause === "exiled"
            ? "Exiled by the village"
            : "Removed from the village"}
      </p>
      <p className="elimination-line">
        <strong>{beat.player?.name ?? "Someone"}</strong>
        <span>was</span>
        <em>{roleLabel(role)}</em>
      </p>
    </article>
  );
}

function Night({ props, beat }: { props: BeatCardProps; beat: Extract<Beat, { kind: "night" }> }) {
  // The night's prose is its plans, so the reveal budget is split across them
  // the same way `revealText` joins them.
  const reveal = props.reveal ?? null;
  const planOffsets = joinOffsets(beat.plans.map((plan) => plan.body));
  const planBudgets = beat.plans.map((plan, index) => {
    if (reveal === null) return null;
    return Math.max(0, Math.min(plan.body.length, reveal - planOffsets[index]));
  });
  if (props.level === "blind") {
    return (
      <article className="beat beat-night">
        <header className="beat-meta">
          <span className="eyebrow">Night {beat.night}</span>
        </header>
        <p className="night-closed">Something moves in the forest. The village sleeps.</p>
        {/* Blind keeps the night's *existence* but not its contents: the village
            knows a Fortune Teller is in play and that a reading is a real move, so
            the box says one happened without saying who read whom, or what. */}
        {beat.checks.length > 0 ? (
          <dl className="night-facts">
            <div>
              <dt>The reading</dt>
              <dd>The Fortune Teller read a role in secret.</dd>
            </div>
          </dl>
        ) : null}
      </article>
    );
  }
  return (
    <article className="beat beat-night">
      <header className="beat-meta">
        <span className="eyebrow">Night {beat.night}</span>
        <span className="beat-count">{beat.mealVictim ? "the pack has chosen" : "in progress"}</span>
      </header>
      <dl className="night-facts">
        <div>
          <dt>The pack</dt>
          <dd>{beat.wolves.length > 0 ? beat.wolves.map((id) => props.nameOf(id)).join(", ") : "unknown"}</dd>
        </div>
        {beat.mealVictim ? (
          <div>
            <dt>The meal</dt>
            <dd>
              {beat.mealVictim.name}
              {beat.mealTied ? <span className="night-note">decided by tiebreak</span> : null}
            </dd>
          </div>
        ) : null}
        {beat.checks.map((check, index) => (
          <div key={`${check.reader?.id ?? "?"}-${check.target?.id ?? index}`}>
            <dt>The reading</dt>
            <dd>
              {check.reader?.name ?? "?"} read {check.target?.name ?? "?"} — {check.result}
            </dd>
          </div>
        ))}
      </dl>
      {!props.compact && beat.plans.length > 0 ? (
        <ul className="night-plans">
          {beat.plans.map((plan, index) => (
            <li key={`${plan.speaker?.id ?? "?"}-${index}`}>
              <span>{plan.speaker?.name ?? "?"}</span>
              <RevealText text={plan.body} revealed={planBudgets[index]} />
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function PassRun({ beat }: { beat: Extract<Beat, { kind: "passRun" }> }) {
  const names = beat.voices.map((voice) => voice.name);
  return (
    <article className="beat beat-pass">
      <p>
        <span className="eyebrow">Silence</span>
        {names.length === 0
          ? "Someone lets the moment pass."
          : `${names.join(", ")} ${names.length === 1 ? "stays" : "stay"} silent.`}
      </p>
    </article>
  );
}

function Declaration({
  props,
  beat,
}: {
  props: BeatCardProps;
  beat: Extract<Beat, { kind: "declaration" }>;
}) {
  // A commitment, not a speech: the card leads with the two names it binds
  // together and drops the reason beneath them. The reason is the only prose, so
  // it is the only thing that reveals.
  return (
    <article className="beat beat-declaration">
      <p className="eyebrow">Declaration</p>
      <p className="declaration-vow">
        <SpeakerTag speaker={beat.speaker} truth={props.truth} level={props.level} />
        <span aria-hidden="true" className="declaration-arrow">
          →
        </span>
        {beat.target ? (
          <SpeakerTag speaker={beat.target} truth={props.truth} level={props.level} />
        ) : (
          <span className="beat-speaker is-unknown">no target named</span>
        )}
      </p>
      {beat.body ? (
        <p className="declaration-reason">
          <RevealText text={beat.body} revealed={props.reveal ?? null} />
          {/* Same rule as `Body`: the marker lands with the last word. */}
          {beat.truncated && isRevealed(beat.body, props.reveal ?? null) ? (
            <span className="beat-cut">cut off</span>
          ) : null}
        </p>
      ) : null}
    </article>
  );
}

function Marker({ props, beat }: { props: BeatCardProps; beat: Extract<Beat, { kind: "marker" }> }) {
  return (
    <article className="beat beat-marker">
      <p className="eyebrow">{beat.title}</p>
      <p>
        <RevealText text={beat.detail} revealed={props.reveal ?? null} />
      </p>
    </article>
  );
}

function Text({ props, beat }: { props: BeatCardProps; beat: Extract<Beat, { kind: "text" }> }) {
  return (
    <article className="beat beat-text">
      <p>
        <RevealText text={beat.event.message} revealed={props.reveal ?? null} />
      </p>
    </article>
  );
}

function BeatCardInner(props: BeatCardProps) {
  const { beat } = props;
  switch (beat.kind) {
    case "speech":
      return <Speech props={props} beat={beat} />;
    case "pileOn":
      return <PileOn props={props} beat={beat} />;
    case "ballot":
      return <Ballot props={props} beat={beat} />;
    case "voteTally":
      return <VoteTally beat={beat} />;
    case "elimination":
      return <Elimination props={props} beat={beat} />;
    case "night":
      return <Night props={props} beat={beat} />;
    case "passRun":
      return <PassRun beat={beat} />;
    case "declaration":
      return <Declaration props={props} beat={beat} />;
    case "marker":
      return <Marker props={props} beat={beat} />;
    case "text":
      return <Text props={props} beat={beat} />;
  }
}

export const BeatCard = memo(BeatCardInner);
