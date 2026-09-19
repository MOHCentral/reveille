// SPDX-License-Identifier: GPL-2.0-only

// A recording stand-in for the `window.__TAURI__` bridge that `withGlobalTauri` provides.
//
// `lib/api.js` destructures `window.__TAURI__` at **module load** (`const tauri = window.__TAURI__`
// and its three consts), so importing it without a bridge in place throws. Order is therefore
// load-bearing, and a static `import` would be hoisted above any `beforeEach`. Tests use the
// explicit form instead:
//
//     const bridge = installTauri();
//     const api = await import("../../ui/lib/api.js");
//
// Node caches an ES module per process, so `api.js` is evaluated once for the whole file however
// many times it is imported. That is why per-test state lives in the bridge — `calls`, `listeners`
// — and is reset there, rather than by trying to get a fresh copy of the module.

/**
 * Install a recording bridge on `globalThis.window` and return it.
 *
 * `results` maps a command name to what its `invoke` should resolve to, or to a function of the
 * argument object. An unmapped command resolves to `undefined`, which is what a `void` command
 * returns anyway.
 */
export function installTauri(results = {}) {
  const bridge = {
    /** Every `invoke`, in order: `{ command, args }`. */
    calls: [],
    /** Channel -> the handlers `api.js` registered for it. */
    listeners: new Map(),
    /** Every `openUrl`, in order. */
    opened: [],
    /** How many unlisten functions callers have been handed. */
    unlistens: 0,

    /** What the next `invoke` of each command resolves to. Mutable between tests. */
    results: { ...results },

    /** Deliver an event as Tauri would, wrapped in its envelope. */
    emit(channel, payload) {
      for (const handler of bridge.listeners.get(channel) ?? []) handler({ payload });
    },

    /** Forget recorded traffic without replacing the module-level bridge. */
    reset() {
      bridge.calls.length = 0;
      bridge.opened.length = 0;
      bridge.listeners.clear();
      bridge.unlistens = 0;
    },

    /** Make the next `invoke` of `command` reject with `error`, whatever its shape. */
    fail(command, error) {
      bridge.results[command] = () => Promise.reject(error);
    },
  };

  globalThis.window = {
    __TAURI__: {
      core: {
        invoke(command, args) {
          bridge.calls.push({ command, args });
          const result = bridge.results[command];
          return Promise.resolve(typeof result === "function" ? result(args) : result);
        },
      },
      event: {
        listen(channel, handler) {
          const handlers = bridge.listeners.get(channel) ?? [];
          handlers.push(handler);
          bridge.listeners.set(channel, handlers);
          return Promise.resolve(() => {
            bridge.unlistens += 1;
          });
        },
      },
      opener: {
        openUrl(url) {
          bridge.opened.push(url);
          return Promise.resolve();
        },
      },
    },
  };

  return bridge;
}
