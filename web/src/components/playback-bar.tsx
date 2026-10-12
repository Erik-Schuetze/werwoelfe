"use client";

import { describeDuration, SPEEDS, type Speed } from "@/lib/cadence";

type Props = {
  playing: boolean;
  speed: Speed;
  progress: number;
  caughtUp: boolean;
  remainingMs: number;
  remainingBeats: number;
  active: boolean;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSpeed: (speed: Speed) => void;
  onLive: () => void;
  voiceEnabled: boolean;
  voiceSupported: boolean;
  onToggleVoice: () => void;
};

export function PlaybackBar({
  playing,
  speed,
  progress,
  caughtUp,
  remainingMs,
  remainingBeats,
  active,
  onToggle,
  onPrevious,
  onNext,
  onSpeed,
  onLive,
  voiceEnabled,
  voiceSupported,
  onToggleVoice,
}: Props) {
  const instant = speed === "instant";
  // 0..1, clamped; drives the compositor-only scaleX fill. Instant is always full.
  const ratio = instant ? 1 : Math.min(1, Math.max(0, progress));
  return (
    <div className="playback-bar">
      <div className="playback-controls">
        <button
          aria-keyshortcuts="ArrowLeft ,"
          aria-label="Previous beat"
          className="icon-button"
          onClick={onPrevious}
          title="Previous beat (← or ,)"
          type="button"
        >
          ⟨
        </button>
        <button
          aria-keyshortcuts="Space k"
          aria-label={playing ? "Pause" : "Play"}
          className="primary-button play-button"
          onClick={onToggle}
          title="Play or pause (Space or K)"
          type="button"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button
          aria-keyshortcuts="ArrowRight ."
          aria-label="Next beat"
          className="icon-button"
          onClick={onNext}
          title="Next beat (→ or .)"
          type="button"
        >
          ⟩
        </button>
        {/* Narration is a viewer preference, not a transport control, but it
            belongs with the other icon buttons so the whole "what the stage
            does right now" cluster reads as one unit. It is only disabled when
            the browser has no Web Speech voice at all — an unsupported browser
            should say why rather than silently do nothing. */}
        <button
          aria-keyshortcuts="M"
          aria-label={voiceEnabled ? "Turn narration off" : "Turn narration on"}
          aria-pressed={voiceEnabled}
          className="icon-button"
          disabled={!voiceSupported}
          onClick={onToggleVoice}
          title={voiceSupported ? (voiceEnabled ? "Narration on" : "Narration off") : "Narration is not supported in this browser"}
          type="button"
        >
          {voiceEnabled ? "🔊" : "🔇"}
        </button>
      </div>

      <div
        aria-label="Playback progress"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(ratio * 100)}
        className="beat-progress"
        role="progressbar"
      >
        <span
          aria-hidden="true"
          className="beat-progress-fill"
          style={{ transform: `scaleX(${ratio})` }}
        />
      </div>

      <fieldset className="speed-list">
        <legend className="visually-hidden">Playback speed</legend>
        {SPEEDS.map((value) => (
          <button
            aria-pressed={speed === value}
            className={speed === value ? "active" : ""}
            key={value}
            onClick={() => onSpeed(value)}
            type="button"
          >
            {value}×
          </button>
        ))}
        <button
          aria-pressed={instant}
          className={instant ? "active" : ""}
          onClick={() => onSpeed("instant")}
          type="button"
        >
          Instant
        </button>
      </fieldset>

      {caughtUp ? (
        <span className={`live-pill${active ? " is-live" : ""}`}>
          {active ? "Up to date with the game" : "End of the run"}
        </span>
      ) : (
        <button
          aria-keyshortcuts="End"
          className="secondary-button drift-chip"
          onClick={onLive}
          title="Jump to live (End)"
          type="button"
        >
          {describeDuration(remainingMs)} behind · {remainingBeats}{" "}
          {remainingBeats === 1 ? "beat" : "beats"} · jump to live
        </button>
      )}

      <span className="playback-keys">Space / K play · ← / → step · Home / End · S skip · M narrate</span>
    </div>
  );
}
