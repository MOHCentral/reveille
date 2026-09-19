// SPDX-License-Identifier: GPL-3.0-only

// An in-memory `localStorage`.
//
// `store.js` and `bookmarks.js` read the global at *call* time, never at module load, so
// assigning it before a test is enough — no dynamic import needed. That is not true of
// `api.js`; see `fakes/tauri.js`.

/**
 * Install a fresh in-memory `localStorage` on `globalThis` and return a handle to it.
 *
 * `seed` writes raw strings, so a test can start from a blob an older Reveille wrote and assert
 * that the migration reads it — which is the only way to test a migration honestly.
 */
export function installStorage(seed = {}) {
  const entries = new Map(Object.entries(seed));
  const storage = {
    getItem: (key) => (entries.has(key) ? entries.get(key) : null),
    setItem: (key, value) => entries.set(String(key), String(value)),
    removeItem: (key) => entries.delete(key),
    clear: () => entries.clear(),

    /* Test-side access, not part of the browser API. */
    raw: (key) => (entries.has(key) ? entries.get(key) : null),
    json: (key) => JSON.parse(entries.get(key) ?? "null"),
    keys: () => [...entries.keys()],
  };
  globalThis.localStorage = storage;
  return storage;
}

/**
 * Install a `localStorage` whose every operation throws.
 *
 * Every access in `store.js` and `bookmarks.js` is wrapped in try/catch, with a comment saying a
 * launcher that cannot persist a preference still works. This is how that claim gets tested
 * rather than asserted.
 */
export function installBrokenStorage() {
  const refuse = () => {
    throw new Error("storage is unavailable");
  };
  globalThis.localStorage = {
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
    clear: refuse,
  };
}
