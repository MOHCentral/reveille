// SPDX-License-Identifier: GPL-3.0-only

// The Settings panel's values. Read once and kept in memory: the ping bands are asked for on
// every row of every paint. Features add their own settings with `registerPreferences`.

const KEY = "reveille.preferences";

export const PING_GOOD_CHOICES = [50, 80, 100];
export const PING_FAIR_CHOICES = [120, 150, 200];

const DEFAULTS = {
  pingGood: 80,
  pingFair: 150,
  refreshOnFocus: true,
  closeToTray: false,
  // Not settings, but one-time choices and explanations that must not come back.
  trayChosen: false,
  trayNoticeShown: false,
};

const RULES = {
  pingGood: (value) => PING_GOOD_CHOICES.includes(value),
  pingFair: (value) => PING_FAIR_CHOICES.includes(value),
  refreshOnFocus: (value) => typeof value === "boolean",
  closeToTray: (value) => typeof value === "boolean",
  trayChosen: (value) => typeof value === "boolean",
  trayNoticeShown: (value) => typeof value === "boolean",
};

let cached = null;

/**
 * Add a feature's settings: each name's default and the rule a saved value must pass.
 *
 * The owning module calls this when it loads, so its settings exist before the first read. The
 * in-memory copy is dropped because it was built without them.
 */
export function registerPreferences(defaults, rules) {
  Object.assign(DEFAULTS, defaults);
  Object.assign(RULES, rules);
  cached = null;
}

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
