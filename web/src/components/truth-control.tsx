"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { getServerSnapshot, getSnapshot, subscribe, update, type Preferences } from "@/lib/preferences";
import type { TruthLevel } from "@/lib/truth";

const LEVELS: { id: TruthLevel; label: string; hint: string }[] = [
  { id: "blind", label: "Blind", hint: "You know only what the village knows." },
  { id: "spectator", label: "Spectator", hint: "You know who the werewolves are; the village does not." },
  { id: "director", label: "Director", hint: "Every private channel, for checking the run." },
];

/**
 * Stored preferences cannot be known while the server renders, so the hydrating
 * render is pinned to the server snapshot and the real values land immediately
 * after. Without this the page throws a hydration error for anyone who has ever
 * changed the truth level or the speed.
 */
export function usePreferences(): Preferences {
  const stored = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? stored : getServerSnapshot();
}

export function TruthControl() {
  const preferences = usePreferences();
  const active = LEVELS.find((level) => level.id === preferences.level) ?? LEVELS[1];

  return (
    <div className="truth-control">
      <div className="truth-head">
        <p className="eyebrow">What you are allowed to know</p>
        <p className="truth-hint">{active.hint}</p>
      </div>
      <fieldset className="truth-levels">
        <legend className="visually-hidden">Truth level</legend>
        {LEVELS.map((level) => (
          <button
            aria-pressed={preferences.level === level.id}
            className={preferences.level === level.id ? "active" : ""}
            key={level.id}
            onClick={() => update({ level: level.id })}
            type="button"
          >
            {level.label}
          </button>
        ))}
      </fieldset>
      {preferences.level === "blind" ? null : (
        <button
          aria-pressed={preferences.reasoning}
          className="secondary-button reasoning-toggle"
          onClick={() => update({ reasoning: !preferences.reasoning })}
          type="button"
        >
          {preferences.reasoning ? "Hide private reasoning" : "Show private reasoning"}
        </button>
      )}
    </div>
  );
}
