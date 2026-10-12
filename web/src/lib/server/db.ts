import "server-only";

import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  GameConfigInput,
  GameDetail,
  GamePlayer,
  GameStatus,
  GameSummary,
  GameEvent,
} from "@/lib/game";
import { environment } from "@/lib/server/env";
import type { ValidGameConfig } from "@/lib/server/schema";

type GameRow = {
  id: string;
  status: GameStatus;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  seed: string;
  config_json: string;
  artifact_dir: string;
  winner: string | null;
  title: string | null;
  error_message: string | null;
  deadline_at: string | null;
  paused_at: string | null;
};

/**
 * The columns the run poller and the startup reconciler need: a run's identity and status, plus
 * the persisted deadline clock. Deliberately narrower than `GameRow` — the poller runs every few
 * seconds and must not drag `config_json` and the rest of the row along.
 */
export type ActiveGameRow = {
  id: string;
  status: GameStatus;
  started_at: string | null;
  artifact_dir: string;
  deadline_at: string | null;
  paused_at: string | null;
};

type PublicResult = {
  winner: string;
  title?: string | null;
  players: Array<{ id: string; name: string; role: string; alive: boolean }>;
};

declare global {
  var werwoelfeDatabase: Database.Database | undefined;
}

function migrateEventMetadata(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(game_events)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("visibility")) {
    db.exec("ALTER TABLE game_events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
  }
  if (!names.has("recipients")) {
    db.exec("ALTER TABLE game_events ADD COLUMN recipients TEXT NOT NULL DEFAULT '[]'");
  }
  if (!names.has("player_id")) {
    db.exec("ALTER TABLE game_events ADD COLUMN player_id TEXT");
  }
  if (!names.has("revealed_role")) {
    db.exec("ALTER TABLE game_events ADD COLUMN revealed_role TEXT");
  }
}

function migrateGameTitle(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(games)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("title")) {
    db.exec("ALTER TABLE games ADD COLUMN title TEXT");
  }
}

/**
 * The durable run deadline, so a console that restarts mid-run can re-arm it.
 *
 * `deadline_at` is the wall-clock instant the run's budget runs out; `paused_at` is when the
 * operator paused it, or NULL while it is live. Both are ISO-8601 strings, matching the other
 * timestamps on this table — the arithmetic over them lives in `./run-deadline.ts`.
 */
function migrateRunDeadline(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(games)").all() as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("deadline_at")) {
    db.exec("ALTER TABLE games ADD COLUMN deadline_at TEXT");
  }
  if (!names.has("paused_at")) {
    db.exec("ALTER TABLE games ADD COLUMN paused_at TEXT");
  }
}

function databasePath(): string {
  fs.mkdirSync(environment.dataDir, { recursive: true });
  return path.join(environment.dataDir, "werwoelfe.sqlite");
}

function database(): Database.Database {
  if (!globalThis.werwoelfeDatabase) {
    const db = new Database(databasePath());
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrateGameStatus(db);
    db.exec(schemaSQL);
    migrateEventMetadata(db);
    migrateGameTitle(db);
    migrateRunDeadline(db);
    globalThis.werwoelfeDatabase = db;
  }
  return globalThis.werwoelfeDatabase;
}

const schemaSQL = `
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        seed TEXT NOT NULL,
        config_json TEXT NOT NULL,
        artifact_dir TEXT NOT NULL,
        winner TEXT,
        title TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS game_players (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        alive INTEGER,
        PRIMARY KEY (game_id, id)
      );
      CREATE TABLE IF NOT EXISTS game_events (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private')),
        recipients TEXT NOT NULL DEFAULT '[]',
        player_id TEXT,
        revealed_role TEXT,
        message TEXT NOT NULL,
        PRIMARY KEY (game_id, sequence)
      );
      CREATE INDEX IF NOT EXISTS game_events_game_sequence
      ON game_events (game_id, sequence);
    `;

function migrateGameStatus(db: Database.Database): void {
  const schema = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'games'",
  ).get() as { sql: string } | undefined;
  if (!schema || schema.sql.includes("'paused'")) {
    return;
  }
  const eventColumns = new Set(
    (db.prepare("PRAGMA table_info(game_events)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const hasEventMetadata = ["visibility", "recipients", "player_id", "revealed_role"].every((column) =>
    eventColumns.has(column),
  );
  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE game_events RENAME TO game_events_legacy;
        ALTER TABLE game_players RENAME TO game_players_legacy;
        ALTER TABLE games RENAME TO games_legacy;
        DROP INDEX IF EXISTS game_events_game_sequence;
        ${schemaSQL}
        INSERT INTO games
          (id, status, created_at, started_at, finished_at, seed, config_json, artifact_dir, winner, error_message)
        SELECT id, status, created_at, started_at, finished_at, seed, config_json, artifact_dir, winner, error_message
        FROM games_legacy;
        INSERT INTO game_players SELECT * FROM game_players_legacy;
        ${hasEventMetadata
          ? `INSERT INTO game_events
               (game_id, sequence, at, kind, visibility, recipients, player_id, revealed_role, message)
             SELECT game_id, sequence, at, kind, visibility, recipients, player_id, revealed_role, message
             FROM game_events_legacy;`
          : `INSERT INTO game_events (game_id, sequence, at, kind, message)
             SELECT game_id, sequence, at, kind, message FROM game_events_legacy;`}
        DROP TABLE game_events_legacy;
        DROP TABLE game_players_legacy;
        DROP TABLE games_legacy;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

function parseConfig(configJSON: string): ValidGameConfig {
  return JSON.parse(configJSON) as ValidGameConfig;
}

function toSummary(row: GameRow): GameSummary {
  const db = database();
  const playerCount = (
    db.prepare("SELECT COUNT(*) AS count FROM game_players WHERE game_id = ?").get(row.id) as {
      count: number;
    }
  ).count;
  const eventCount = (
    db.prepare("SELECT COUNT(*) AS count FROM game_events WHERE game_id = ?").get(row.id) as {
      count: number;
    }
  ).count;
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    seed: row.seed,
    // row.winner is stored but deliberately not serialized — see GameSummary in lib/game.ts.
    title: row.title,
    error: row.error_message,
    playerCount,
    eventCount,
  };
}

function getGameRow(id: string): GameRow | null {
  return (database().prepare("SELECT * FROM games WHERE id = ?").get(id) as GameRow | undefined) ?? null;
}

export function createGame(
  id: string,
  config: ValidGameConfig,
  seed: string,
  artifactDir: string,
): GameSummary {
  const db = database();
  const createdAt = new Date().toISOString();
  const insert = db.transaction(() => {
    // 'paused' is counted deliberately. The limit is a resource limit, not a progress limit: a
    // paused run's game pod is still alive (the engine blocks between turns on the control file,
    // it is not suspended), still holding its Guaranteed-QoS CPU and memory on the node the
    // console shares, and still attached to the RWO run volume. Excluding it would let a second
    // game start alongside a paused one and oversubscribe exactly the resource this limit
    // protects — "Only N game can run at once" would stop being true. It also keeps the count
    // consistent with `getActiveGames()`, which the poller and reconciler treat as the live set.
    const active = (
      db
        .prepare("SELECT COUNT(*) AS count FROM games WHERE status IN ('queued', 'running', 'paused')")
        .get() as { count: number }
    ).count;
    if (active >= environment.maxConcurrentRuns) {
      throw new Error(`Only ${environment.maxConcurrentRuns} game can run at once.`);
    }
    db.prepare(
      `INSERT INTO games
       (id, status, created_at, seed, config_json, artifact_dir)
       VALUES (?, 'queued', ?, ?, ?, ?)`,
    ).run(id, createdAt, seed, JSON.stringify(config), artifactDir);
    const player = db.prepare(
      "INSERT INTO game_players (game_id, id, name) VALUES (?, ?, ?)",
    );
    for (const entry of config.players) {
      player.run(id, entry.id, entry.name);
    }
  });
  insert();
  return getGameSummary(id)!;
}

export function getGameSummary(id: string): GameSummary | null {
  const row = getGameRow(id);
  return row ? toSummary(row) : null;
}

export function listGames(): GameSummary[] {
  return (database()
    .prepare("SELECT * FROM games ORDER BY created_at DESC")
    .all() as GameRow[]).map(toSummary);
}

export function getGameDetail(id: string): GameDetail | null {
  const row = getGameRow(id);
  if (!row) {
    return null;
  }
  const config = parseConfig(row.config_json);
  const players = database()
    .prepare(
      "SELECT id, name, role, alive FROM game_players WHERE game_id = ? ORDER BY id",
    )
    .all(id)
    .map((player) => {
      const record = player as { id: string; name: string; role: string | null; alive: number | null };
      return { ...record, alive: record.alive === null ? null : record.alive === 1 };
    }) as GamePlayer[];
  const events = database()
    .prepare(
      `SELECT sequence, at, kind, visibility, recipients, player_id AS playerId,
              revealed_role AS revealedRole, message
       FROM game_events WHERE game_id = ? ORDER BY sequence`,
    )
    .all(id)
    .map((event) => {
      const record = event as Omit<GameEvent, "recipients"> & { recipients: string };
      return { ...record, recipients: JSON.parse(record.recipients) as string[] };
    }) as GameEvent[];
  return {
    ...toSummary(row),
    players,
    events,
    model: {
      baseUrl: config.model?.base_url ?? null,
      name: config.model?.name ?? null,
      maxRetries: config.model?.max_retries ?? null,
      temperature: config.model?.temperature ?? null,
    },
  };
}

export function getRunConfiguration(id: string): {
  config: GameConfigInput;
  artifactDir: string;
  status: GameStatus;
  startedAt: string | null;
} | null {
  const row = getGameRow(id);
  if (!row) {
    return null;
  }
  return {
    config: parseConfig(row.config_json),
    artifactDir: row.artifact_dir,
    status: row.status,
    startedAt: row.started_at,
  };
}

/**
 * Every non-terminal run — the set the poller joins the cluster's Jobs against.
 *
 * One cheap SELECT: deliberately not `listGames()`, which runs two `COUNT(*)` queries per row to
 * build a summary the poller never looks at. Called every few seconds, that difference matters.
 */
export function getActiveGames(): ActiveGameRow[] {
  return database()
    .prepare(
      `SELECT id, status, started_at, artifact_dir, deadline_at, paused_at
       FROM games WHERE status IN ('running', 'paused')`,
    )
    .all() as ActiveGameRow[];
}

/**
 * Every game id, for deciding whether a cluster Job belongs to the console at all.
 *
 * One column off the primary key, deliberately: the orphan sweep runs every few seconds and only
 * asks "does a row exist for this id", never "what does it say". Building a summary here (as
 * `listGames` does, with two `COUNT(*)` per row) would be work the caller never reads.
 */
export function getKnownGameIds(): Set<string> {
  const rows = database().prepare("SELECT id FROM games").all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

/** A run's persisted deadline clock, for re-arming it after a restart. */
export function getGameDeadline(id: string): { deadlineAt: string | null; pausedAt: string | null } | null {
  const row = database()
    .prepare("SELECT deadline_at, paused_at FROM games WHERE id = ?")
    .get(id) as { deadline_at: string | null; paused_at: string | null } | undefined;
  if (!row) {
    return null;
  }
  return { deadlineAt: row.deadline_at, pausedAt: row.paused_at };
}

/** Persist a run's deadline clock (ISO-8601, or NULL for "not paused"). */
export function setGameDeadline(id: string, deadlineAt: string | null, pausedAt: string | null): void {
  database()
    .prepare("UPDATE games SET deadline_at = ?, paused_at = ? WHERE id = ?")
    .run(deadlineAt, pausedAt, id);
}

export function setGameRunning(id: string): void {
  database()
    .prepare("UPDATE games SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'")
    .run(new Date().toISOString(), id);
}

export function pauseGame(id: string): boolean {
  const result = database()
    .prepare("UPDATE games SET status = 'paused' WHERE id = ? AND status = 'running'")
    .run(id);
  return result.changes === 1;
}

export function resumeGame(id: string): boolean {
  const result = database()
    .prepare("UPDATE games SET status = 'running' WHERE id = ? AND status = 'paused'")
    .run(id);
  return result.changes === 1;
}

export function failGame(id: string, error: string): void {
  database()
    .prepare(
      `UPDATE games
       SET status = 'failed', finished_at = ?, error_message = ?
       WHERE id = ? AND status IN ('queued', 'running')`,
    )
    .run(new Date().toISOString(), error.slice(0, 2_000), id);
}

export function failExitedGame(id: string, error: string): void {
  database()
    .prepare(
      `UPDATE games
       SET status = 'failed', finished_at = ?, error_message = ?
       WHERE id = ? AND status IN ('queued', 'running', 'paused')`,
    )
    .run(new Date().toISOString(), error.slice(0, 2_000), id);
}

export function cancelGame(id: string): boolean {
  const result = database()
    .prepare(
      `UPDATE games
       SET status = 'cancelled', finished_at = ?, error_message = ?
       WHERE id = ? AND status IN ('queued', 'running', 'paused')`,
    )
    .run(new Date().toISOString(), "Stopped by the operator.", id);
  return result.changes === 1;
}

export function addGameEvent(id: string, event: GameEvent): void {
  const db = database();
  const addEvent = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO game_events
         (game_id, sequence, at, kind, visibility, recipients, player_id, revealed_role, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        event.sequence,
        event.at,
        event.kind,
        event.visibility,
        JSON.stringify(event.recipients),
        event.playerId,
        event.revealedRole,
        event.message,
      );
    if (
      result.changes === 1 &&
      event.kind === "player_removed" &&
      event.visibility === "public" &&
      event.playerId &&
      event.revealedRole
    ) {
      db.prepare(
        "UPDATE game_players SET role = ?, alive = 0 WHERE game_id = ? AND id = ?",
      ).run(event.revealedRole, id, event.playerId);
    }
  });
  addEvent();
}

export function completeGame(id: string, result: PublicResult): void {
  const db = database();
  // A run with no title — an already-recorded run, or a record from an engine that predates
  // titles — is stored as NULL, never an empty string. The engine's title is written as-is.
  const title = result.title?.trim() ? result.title : null;
  const update = db.transaction(() => {
    // 'paused' is included, matching `failExitedGame`. Pausing is *cooperative*: the engine keeps
    // running until its next turn boundary, so a pause that lands after the final action leaves a
    // run that finishes its result record while the row still says 'paused'. Omitting it here
    // would no-op the completion and then, on the next observation, mark a finished game
    // 'failed' — the record is the truth, so the row must accept it.
    db.prepare(
      `UPDATE games
       SET status = 'completed', finished_at = ?, winner = ?, title = ?, error_message = NULL
       WHERE id = ? AND status IN ('queued', 'running', 'paused')`,
    ).run(new Date().toISOString(), result.winner, title, id);
    const player = db.prepare(
      "UPDATE game_players SET name = ?, role = ?, alive = ? WHERE game_id = ? AND id = ?",
    );
    for (const entry of result.players) {
      player.run(entry.name, entry.role, entry.alive ? 1 : 0, id, entry.id);
    }
  });
  update();
}
