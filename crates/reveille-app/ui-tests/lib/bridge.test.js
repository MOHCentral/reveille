// SPDX-License-Identifier: GPL-3.0-only

// `lib/bridge.js`: the only reader of `window.__TAURI__`, and the error normaliser.
//
// The error-normalisation test here is the second of the two behavioural assertions that used to
// live inside `tools/check-sources.mjs`.

import test from "node:test";
import assert from "node:assert/strict";

import { installTauri } from "../fakes/tauri.js";
import { errorText, invoke, invokeWithChannel, listen } from "../../ui/lib/bridge.js";

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
  await listen("reveille://install", (payload) => seen.push(payload));
  bridge.emit("reveille://install", { index: 1, of: 3 });
  assert.deepEqual(seen, [{ index: 1, of: 3 }]);
  delete globalThis.window;
});

test("a channel hears its own command until that command settles", async () => {
  const bridge = installTauri();
  const seen = [];
  let settle;
  bridge.results.browse_servers = () => new Promise((resolve) => (settle = resolve));
  const call = invokeWithChannel("browse_servers", { session: "s" }, "onProgress", (message) => seen.push(message));
  bridge.send("browse_servers", 1);
  settle("done");
  assert.equal(await call, "done");
  bridge.send("browse_servers", 2);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(Object.keys(bridge.calls[0].args), ["session", "onProgress"]);
  delete globalThis.window;
});

/* Error normalisation -------------------------------------------------------*/

test("the Windows extended-length prefix never reaches player-facing text", async () => {
  // Tauri can serialize a canonical Windows path with `\\?\` in front of it. A message quoting a
  // folder should quote it the way the player would write it.
  assert.equal(
    errorText(String.raw`Windows protects \\?\C:\Program Files\MOHAA`),
    String.raw`Windows protects C:\Program Files\MOHAA`,
  );
});

test("errorText yields a string whatever the rejection was", () => {
  assert.equal(errorText("plain"), "plain");
  assert.equal(errorText(new Error("thrown")), "thrown");
  assert.equal(errorText({ message: "shaped" }), "shaped");
  assert.equal(errorText(null), "null");
  assert.equal(errorText(42), "42");
  // Whatever happened, the caller gets something it can put on screen rather than "[object
  // Object]" arriving in the middle of a sentence.
  assert.equal(typeof errorText({ nope: true }), "string");
});
