import type { GameStatus } from "@/lib/game";

const labels: Record<GameStatus, string> = {
  queued: "Queued",
  running: "In progress",
  paused: "Paused",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: GameStatus }) {
  return <span className={`status status-${status}`}>{labels[status]}</span>;
}
