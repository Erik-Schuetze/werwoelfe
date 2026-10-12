"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import type { GameConfigInput, GameSummary, LaunchGameInput, PlayerInput } from "@/lib/game";
import type { DeploymentMode } from "@/lib/mode";
import { gamePath } from "@/lib/viewer-routes";
import { RunCard } from "@/components/run-card";

// The guided form edits the shared engine config plus a launch-only seed. Per-player
// temperature already rides on PlayerInput; the seed is stripped out of `config` and sent as
// the launch-request sibling when the game starts. It is kept as a string (a run seed is a
// uint64, which a JS number would round).
type FormConfig = GameConfigInput & { seed?: string };

const playerNames = [
  "Ada",
  "Babbage",
  "Curie",
  "Dijkstra",
  "Edsger",
  "Franklin",
  "Galileo",
  "Hopper",
];

const personalityPresets = [
  {
    name: "Strategic Analyst",
    prompt: "You are a strategic analyst. Weigh evidence, incentives, and voting patterns carefully, and explain the reasoning behind your conclusions.",
  },
  {
    name: "Adaptive Thinker",
    prompt: "You adapt your strategy as new evidence appears. Reconsider earlier assumptions when the discussion or vote history gives you a good reason.",
  },
  {
    name: "Steadfast Suspect Tracker",
    prompt: "Choose a leading suspect early and consistently test their statements and voting behavior. Change your focus only when strong evidence contradicts it.",
  },
  {
    name: "Confident Leader",
    prompt: "Be assertive and take initiative in discussion. State your position clearly, challenge weak reasoning, and try to guide the group without pretending to know facts you do not know.",
  },
  {
    name: "Quiet Observer",
    prompt: "Be a quiet, observant player. Speak briefly when you have useful evidence or a focused question, and pass during discussion when you have nothing meaningful to add.",
  },
  {
    name: "Playful Jester",
    prompt: "Bring a playful, humorous tone to the village while keeping your comments relevant and your game decisions thoughtful.",
  },
  {
    name: "Skeptical Cross-Examiner",
    prompt: "Be skeptical and ask pointed questions. Look for inconsistencies between what players say and how they vote, and make your doubts specific.",
  },
  {
    name: "Diplomatic Mediator",
    prompt: "Stay calm and diplomatic. Listen to competing views, identify common ground, and help the village reach a reasoned decision.",
  },
  {
    name: "Bold Gambler",
    prompt: "Be bold and willing to take calculated risks. Trust your strongest intuition, state uncertain guesses as guesses, and commit to a clear recommendation.",
  },
  {
    name: "Patient Vote Auditor",
    prompt: "Take a patient, methodical approach. Track claims and vote changes over time, and base your conclusions on patterns rather than the loudest opinion.",
  },
] as const;

const chooseOwnPersonality = {
  name: "Choose your own personality",
  prompt: "At the start of the game, choose a distinct personality and play style for yourself. Use that personality consistently in your communication and decisions throughout the game.",
} as const;

function randomPersonality(): string {
  const index = Math.floor(Math.random() * personalityPresets.length);
  return personalityPresets[index].prompt;
}

function initialConfig(): FormConfig {
  return {
    players: playerNames.map((name, index) => ({
      id: `p${index + 1}`,
      name,
      personality: personalityPresets[index % personalityPresets.length].prompt,
    })),
    model: { name: "deepseek-flash", max_retries: 2, temperature: 1.0 },
  };
}

function addPlayer(players: PlayerInput[]): PlayerInput[] {
  const next = players.length + 1;
  return [
    ...players,
    {
      id: `p${next}`,
      name: `Player ${next}`,
      personality: personalityPresets[players.length % personalityPresets.length].prompt,
    },
  ];
}

export function Dashboard({ initialGames, mode = "operator" }: { initialGames: GameSummary[]; mode?: DeploymentMode }) {
  const [games, setGames] = useState(initialGames);
  const router = useRouter();
  const [config, setConfig] = useState<FormConfig>(initialConfig);
  const [configMode, setConfigMode] = useState<"form" | "json">("form");
  const [jsonConfig, setJsonConfig] = useState(() => JSON.stringify(initialConfig(), null, 2));
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const activeCount = useMemo(
    () => games.filter((game) => game.status === "queued" || game.status === "running" || game.status === "paused").length,
    [games],
  );
  const activeGames = useMemo(
    () => games.filter((game) => game.status === "queued" || game.status === "running" || game.status === "paused"),
    [games],
  );
  const archivedGames = useMemo(
    () => games.filter((game) => game.status !== "queued" && game.status !== "running"),
    [games],
  );

  useEffect(() => {
    const refresh = async () => {
      const response = await fetch("/api/games", { cache: "no-store" });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { games: GameSummary[] };
      setGames(payload.games);
    };
    const interval = window.setInterval(() => {
      void refresh();
    }, 3_000);
    return () => window.clearInterval(interval);
  }, []);

  function updatePlayer(index: number, key: "id" | "name" | "personality", value: string) {
    setConfig((current) => ({
      ...current,
      players: current.players.map((player, playerIndex) =>
        playerIndex === index ? { ...player, [key]: value } : player,
      ),
    }));
  }

  // Blank clears the override so the player inherits the run temperature; any other value
  // becomes an explicit per-player temperature (0 is kept, not treated as "unset").
  function updatePlayerTemperature(index: number, raw: string) {
    setConfig((current) => ({
      ...current,
      players: current.players.map((player, playerIndex) => {
        if (playerIndex !== index) {
          return player;
        }
        const next: PlayerInput = { ...player };
        if (raw.trim() === "") {
          delete next.temperature;
        } else {
          next.temperature = Number(raw);
        }
        return next;
      }),
    }));
  }

  // Blank clears the seed so the server generates a random one; a supplied value pins the run.
  // The raw digit string is kept verbatim (never Number()-ed) so a uint64 seed is not rounded.
  function updateSeed(raw: string) {
    setConfig((current) => {
      const next: FormConfig = { ...current };
      const trimmed = raw.trim();
      if (trimmed === "") {
        delete next.seed;
      } else {
        next.seed = trimmed;
      }
      return next;
    });
  }

  function randomizePersonalities() {
    setConfig((current) => ({
      ...current,
      players: current.players.map((player) => ({ ...player, personality: randomPersonality() })),
    }));
  }

  function exportConfig() {
    const source = configMode === "json" ? jsonConfig : JSON.stringify(config, null, 2);
    const blob = new Blob([source], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "werwoelfe-config.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function launch() {
    setError(null);
    let launchConfig: FormConfig = config;
    if (configMode === "json") {
      try {
        launchConfig = JSON.parse(jsonConfig) as FormConfig;
      } catch {
        setError("Configuration JSON is invalid.");
        return;
      }
    }
    // The seed is a launch-request sibling, not part of the engine config the runner writes.
    const { seed, ...requestConfig } = launchConfig;
    const request: LaunchGameInput = { config: requestConfig, seed };
    setLaunching(true);
    try {
      const response = await fetch("/api/games", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const payload = (await response.json()) as { error?: string; game?: GameSummary };
      if (!response.ok || !payload.game) {
        setError(payload.error || "Could not launch the game.");
        return;
      }
      router.push(`/games/${payload.game.id}`);
    } catch {
      setError("Could not reach the operator service.");
    } finally {
      setLaunching(false);
    }
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <p className="eyebrow">Private operator console</p>
          <h1>Millers Hollow</h1>
          <p className="lede">Launch local Docker games, follow the complete trusted transcript, and keep every result in one place.</p>
        </div>
        <div className="masthead-stat" aria-atomic="true" aria-live="polite">
          <strong>{activeCount}</strong>
          <span>active run{activeCount === 1 ? "" : "s"}</span>
        </div>
      </header>

      <section className="launch-grid" aria-labelledby="launch-heading">
        <div className="panel launch-panel" aria-busy={launching}>
          <div className="section-heading">
            <div>
              <p className="eyebrow">New experiment</p>
              <h2 id="launch-heading">Set the village</h2>
            </div>
            <div className="tab-list" role="group" aria-label="Configuration source">
              <button
                aria-pressed={configMode === "form"}
                className={configMode === "form" ? "active" : ""}
                onClick={() => setConfigMode("form")}
                type="button"
              >
                Guided form
              </button>
              <button
                aria-pressed={configMode === "json"}
                className={configMode === "json" ? "active" : ""}
                onClick={() => {
                  setJsonConfig(JSON.stringify(config, null, 2));
                  setConfigMode("json");
                }}
                type="button"
              >
                JSON
              </button>
            </div>
          </div>

          {configMode === "form" ? (
            <div className="form-stack">
              <button className="secondary-button" onClick={randomizePersonalities} type="button">
                Randomize all personalities
              </button>
              <div aria-label="Village players" className="player-list">
                {config.players.map((player, index) => (
                  <fieldset className="player-row" key={`${player.id}-${index}`}>
                    <legend>Player {index + 1}</legend>
                    <label>
                      ID
                      <input value={player.id} onChange={(event) => updatePlayer(index, "id", event.target.value)} />
                    </label>
                    <label>
                      Name
                      <input value={player.name} onChange={(event) => updatePlayer(index, "name", event.target.value)} />
                    </label>
                    <label className="personality-field">
                      Persona
                      <select
                        value={player.personality}
                        onChange={(event) => updatePlayer(index, "personality", event.target.value)}
                      >
                        {personalityPresets.map((preset) => (
                          <option key={preset.name} value={preset.prompt}>{preset.name}</option>
                        ))}
                        <option value={chooseOwnPersonality.prompt}>{chooseOwnPersonality.name}</option>
                      </select>
                    </label>
                    <label>
                      Temp
                      <input
                        min="0"
                        max="2"
                        step="0.1"
                        type="number"
                        placeholder="inherit"
                        value={player.temperature ?? ""}
                        onChange={(event) => updatePlayerTemperature(index, event.target.value)}
                      />
                    </label>
                    <button
                      className="icon-button"
                      type="button"
                      aria-label={`Remove ${player.name}`}
                      disabled={config.players.length <= 8}
                      onClick={() =>
                        setConfig((current) => ({
                          ...current,
                          players: current.players.filter((_, playerIndex) => playerIndex !== index),
                        }))
                      }
                    >
                      −
                    </button>
                  </fieldset>
                ))}
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={config.players.length >= 18}
                onClick={() => setConfig((current) => ({ ...current, players: addPlayer(current.players) }))}
              >
                Add player
              </button>
              <div className="model-fields">
                <label>
                  Model
                  <input
                    value={config.model?.name || ""}
                    onChange={(event) => setConfig((current) => ({ ...current, model: { ...current.model, name: event.target.value } }))}
                  />
                </label>
                <label>
                  Retries
                  <input
                    min="0"
                    max="10"
                    type="number"
                    value={config.model?.max_retries ?? 2}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        model: { ...current.model, max_retries: Number(event.target.value) },
                      }))
                    }
                  />
                </label>
                <label>
                  Temperature
                  <input
                    min="0"
                    max="2"
                    step="0.1"
                    type="number"
                    value={config.model?.temperature ?? 1.0}
                    onChange={(event) =>
                      setConfig((current) => ({
                        ...current,
                        model: { ...current.model, temperature: Number(event.target.value) },
                      }))
                    }
                  />
                </label>
                <label>
                  Seed
                  <input
                    inputMode="numeric"
                    placeholder="random"
                    type="text"
                    value={config.seed ?? ""}
                    onChange={(event) => updateSeed(event.target.value)}
                  />
                </label>
              </div>
            </div>
          ) : (
            <div className="form-stack">
              <label className="json-field">
                Configuration JSON
                <textarea value={jsonConfig} onChange={(event) => setJsonConfig(event.target.value)} spellCheck={false} />
              </label>
              <label>
                Import a JSON file
                <input
                  accept="application/json,.json"
                  type="file"
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) {
                      return;
                    }
                    setJsonConfig(await file.text());
                  }}
                />
              </label>
            </div>
          )}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="launch-actions">
            <button className="secondary-button" onClick={exportConfig} type="button">Export configuration</button>
            <button className="primary-button" disabled={launching} onClick={launch} type="button">
              {launching ? "Starting Docker…" : "Start game"}
            </button>
          </div>
          <p className="form-note">The server supplies the DeepSeek key from its environment. It is never entered or stored in this browser.</p>
        </div>

        <aside className="panel briefing-panel">
          <p className="eyebrow">Table rules</p>
          <h2>What the console shows</h2>
          <ul>
            <li>Trusted local viewers can see public and private game events.</li>
            <li>Private Seer and Werewolf context remains inside the game container.</li>
            <li>Roles appear when players are eliminated and in the final result.</li>
            <li>One local run is allowed at a time by default.</li>
          </ul>
        </aside>
      </section>

      <section className="history-section" aria-labelledby="history-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Game desk</p>
            <h2 id="history-heading">Runs at a glance</h2>
          </div>
        </div>
        {games.length === 0 ? (
          <div className="empty-state">No games yet. Start the first village above.</div>
        ) : (
          <>
            <div className="run-group" aria-labelledby="active-runs-heading">
              <div className="run-group-heading">
                <h3 id="active-runs-heading">Active runs</h3>
              <span>{activeCount} active</span>
              </div>
              {activeGames.length === 0 ? (
                <p className="run-group-empty">No active games. Launch a new village when you are ready.</p>
              ) : (
                <div className="run-list active-run-list">
                  {activeGames.map((game) => <RunCard active game={game} href={gamePath(mode, game.id)} key={game.id} />)}
                </div>
              )}
            </div>
            {archivedGames.length > 0 ? (
              <div className="run-group archive-group" aria-labelledby="archive-heading">
                <div className="run-group-heading">
                  <h3 id="archive-heading">Archive</h3>
                  <span>{archivedGames.length} saved</span>
                </div>
                <div className="run-list">
                  {archivedGames.map((game) => <RunCard game={game} href={gamePath(mode, game.id)} key={game.id} />)}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
