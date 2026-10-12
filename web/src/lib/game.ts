export type GameStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type PromptStyle = "classic" | "social";

export type PlayerInput = {
  id: string;
  name: string;
  personality: string;
  // Optional per-player sampler override. When omitted the player inherits the run's
  // model.temperature; an explicit 0 (fully deterministic) is a legal, meaningful value.
  temperature?: number;
};

export type ModelInput = {
  base_url?: string;
  name?: string;
  max_retries?: number;
  temperature?: number;
  character_temperature?: number;
  title_temperature?: number;
  prompt_style?: PromptStyle;
};

export type GameConfigInput = {
  players: PlayerInput[];
  roles?: Array<"werewolf" | "villager" | "seer">;
  model?: ModelInput;
};

// Body of POST /api/games: the engine config plus an optional launch seed. Omitting the seed
// keeps the server's random generation; supplying one pins the run for same-seed pairing. The
// seed is a string of decimal digits (a uint64 exceeds float64, so a JS number would round it),
// matching the string-typed GameSummary.seed.
export type LaunchGameInput = {
  config: GameConfigInput;
  seed?: string;
};

export type GameEvent = {
  sequence: number;
  at: string;
  kind: string;
  visibility: "public" | "private";
  recipients: string[];
  playerId: string | null;
  revealedRole: string | null;
  message: string;
};

export type GamePlayer = {
  id: string;
  name: string;
  role: string | null;
  alive: boolean | null;
};

export type GameSummary = {
  id: string;
  status: GameStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  seed: string;
  // Deliberately NOT on the wire: the winner is withheld from the client so nothing a
  // viewer can reach — not the heading, not the run cards, not the page payload — spoils
  // a run before its own final beat reveals it. The result is still recorded; it is simply
  // not shipped. If a "revealed after you watch it" badge is ever wanted, that wants a
  // deliberate endpoint rather than putting this field back on the summary.
  //
  // The run's spoiler-free title, written by the engine at the end of the game and passed
  // through its spoiler gate. Null for every run recorded before titles existed, and for a
  // run whose naming produced nothing — never omitted, never an empty string.
  title: string | null;
  error: string | null;
  playerCount: number;
  eventCount: number;
};

export type GameDetail = GameSummary & {
  players: GamePlayer[];
  events: GameEvent[];
  model: {
    baseUrl: string | null;
    name: string | null;
    maxRetries: number | null;
    temperature: number | null;
  };
};
