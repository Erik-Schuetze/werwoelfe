"use client";

import type { SeatState } from "@/lib/stakes";
import { roleLabel, type GroundTruth, type TruthLevel } from "@/lib/truth";

type Props = {
  seatOrder: string[];
  seats: Map<string, SeatState>;
  truth: GroundTruth;
  level: TruthLevel;
  sheriffId: string | null;
  /** Live suspect from the stakes rail, highlighted as being on the block. */
  onBlockId: string | null;
};

export function PlayerTable({ seatOrder, seats, truth, level, sheriffId, onBlockId }: Props) {
  return (
    <div className="table-grid">
      {seatOrder.map((id) => {
        const seat = seats.get(id);
        if (!seat) return null;
        const role = level === "blind" ? null : truth.roles.get(id);
        const classes = [
          "seat",
          seat.alive ? "" : "seat-eliminated",
          seat.speaking ? "seat-speaking" : "",
          id === onBlockId ? "seat-onblock" : "",
          id === sheriffId ? "seat-sheriff" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <article aria-current={seat.speaking ? "true" : undefined} className={classes} key={id}>
            <header className="seat-head">
              <span className="seat-token" data-alive={seat.alive} aria-hidden="true" />
              <strong className="seat-name">{seat.name}</strong>
              {id === sheriffId ? <span className="sheriff-star" title="Sheriff">★</span> : null}
            </header>
            {role ? (
              <span className={`truth-badge is-${role}`}>{roleLabel(role)}</span>
            ) : level !== "blind" ? (
              <span className="truth-badge is-unknown">Unknown</span>
            ) : null}
            <footer className="seat-foot">
              {!seat.alive ? (
                <span className="seat-fate">
                  {seat.fate === "eaten" ? "taken in the night" : "exiled"}
                </span>
              ) : null}
              {seat.alive && seat.hasVotedIn ? <span className="seat-voted">has voted</span> : null}
              {id === onBlockId ? <span className="seat-block">on the block</span> : null}
            </footer>
          </article>
        );
      })}
    </div>
  );
}
