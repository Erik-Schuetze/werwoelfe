"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { GameDetail as GameDetailData } from "@/lib/game";
import { buildBeats, buildPlayerIndex, groupBeatsByAct } from "@/lib/beats";
import { buildCast } from "@/lib/cast";
import { alignmentGap, deriveBeliefs, deriveGroundTruth } from "@/lib/truth";
import { caseOnTable, currentVoteBoard, nightLedger, seatStates } from "@/lib/stakes";
import { usePlayback } from "@/lib/use-playback";
import { useNarration } from "@/lib/use-narration";
import { update as updatePreferences, type Speed } from "@/lib/preferences";
import { runTitle } from "@/lib/run-title";
import { BeatCard } from "@/components/beat-card";
import { CastPanel } from "@/components/cast-panel";
import { GameStage } from "@/components/game-stage";
import { LocalTime } from "@/components/local-time";
import { PlaybackBar } from "@/components/playback-bar";
import { PlayerTable } from "@/components/player-table";
import { ScrubStrip } from "@/components/scrub-strip";
import { StakeRail } from "@/components/stake-rail";
import { StatusBadge } from "@/components/status-badge";
import { TruthControl, usePreferences } from "@/components/truth-control";

/** True when a key event originated in a field the user is typing into. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export function GameDetail({ initialGame }: { initialGame: GameDetailData }) {
  const router = useRouter();
  const [game, setGame] = useState(initialGame);
  const preferences = usePreferences();
  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const [followLatest, setFollowLatest] = useState(true);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const logRef = useRef<HTMLDivElement>(null);

  const active = game.status === "queued" || game.status === "running" || game.status === "paused";
  const canPause = game.status === "running";
  const canResume = game.status === "paused";

  const playerIndex = useMemo(() => buildPlayerIndex(game.players), [game.players]);
  const nameOf = useCallback(
    (id: string) => playerIndex.byId.get(id) ?? id,
    [playerIndex],
  );
  const seatOrder = useMemo(() => game.players.map((player) => player.id), [game.players]);

  const rawBeats = useMemo(() => buildBeats(game.events, game.players), [game.events, game.players]);
  const truth = useMemo(() => deriveGroundTruth(game.players, game.events), [game.players, game.events]);

  // The cast is read straight off the event stream and shown at every truth level:
  // the generated voices are role-agnostic, so there is nothing to gate. `voiceOf`
  // is the same map seen as a lookup, for the speaker line on the stage.
  const cast = useMemo(() => buildCast(game.events, playerIndex), [game.events, playerIndex]);
  const voiceOf = useCallback((id: string) => cast.get(id), [cast]);

  const playback = usePlayback(rawBeats, preferences.speed);
  const { beats, stageBeat, previousBeat, presentedCount, caughtUp, progress, revealedChars, playing, speed } =
    playback;
  const { toggle, next: stepNext, previous: stepPrevious, jumpToLive, skipReveal, seekTo } = playback;

  // Narration follows the stage: it speaks the beat the stage is showing, stops
  // when playback stops, and re-reads at the new pace when the speed changes.
  // The hook owns all of that; this component only decides whether it is on.
  const narration = useNarration({
    stageBeat,
    playing,
    speed,
    enabled: preferences.voice,
    level: preferences.level,
    reasoning: preferences.reasoning,
    roster: seatOrder,
    nameOf,
  });

  const stageIndex = stageBeat ? beats.indexOf(stageBeat) : -1;
  const railIndex = Math.max(0, Math.min(beats.length - 1, caughtUp ? beats.length - 1 : presentedCount));
  const cursorSeq = beats[railIndex]?.lastSeq ?? 0;

  const beliefs = useMemo(
    () => deriveBeliefs(game.events, playerIndex, cursorSeq),
    [game.events, playerIndex, cursorSeq],
  );
  const voteBoard = useMemo(() => currentVoteBoard(beats, railIndex), [beats, railIndex]);
  const ledger = useMemo(() => nightLedger(beats, railIndex), [beats, railIndex]);
  const caseFile = useMemo(
    () => caseOnTable(beats, railIndex, beliefs, cursorSeq),
    [beats, railIndex, beliefs, cursorSeq],
  );
  const gap = useMemo(() => {
    const eliminated = new Set(
      beats
        .slice(0, railIndex + 1)
        .filter((beat) => beat.kind === "elimination")
        .map((beat) => (beat.kind === "elimination" ? beat.player?.id : undefined))
        .filter((id): id is string => Boolean(id)),
    );
    return alignmentGap(truth, caseFile?.suspect?.id ?? null, eliminated);
  }, [truth, caseFile, beats, railIndex]);

  const seats = useMemo(
    () => seatStates(game.players, beats, railIndex, caseFile?.suspect?.id ?? null, preferences.level),
    [game.players, beats, railIndex, caseFile, preferences.level],
  );
  const acts = useMemo(() => groupBeatsByAct(beats), [beats]);

  const toggleExpanded = useCallback((key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setSpeed = useCallback(
    (next: Speed) => {
      playback.setSpeed(next);
      updatePreferences({ speed: next });
    },
    [playback],
  );

  // Shared by the speaker button and the M key so both write the same
  // preference. The stored value is the source of truth (the hook reads it via
  // `enabled`), so flipping it here is all that narration needs.
  const toggleVoice = useCallback(() => {
    updatePreferences({ voice: !preferences.voice });
  }, [preferences.voice]);

  // The stored speed only becomes readable after mount (see usePreferences), so
  // apply it to the queue here rather than seeding it at construction.
  const { setSpeed: applySpeed } = playback;
  useEffect(() => {
    applySpeed(preferences.speed);
  }, [applySpeed, preferences.speed]);

  const refresh = useCallback(async (): Promise<void> => {
    setUpdating(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/games/${game.id}`, { cache: "no-store" });
      const payload = (await response.json()) as { error?: string; game?: GameDetailData };
      if (!response.ok || !payload.game) {
        setActionError(payload.error || "Could not refresh the game.");
        return;
      }
      setGame(payload.game);
    } catch {
      setActionError("Could not reach the operator service.");
    } finally {
      setUpdating(false);
    }
  }, [game.id]);

  async function stop(): Promise<void> {
    if (!window.confirm("Stop this game? It cannot be resumed.")) return;
    setUpdating(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/games/${game.id}`, { method: "DELETE" });
      const payload = (await response.json()) as { error?: string; game?: GameDetailData };
      if (!response.ok || !payload.game) {
        setActionError(payload.error || "Could not stop the game.");
        return;
      }
      setGame(payload.game);
    } catch {
      setActionError("Could not reach the operator service.");
    } finally {
      setUpdating(false);
    }
  }

  async function updateGameState(action: "pause" | "resume"): Promise<void> {
    setUpdating(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/games/${game.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { error?: string; game?: GameDetailData };
      if (!response.ok || !payload.game) {
        setActionError(payload.error || `Could not ${action} the game.`);
        return;
      }
      setGame(payload.game);
    } catch {
      setActionError("Could not reach the operator service.");
    } finally {
      setUpdating(false);
    }
  }

  async function restart(): Promise<void> {
    if (!window.confirm("Restart with the same configuration? The current game will be stopped.")) return;
    setUpdating(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/games/${game.id}`, { method: "POST" });
      const payload = (await response.json()) as { error?: string; game?: GameDetailData };
      if (!response.ok || !payload.game) {
        setActionError(payload.error || "Could not restart the game.");
        return;
      }
      router.push(`/games/${payload.game.id}`);
    } catch {
      setActionError("Could not reach the operator service.");
    } finally {
      setUpdating(false);
    }
  }

  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(interval);
  }, [active, refresh]);

  useEffect(() => {
    if (!logOpen || !followLatest) return;
    const container = logRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [logOpen, followLatest, acts]);

  // ---- Deep link: ?beat=N -------------------------------------------------
  // Restore once, after mount, from the raw query string. `useSearchParams` is
  // avoided on purpose: it needs a Suspense boundary and would leak the query
  // into the server render, and this page has a history of hydration errors.
  // Absent, malformed or out-of-range values are ignored silently.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || beats.length === 0) return;
    restoredRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const raw = params.get("beat");
    if (raw === null || !/^\d+$/.test(raw)) return;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > beats.length) return;
    seekTo(beats[n - 1].key);
  }, [beats, seekTo]);

  // Keep the URL on the beat the counter shows. replaceState only — pushing
  // in-page state is what breaks the back button — and debounced so playback
  // does not churn the URL on every beat. Other params and the hash survive.
  useEffect(() => {
    if (stageIndex < 0) return;
    const handle = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      params.set("beat", String(stageIndex + 1));
      const query = params.toString();
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      );
    }, 250);
    return () => window.clearTimeout(handle);
  }, [stageIndex]);

  // Defensive: back/forward that changed only ?beat= applies to the stage.
  useEffect(() => {
    function onPop(): void {
      const params = new URLSearchParams(window.location.search);
      const raw = params.get("beat");
      if (raw === null || !/^\d+$/.test(raw)) return;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > beats.length) return;
      seekTo(beats[n - 1].key);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [beats, seekTo]);

  // Keyboard transport, following the usual web-player conventions. Registered
  // on `document`; the handlers are the hook's own callbacks, so the effect
  // re-binds when one changes rather than firing through a stale closure.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          toggle();
          break;
        case "ArrowRight":
        case ".":
          event.preventDefault();
          stepNext();
          break;
        case "ArrowLeft":
        case ",":
          event.preventDefault();
          stepPrevious();
          break;
        case "Home": {
          const first = beats[0];
          if (first) {
            event.preventDefault();
            seekTo(first.key);
          }
          break;
        }
        case "End":
          event.preventDefault();
          jumpToLive();
          break;
        case "s":
          skipReveal();
          break;
        case "m":
          // Mirror the button: an unsupported browser disables it, so the key
          // does nothing rather than writing a preference that cannot be heard.
          // No preventDefault, matching the S case — M has no browser default.
          if (narration.supported) toggleVoice();
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [beats, jumpToLive, narration.supported, seekTo, skipReveal, stepNext, stepPrevious, toggle, toggleVoice]);

  const privateEvents = useMemo(
    () => game.events.filter((event) => event.visibility === "private"),
    [game.events],
  );

  return (
    <main className="shell game-page">
      <header className="game-header">
        <div>
          <Link className="back-link" href="/">
            ← All games
          </Link>
          <p className="eyebrow">Village #{game.id.slice(0, 8)}</p>
          <h1>{runTitle(game)}</h1>
        </div>
        <StatusBadge status={game.status} />
      </header>

      {game.error ? (
        <p className="failure-banner" role="alert">
          {game.error}
        </p>
      ) : null}
      {actionError ? (
        <p className="failure-banner" role="alert">
          {actionError}
        </p>
      ) : null}

      <TruthControl />

      <section className="game-layout">
        <div className="stage-column">
          <GameStage
            active={active}
            beat={stageBeat}
            beatNumber={stageIndex + 1}
            caughtUp={caughtUp}
            expandedKeys={expandedKeys}
            level={preferences.level}
            nameOf={nameOf}
            onToggle={toggleExpanded}
            playing={playing}
            previousBeat={previousBeat}
            reasoning={preferences.reasoning}
            revealedChars={revealedChars}
            skipReveal={playback.skipReveal}
            totalBeats={beats.length}
            truth={truth}
            voiceOf={voiceOf}
          />

          <PlayerTable
            level={preferences.level}
            onBlockId={caseFile?.suspect?.id ?? null}
            seatOrder={seatOrder}
            seats={seats}
            sheriffId={beliefs.sheriffId}
            truth={truth}
          />
        </div>

        <StakeRail
          caseOnTable={caseFile}
          controls={
            <>
              <button className="secondary-button" disabled={updating} onClick={() => void refresh()} type="button">
                {updating ? "Updating…" : "Refresh"}
              </button>
              {canPause ? (
                <button
                  className="secondary-button"
                  disabled={updating}
                  onClick={() => void updateGameState("pause")}
                  type="button"
                >
                  Pause the game
                </button>
              ) : null}
              {canResume ? (
                <button
                  className="primary-button"
                  disabled={updating}
                  onClick={() => void updateGameState("resume")}
                  type="button"
                >
                  Resume the game
                </button>
              ) : null}
              {active ? (
                <button className="danger-button" disabled={updating} onClick={() => void stop()} type="button">
                  Stop the game
                </button>
              ) : null}
              <button className="secondary-button" disabled={updating} onClick={() => void restart()} type="button">
                Restart with the same setup
              </button>
            </>
          }
          facts={
            <dl className="run-facts-list">
              <div>
                <dt>Started</dt>
                <dd>{game.startedAt ? <LocalTime value={game.startedAt} /> : "Waiting for Docker"}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>{game.model.name || "deepseek-flash"}</dd>
              </div>
              <div>
                <dt>Temperature</dt>
                <dd>{game.model.temperature ?? 1.0}</dd>
              </div>
              <div>
                <dt>Events</dt>
                <dd>{game.eventCount}</dd>
              </div>
              <div>
                <dt>Seed</dt>
                <dd>{game.seed}</dd>
              </div>
            </dl>
          }
          gap={gap}
          ledger={ledger}
          level={preferences.level}
          nameOf={nameOf}
          truth={truth}
          voteBoard={voteBoard}
        />
      </section>

      <section className="panel scrub-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">The run so far</p>
            <h2>Where you are</h2>
          </div>
          {active ? <span className="live-indicator">Refreshing every 1.5 seconds</span> : null}
        </div>
        <ScrubStrip
          acts={acts}
          onSeek={playback.seekTo}
          presentedCount={caughtUp ? beats.length : presentedCount}
          stageKey={stageBeat?.key}
        />
        <PlaybackBar
          active={active}
          caughtUp={caughtUp}
          onLive={playback.jumpToLive}
          onNext={playback.next}
          onPrevious={playback.previous}
          onSpeed={setSpeed}
          onToggle={playback.toggle}
          playing={playing}
          progress={progress}
          remainingBeats={playback.remainingBeats}
          remainingMs={playback.remainingMs}
          speed={speed}
          voiceEnabled={preferences.voice}
          voiceSupported={narration.supported}
          onToggleVoice={toggleVoice}
        />
      </section>

      <CastPanel cast={cast} players={game.players} />

      <section className="panel log-panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">{preferences.level === "director" ? "Operator record" : "Audience record"}</p>
            <h2>Full transcript</h2>
          </div>
          <button className="secondary-button" onClick={() => setLogOpen((open) => !open)} type="button">
            {logOpen ? "Hide transcript" : "Show transcript"}
          </button>
        </div>

        {logOpen ? (
          <>
            <div className="log-controls">
              <button
                aria-pressed={followLatest}
                className="secondary-button"
                onClick={() => setFollowLatest(true)}
                type="button"
              >
                {followLatest ? "Following the stage" : "Follow the stage"}
              </button>
              <span>{beats.length} beats · {game.eventCount} events</span>
            </div>
            <div
              className="log-scroll"
              onScroll={(event) => {
                const node = event.currentTarget;
                setFollowLatest(node.scrollHeight - node.scrollTop - node.clientHeight < 24);
              }}
              ref={logRef}
            >
              {acts.map((act, index) => (
                <section className="log-act" key={`${act.title}-${index}`}>
                  <h3>{act.title}</h3>
                  {act.beats.map((beat) => (
                    <div
                      className={`log-beat${beat.key === stageBeat?.key ? " is-current" : ""}`}
                      key={beat.key}
                    >
                      <span className="log-seq">{beat.firstSeq}</span>
                      <BeatCard
                        beat={beat}
                        compact
                        expanded={expandedKeys.has(beat.key)}
                        level={preferences.level}
                        nameOf={nameOf}
                        onToggle={toggleExpanded}
                        reasoning={preferences.reasoning}
                        truth={truth}
                      />
                    </div>
                  ))}
                </section>
              ))}
            </div>

            {preferences.level === "director" ? (
              <details className="private-record">
                <summary>Private record ({privateEvents.length} events)</summary>
                <ol>
                  {privateEvents.map((event) => (
                    <li key={event.sequence}>
                      <span className="log-seq">{event.sequence}</span>
                      <code>{event.kind}</code>
                      <span className="private-kind">
                        {event.recipients.length > 0 ? `→ ${event.recipients.map(nameOf).join(", ")}` : ""}
                      </span>
                      <p>{event.message}</p>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}
          </>
        ) : null}
      </section>
    </main>
  );
}
