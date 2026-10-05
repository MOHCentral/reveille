// SPDX-License-Identifier: GPL-3.0-only

// One state object and a subscribe/notify pair. Views read `state` and re-render
// on change; nothing else holds application state. Each feature declares its keys in an
// `initial()` part, and `app.js` composes the parts into this object at boot.

import { DEFAULT_GAME } from "./catalog.js";

/** The keys whose features do not declare them yet. */
const unowned = () => ({
  /** The identified installation, or null while first run is unresolved. */
  install: null,
  /** Explicit engine choice for this installation. */
  engine: null,
  /**
   * Which of the three games this session is browsing and joining.
   *
   * It is not a filter over one list: each game has its own master registration, its own servers,
   * and its own search path on disk, so changing it starts a different sweep.
   */
  game: DEFAULT_GAME,

  /** The folder accepted on a previous run, if any. */
  rememberedInstall: null,

  /**
   * The session the rows on screen were swept for, or null before the first sweep.
   *
   * The list is not a view of "the servers": it is the answer to one particular question — this
   * folder, this engine, this game. Nothing on screen says which, so a list left over from a
   * session that has since changed would read as a current answer to the new question. Keeping
   * what it was swept for is what lets a returning session tell the difference.
   */
  listSession: null,

  /** What the watch monitor last read for each watched server, keyed by `alertId`. */
  watchReadings: new Map(),
  /** Why the last player alert could not reach the desktop, or null. */
  alertError: null,
});

/** Compose parts into one object, refusing a key two parts declare: a shared key has one owner. */
export function createState(parts) {
  const composed = {};
  for (const part of parts) {
    for (const key of Object.keys(part)) {
      if (Object.hasOwn(composed, key)) throw new Error(`state.${key} is declared by two parts`);
    }
    Object.assign(composed, part);
  }
  return composed;
}

export const state = createState([unowned()]);

/** Add the features' parts to `state`, before anything reads their keys. */
export function composeState(parts) {
  Object.assign(state, createState([state, ...parts]));
}

const subscribers = new Set();

export function subscribe(handler) {
  subscribers.add(handler);
  return () => subscribers.delete(handler);
}

export function notify() {
  for (const handler of subscribers) handler();
}

/** Mutate through a callback, then notify once. */
export function update(mutate) {
  mutate(state);
  notify();
}

/* Saved scopes ------------------------------------------------------------- */

const savedScopes = new Map();

/** Supply a saved scope's entries. The feature that stores them registers when it loads. */
export function registerSavedScope(scope, entries) {
  savedScopes.set(scope, entries);
}

/** The entries a saved scope holds, or none before its feature has loaded. */
export function saved(scope) {
  return savedScopes.get(scope)?.() ?? [];
}
