// SPDX-License-Identifier: GPL-3.0-only

// `lib/bridge.js`: the only reader of `window.__TAURI__`.

import test from "node:test";
import assert from "node:assert/strict";

import { installTauri } from "../fakes/tauri.js";
import { invoke, listen } from "../../ui/lib/bridge.js";

test("the bridge is read when a command runs, not when the module loads", async () => {
  assert.equal(globalThis.window, undefined);
  assert.throws(() => invoke("detect_install"), /bridge is not available/);

  const bridge = installTauri({ detect_install: "found" });
  assert.equal(await invoke("detect_install", { selectedPath: null }), "found");
  assert.deepEqual(bridge.calls, [{ command: "detect_install", args: { selectedPath: null } }]);
  delete globalThis.window;
});

test("a listener receives the payload, never the Tauri envelope", async () => {
  const bridge = installTauri();
  const seen = [];
  await listen("reveille://browse", (payload) => seen.push(payload));
  bridge.emit("reveille://browse", { probed: 3 });
  assert.deepEqual(seen, [{ probed: 3 }]);
  delete globalThis.window;
});
