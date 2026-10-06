// SPDX-License-Identifier: GPL-3.0-only

// Source-text checks over `ui/app.js`. It cannot be imported here: it imports every view and
// touches `document` at module load. Each check becomes a behaviour test once its controller moves
// out of `app.js`.

import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./read.js";

const app = read("ui/app.js");

test("the shell sweeps again when the session the list was swept for changed", () => {
  // The failure it guards is invisible: the wrong game's servers under the right heading, with no
  // error and nothing on screen to contradict them. The regression it catches is a real one that
  // shipped: `enterServers` swept only when the table was empty, so returning from setup with a
  // different game kept the list from the game just left.
  assert.ok(
    app.includes("if (!state.servers.length || !listIsForCurrentSession()) refresh();"),
    "ui/app.js: enterServers must sweep again when the list is for another session",
  );

  // The comparison itself — that all three of folder, engine and game count — is asserted
  // behaviourally in `ui-tests/lib/session.test.js`, and that a sweep records the session it asked
  // in `ui-tests/features/servers/browse.test.js`.
});
