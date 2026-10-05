// SPDX-License-Identifier: GPL-3.0-only

// Source-text checks over `ui/views/join.js` for what must stay absent: a rendering test can show
// one server's pane is empty, not that no branch can bring a section back.

import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./read.js";

const join = read("ui/views/join.js");

test("a ready server adds nothing to the detail pane", () => {
  // Silence is the correct rendering of "nothing to do". `needsSection` returns null when there
  // is no explanation to give, no cost, no choice pending and no caveat true of this server, which
  // is the ordinary case and the one a player is trying to pick out of the list.
  assert.ok(
    join.includes(
      "if (!resolving && !explanation && !costly && !choices.length && !notes && !state.previewError) {",
    ),
    "ui/views/join.js: needsSection must render nothing for a server with nothing to say",
  );
  // The published rotation is not listed at all. A map already on disk needs no row, and a
  // missing map that resolves is a number in the button rather than a list to read.
  for (const gone of ["function rotationSection(", "On disk — nothing to do", "Missing locally"]) {
    assert.ok(
      !join.includes(gone),
      `ui/views/join.js: the map rotation listing must not come back (${gone})`,
    );
  }
});
