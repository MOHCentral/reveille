// SPDX-License-Identifier: GPL-3.0-only

// Which installation, engine and game the player is in, what is remembered of them between runs,
// and the generation counters that discard results still in flight from a session that has moved on.

import { DEFAULT_GAME, ENGINES, GAMES } from "./catalog.js";
import { state } from "./store.js";

// Pinned: renaming one forgets every player's setup on upgrade.
export const STORAGE_KEYS = Object.freeze({
  install: "reveille.install",
  engines: "reveille.engines",
  games: "reveille.games",
});

/* Persistence -------------------------------------------------------------- */

export function rememberInstall(root) {
  try {
    localStorage.setItem(STORAGE_KEYS.install, root);
  } catch {
    // A launcher that cannot write a preference still works; detection reruns.
  }
}

export function recallInstall() {
  try {
    return localStorage.getItem(STORAGE_KEYS.install);
  } catch {
    return null;
  }
}

export function rememberEngine(root, engine) {
  try {
    const choices = JSON.parse(localStorage.getItem(STORAGE_KEYS.engines) ?? "{}");
    choices[root] = engine;
    localStorage.setItem(STORAGE_KEYS.engines, JSON.stringify(choices));
  } catch {
    // The explicit in-memory choice still works for this session.
  }
}

export function recallEngine(root) {
  try {
    const engine = JSON.parse(localStorage.getItem(STORAGE_KEYS.engines) ?? "{}")[root];
    return ENGINES.includes(engine) ? engine : null;
  } catch {
    return null;
  }
}

/**
 * Remember the game per install folder, like the engine.
 *
 * Per folder rather than globally: a second installation may not have the same expansions, and a
 * remembered game its data directories cannot serve would be a session that fails on its first
 * command.
 */
export function rememberGame(root, game) {
  try {
    const choices = JSON.parse(localStorage.getItem(STORAGE_KEYS.games) ?? "{}");
    choices[root] = game;
    localStorage.setItem(STORAGE_KEYS.games, JSON.stringify(choices));
  } catch {
    // The explicit in-memory choice still works for this session.
  }
}

export function recallGame(root) {
  try {
    const game = JSON.parse(localStorage.getItem(STORAGE_KEYS.games) ?? "{}")[root];
    return GAMES.includes(game) ? game : null;
  } catch {
    return null;
  }
}

/**
 * Move the setup choices to a copy only after Rust has returned a re-identified installation.
 *
 * The old keys are removed so the remembered root and its engine/game choices move together. If
 * browser storage is unavailable, the validated copy still becomes the in-memory candidate and
 * setup remains usable for this run.
 */
export function migrateInstallationPreferences(oldRoot, newRoot, engine, game) {
  try {
    const engines = JSON.parse(localStorage.getItem(STORAGE_KEYS.engines) ?? "{}");
    const games = JSON.parse(localStorage.getItem(STORAGE_KEYS.games) ?? "{}");
    delete engines[oldRoot];
    delete games[oldRoot];
    if (engine) engines[newRoot] = engine;
    if (game) games[newRoot] = game;
    localStorage.setItem(STORAGE_KEYS.engines, JSON.stringify(engines));
    localStorage.setItem(STORAGE_KEYS.games, JSON.stringify(games));
    localStorage.setItem(STORAGE_KEYS.install, newRoot);
  } catch {
    // The explicit in-memory choices still work for this session.
  }
}

/**
 * The games an install can actually run, which is not the same as the products detected in it:
 * an expansion needs the base game underneath it, and the Rust side decides that.
 */
export function playableGames(install) {
  return install?.playable ?? [];
}

/**
 * The game a session should open on: the remembered one when this install can still run it,
 * otherwise the first game it can.
 */
export function defaultGame(install) {
  const games = playableGames(install);
  const remembered = install ? recallGame(install.root) : null;
  if (remembered && games.includes(remembered)) return remembered;
  return games[0] ?? DEFAULT_GAME;
}

/**
 * `Installation` from `reveille-core/src/install.rs`. `products` is what is on disk; `playable` is
 * what can be run, since an expansion needs the base game underneath it.
 *
 * @typedef {object} Installation
 * @property {string} root
 * @property {import("./catalog.js").GameId[]} products
 * @property {import("./catalog.js").GameId[]} playable
 * @property {{ path: string, sha256: string, known_version: string | null }[]} binaries
 * @property {{ method: "known_binary_hashes" | "recognized_binary_unknown_hashes" | "data_directories_only" }} identification
 */

/**
 * `Session` from `src/session.rs`. Every server-facing command takes all three together, because a
 * folder and an engine without a game names no search path.
 *
 * @typedef {object} Session
 * @property {string} path
 * @property {import("./catalog.js").EngineId} engine
 * @property {import("./catalog.js").GameId} game
 */

/**
 * The three facts every server-facing command needs.
 *
 * @returns {Session}
 */
export function session() {
  return { path: state.install.root, engine: state.engine, game: state.game };
}

/**
 * Whether the rows on screen were swept for the session in force now.
 *
 * All three facts count. The game decides which master registration was asked and which servers
 * exist at all; the folder and the engine decide the search path every row's compatibility was
 * judged against. A change to any of them makes the list an answer to a question no longer being
 * asked.
 */
export function listIsForCurrentSession() {
  const swept = state.listSession;
  if (!swept || !state.install) return false;
  const now = session();
  return swept.path === now.path && swept.engine === now.engine && swept.game === now.game;
}

/* Generations ---------------------------------------------------------------- */

/**
 * A counter whose value names the results worth rendering. Taking `next()` makes every earlier
 * token stale; `current()` joins the generation in force without retiring anyone.
 */
function generation() {
  let value = 0;
  return Object.freeze({
    next: () => ++value,
    current: () => value,
    isCurrent: (token) => token === value,
  });
}

/**
 * `preview` counts selections and `join` counts install and launch runs.
 *
 * `check` counts lists, not calls: a sweep and a game switch both make every answer still in flight
 * an answer about a list that no longer exists. Two checks running at once do **not** cancel each
 * other — an earlier design bumped this on every call, so re-checking one server abandoned the
 * favorites batch mid-way and left the row it was probing reading "Checking…" for a request nobody
 * was waiting on.
 */
export const generations = Object.freeze({
  preview: generation(),
  check: generation(),
  join: generation(),
});

/**
 * Discard every preview, check and join result still in flight. Only the counters move: what each
 * caller clears from `state` differs, so the resets stay beside the call.
 */
export function retireInFlight() {
  generations.preview.next();
  generations.check.next();
  generations.join.next();
}
