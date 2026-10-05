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
    app.includes("next.listSession = swept;"),
    "ui/app.js: refresh must record the session its rows were swept for",
  );
  assert.ok(
    app.includes("if (!state.servers.length || !listIsForCurrentSession()) refresh();"),
    "ui/app.js: enterServers must sweep again when the list is for another session",
  );

  // The comparison itself — that all three of folder, engine and game count — is asserted
  // behaviourally in `ui-tests/lib/store.test.js`.
});

test("one check does not cancel another", () => {
  // Found by review. A single token bumped per call meant re-checking one server abandoned the
  // favorites batch mid-way and left the row it was probing reading "Checking…" for a request
  // nobody was waiting on. The token counts list generations — a sweep and a game switch — not
  // calls.
  assert.ok(
    app.includes("const generation = checkGeneration;"),
    "ui/app.js: check must capture the generation, not allocate a new token per call",
  );
  assert.ok(
    app.includes("  checkGeneration += 1;\n  const swept = session();"),
    "ui/app.js: a sweep must retire the checks still in flight against the old list",
  );
});

test("a failed sweep keeps the rows it could not replace", () => {
  // Blanking the table on a failed sweep left the centre of the window reading "Nothing has been
  // checked yet" under an error about the check that had just run. The rows are kept and marked
  // instead — and only when they were swept for the session still in force, or they would be
  // another game's servers under this game's heading.
  assert.ok(
    app.includes("const previous = listIsForCurrentSession() ? state.servers : [];"),
    "ui/app.js: only a list swept for this session may be kept as a stale reading",
  );
  assert.ok(
    app.includes("next.staleAt = previousAt;"),
    "ui/app.js: kept rows must carry the time they were actually measured",
  );
});
