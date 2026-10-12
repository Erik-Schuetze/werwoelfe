import { SPEEDS, type Speed } from "@/lib/cadence";
import type { TruthLevel } from "@/lib/truth";

/**
 * Viewer preferences for the spectator page, shared between tabs.
 *
 * `getSnapshot` must return a **referentially stable** object or React 19's
 * `useSyncExternalStore` re-renders in a loop, so the snapshot is module-cached
 * and only replaced inside `update`.
 */

export type { Speed };

export type Preferences = {
  level: TruthLevel;
  /** Show the players' own private reasoning where it was captured. */
  reasoning: boolean;
  speed: Speed;
  /** Read the beats aloud with the Web Speech API. Off until asked for. */
  voice: boolean;
};

const KEY = "werwoelfe.game-detail.truth-level";
const LEGACY_KEY = "werwoelfe.game-detail.display-mode";
const CHANGE_EVENT = "werwoelfe:game-detail-preferences";

const SERVER_SNAPSHOT: Preferences = { level: "spectator", reasoning: false, speed: 1, voice: false };

let snapshot: Preferences | null = null;
let storageAvailable = true;

function read(): Preferences {
  const next: Preferences = { ...SERVER_SNAPSHOT };
  if (!storageAvailable) return next;
  try {
    const stored = window.localStorage.getItem(KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Preferences>;
      if (parsed.level === "blind" || parsed.level === "spectator" || parsed.level === "director") {
        next.level = parsed.level;
      }
      if (typeof parsed.reasoning === "boolean") next.reasoning = parsed.reasoning;
      if (typeof parsed.voice === "boolean") next.voice = parsed.voice;
      if (parsed.speed === "instant" || SPEEDS.some((value) => value === parsed.speed)) {
        next.speed = parsed.speed as Speed;
      }
      return next;
    }
    // Migrate the old spoiler toggle without silently un-hiding anything: a
    // viewer who had chosen to hide private content stays hidden.
    const legacy = window.localStorage.getItem(LEGACY_KEY);
    if (legacy === "director") next.level = "director";
    else if (legacy === "audience") next.level = "blind";
  } catch {
    storageAvailable = false;
  }
  return next;
}

export function getSnapshot(): Preferences {
  if (!snapshot) snapshot = read();
  return snapshot;
}

export function getServerSnapshot(): Preferences {
  return SERVER_SNAPSHOT;
}

export function subscribe(onChange: () => void): () => void {
  const handler = (): void => {
    snapshot = read();
    onChange();
  };
  window.addEventListener("storage", handler);
  window.addEventListener(CHANGE_EVENT, handler);
  return () => {
    window.removeEventListener("storage", handler);
    window.removeEventListener(CHANGE_EVENT, handler);
  };
}

export function update(patch: Partial<Preferences>): void {
  // Replace the cached snapshot *before* notifying, so every subscriber reads
  // the same new object on the synchronous re-render.
  snapshot = { ...getSnapshot(), ...patch };
  if (storageAvailable) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(snapshot));
    } catch {
      storageAvailable = false;
    }
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
