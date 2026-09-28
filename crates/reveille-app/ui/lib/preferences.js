// SPDX-License-Identifier: GPL-3.0-only

// The Settings panel's values. Read once and kept in memory: the ping bands are asked for on
// every row of every paint.

import { THRESHOLDS } from "./player-alerts.js";

const KEY = "reveille.preferences";

export const COOLDOWN_CHOICES = [5, 15, 30, 60];
export const PING_GOOD_CHOICES = [50, 80, 100];
export const PING_FAIR_CHOICES = [120, 150, 200];

const DEFAULTS = {
  alertsEnabled: true,
  defaultThreshold: 1,
  cooldownMinutes: 15,
  quietWhilePlaying: false,
  pingGood: 80,
  pingFair: 150,
  refreshOnFocus: true,
  closeToTray: false,
};

const RULES = {
  alertsEnabled: (value) => typeof value === "boolean",
  defaultThreshold: (value) => THRESHOLDS.includes(value),
  cooldownMinutes: (value) => COOLDOWN_CHOICES.includes(value),
  quietWhilePlaying: (value) => typeof value === "boolean",
  pingGood: (value) => PING_GOOD_CHOICES.includes(value),
  pingFair: (value) => PING_FAIR_CHOICES.includes(value),
  refreshOnFocus: (value) => typeof value === "boolean",
  closeToTray: (value) => typeof value === "boolean",
};

let cached = null;

export function preferences() {
  if (cached) return cached;
  let saved = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (parsed && typeof parsed === "object") saved = parsed;
  } catch {
    // A corrupt value falls back to the defaults rather than refusing to start.
  }
  cached = Object.fromEntries(
    Object.entries(DEFAULTS).map(([name, fallback]) => [
      name,
      RULES[name](saved[name]) ? saved[name] : fallback,
    ]),
  );
  return cached;
}

/** Change one setting. An unknown name or a value outside its choices is refused. */
export function setPreference(name, value) {
  if (!RULES[name]?.(value)) return false;
  cached = { ...preferences(), [name]: value };
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    // The change still holds for this run.
  }
  return true;
}

/** Forget the in-memory copy, so the next read comes from storage. For tests. */
export function reloadPreferences() {
  cached = null;
}
