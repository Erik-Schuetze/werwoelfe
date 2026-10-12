"use client";

import type { ReactNode } from "react";

import { describeDuration } from "@/lib/cadence";
import type { CaseOnTable, LedgerEntry, VoteBoard } from "@/lib/stakes";
import type { AlignmentGap, GroundTruth, TruthLevel } from "@/lib/truth";

type Props = {
  level: TruthLevel;
  truth: GroundTruth;
  gap: AlignmentGap;
  caseOnTable: CaseOnTable | null;
  voteBoard: VoteBoard | null;
  ledger: LedgerEntry[];
  nameOf: (id: string) => string;
  /** Run facts and controls, owned by the page so mutations stay there. */
  facts: ReactNode;
  controls: ReactNode;
};

const SOURCE_LABEL: Record<GroundTruth["source"], string> = {
  roster: "Full roster, from the final result",
  derived: "Rebuilt from the night channels",
  none: "No night evidence yet",
};

/** Clamp a bar ratio to 0..1. Pure, so it stays clear of the render-compiler rules. */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function StakeRail({
  level,
  truth,
  gap,
  caseOnTable,
  voteBoard,
  ledger,
  nameOf,
  facts,
  controls,
}: Props) {
  const latestNight = ledger[ledger.length - 1];
  // How many readings the watched night(s) contain — the only fact blind is told.
  const readings = ledger.reduce((total, entry) => total + entry.checks.length, 0);
  return (
    <aside className="panel stake-rail">
      <section className="rail-block">
        <p className="eyebrow">Case on the table</p>
        {caseOnTable?.suspect ? (
          <>
            <p className="case-suspect">
              <strong>{caseOnTable.suspect.name}</strong>
              <span className={`case-confidence is-${caseOnTable.confidence}`}>{caseOnTable.confidence}</span>
            </p>
            <p className="case-detail">
              {caseOnTable.fromVote
                ? `${caseOnTable.score} ballots are on the floor.`
                : `Named ${caseOnTable.score} times in the current round.`}
            </p>
          </>
        ) : (
          <p className="case-detail">No one has a case against them yet.</p>
        )}
        {level !== "blind" ? (
          <p className={`gap-chip is-${gap.state}`}>{gap.text}</p>
        ) : null}
      </section>

      <section className="rail-block">
        <p className="eyebrow">Vote board</p>
        {voteBoard && voteBoard.counts.length > 0 ? (
          <>
            <p className="vote-label">
              {voteBoard.label}
              <span>{voteBoard.settled ? "settled" : "open"}</span>
            </p>
            {voteBoard.counts.map((row) => (
              <div className="vote-row" key={row.player?.id ?? "?"}>
                <span className="vote-name">{row.player?.name ?? "?"}</span>
                <span className="vote-track">
                  <span
                    aria-hidden="true"
                    className="vote-fill"
                    style={{ transform: `scaleX(${clamp01(row.count / Math.max(1, voteBoard.cast))})` }}
                  />
                </span>
                <span className="vote-count">{row.count}</span>
              </div>
            ))}
            {voteBoard.official ? (
              <p className="official-count">
                Official: {voteBoard.official.map((entry) => `${entry.target?.name} ${entry.count}`).join(", ")}
              </p>
            ) : null}
          </>
        ) : (
          <p className="case-detail">No ballot has been cast yet.</p>
        )}
      </section>

      <section className="rail-block">
        <p className="eyebrow">Night ledger</p>
        {ledger.length === 0 ? (
          <p className="case-detail">
            {level === "blind" ? "Nothing is known about the nights." : "Night has not fallen yet."}
          </p>
        ) : level === "blind" ? (
          <>
            <p className="case-detail">Something has happened in the forest, {ledger.length} times.</p>
            {/* Blind still gets the night's shape, so it can see that a Fortune
                Teller is alive and working, without the who, the whom or the
                answer — those are the whole of what a reading reveals. */}
            {readings > 0 ? (
              <p className="case-detail">The Fortune Teller has read {readings} role{readings === 1 ? "" : "s"} in secret.</p>
            ) : null}
          </>
        ) : (
          <ul className="ledger">
            {ledger.map((entry) => (
              <li className="ledger-night" key={entry.night}>
                <header>
                  <strong>Night {entry.night}</strong>
                  {entry.deliberationMs ? (
                    <span title="How long the pack took between the first plan and the choice">
                      deliberated {describeDuration(entry.deliberationMs)}
                    </span>
                  ) : null}
                </header>
                <p>
                  <span>pack</span>
                  {entry.wolves.length > 0 ? entry.wolves.map(nameOf).join(", ") : "unknown"}
                </p>
                {entry.mealVictim ? (
                  <p>
                    <span>ate</span>
                    {entry.mealVictim.name}
                    {entry.mealTied ? " (tiebreak)" : ""}
                  </p>
                ) : null}
                {entry.checks.map((check, index) => (
                  <p key={`${check.reader?.id ?? "?"}-${check.target?.id ?? index}`}>
                    <span>read</span>
                    {check.reader?.name ?? "?"} → {check.target?.name ?? "?"} — {check.result}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rail-block">
        <p className="eyebrow">What the seats know</p>
        <p className="truth-source">{SOURCE_LABEL[truth.source]}</p>
        {level !== "blind" && truth.wolves.length > 0 ? (
          <p className="case-detail">
            The pack: {truth.wolves.map(nameOf).join(", ")}
            {truth.seerId ? ` · the Fortune Teller: ${nameOf(truth.seerId)}` : ""}
          </p>
        ) : null}
        {latestNight?.mealVictim ? (
          <p className="case-detail">Latest night: {latestNight.mealVictim.name} was taken.</p>
        ) : null}
      </section>

      <section className="rail-block">
        <p className="eyebrow">Run</p>
        {facts}
        <div className="run-controls">{controls}</div>
      </section>
    </aside>
  );
}
