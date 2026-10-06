// SPDX-License-Identifier: GPL-3.0-only

// `features/join/format.js`: the compatibility verdict the join pane names and explains.

import test from "node:test";
import assert from "node:assert/strict";

import { stateExplanation, stateName } from "../../../ui/features/join/format.js";

/* The four states (rule H3) ------------------------------------------------- */

test("the four state names are measurements, not verdicts", () => {
  // There is no boolean "can I join", and none of these is a mood word: the name says what
  // Reveille found and the player draws the verdict.
  assert.equal(stateName({ state: "compatible" }), "Compatible");
  assert.equal(stateName({ state: "needs_maps", count: 1 }), "Needs 1 map");
  assert.equal(stateName({ state: "needs_maps", count: 4 }), "Needs 4 maps");
  assert.equal(stateName({ state: "no_source", count: 2 }), "No download for 2 maps");
  assert.equal(stateName({ state: "cant_tell" }), "Map list not published");
  assert.equal(stateName(null), "Map list not published");
});

test("a server that leaves nothing to do explains nothing", () => {
  assert.equal(stateExplanation({ state: "compatible" }), null);
  // The current map was checked; the unpublished rest is nothing a player can act on before joining.
  assert.equal(stateExplanation({ state: "cant_tell" }), null);
});

test("every other state explains how it was arrived at", () => {
  assert.match(stateExplanation({ state: "needs_maps", count: 3 }), /Reveille can download/u);
  // Singular and plural are separate sentences rather than one with an "(s)".
  assert.match(stateExplanation({ state: "no_source", count: 1 }), /This map is/u);
  assert.match(stateExplanation({ state: "no_source", count: 2 }), /These maps are/u);
});
