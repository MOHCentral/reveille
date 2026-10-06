// SPDX-License-Identifier: GPL-3.0-only

// `lib/intents.js`: the shell's frozen intents table and its boot assertion.

import test from "node:test";
import assert from "node:assert/strict";

import { INTENT_NAMES, intentsTable } from "../../ui/lib/intents.js";

const bound = () => Object.fromEntries(INTENT_NAMES.map((name) => [name, () => name]));

test("a fully bound table is frozen and calls through to each binding", () => {
  const intents = intentsTable(bound());
  assert.ok(Object.isFrozen(intents));
  assert.deepEqual(Object.keys(intents), [...INTENT_NAMES]);
  assert.equal(intents.openServer(), "openServer");
  assert.throws(() => {
    "use strict";
    intents.select = () => {};
  }, TypeError);
});

test("an intent left unbound at boot is refused by name", () => {
  const bindings = bound();
  delete bindings.openServer;
  bindings.check = undefined;
  assert.throws(() => intentsTable(bindings), /Unbound intents: check, openServer/);
});

test("an intent the table does not declare is refused rather than smuggled in", () => {
  assert.throws(() => intentsTable({ ...bound(), openSettings: () => {} }), /Unknown intents: openSettings/);
});

test("the table names exactly the plan's seven intents", () => {
  assert.deepEqual(
    [...INTENT_NAMES].sort(),
    ["activate", "check", "openServer", "refresh", "select", "selectGame", "togglePlayerAlert"],
  );
});
