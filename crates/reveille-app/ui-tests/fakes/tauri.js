// SPDX-License-Identifier: GPL-3.0-only

// A recording stand-in for the `window.__TAURI__` bridge that `withGlobalTauri` provides.
//
// `lib/bridge.js` reads `window.__TAURI__` on each call, so a test may install this before or after
// importing the modules it exercises. Node caches an ES module per process, which is why per-test
// state lives in the bridge — `calls`, `listeners` — and is reset there.

/** Stands in for `window.__TAURI__.core.Channel`: Rust's side is played by `bridge.send`. */
class Channel {
  constructor(onmessage) {
    this.onmessage = onmessage ?? (() => {});
  }
}

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

    /** Send `message` down the channel the latest `invoke` of `command` was given, as Rust would. */
    send(command, message) {
      const call = bridge.calls.findLast((entry) => entry.command === command);
      const channel = Object.values(call?.args ?? {}).find((value) => value instanceof Channel);
      if (!channel) throw new Error(`${command} was not given a channel`);
      channel.onmessage(message);
    },

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
        Channel,
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
