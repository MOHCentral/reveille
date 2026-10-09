// SPDX-License-Identifier: GPL-3.0-only

// `lib/sections.js`: what the rail lists, which section is on screen, and what switching refuses.

import test from "node:test";
import assert from "node:assert/strict";

const { composeState, state } = await import("../../ui/lib/store.js");
const { activeSection, initial, registerSection, resetSections, sections, showSection } = await import(
  "../../ui/lib/sections.js"
);

composeState([initial()]);

function setup(adminVisible = false) {
  resetSections();
  Object.assign(state, initial());
  const entered = [];
  registerSection({ id: "servers", label: "Servers" });
  registerSection({ id: "content", label: "Maps & mods", enter: () => entered.push("content") });
  registerSection({ id: "admin", label: "Admin", visible: () => adminVisible });
  return entered;
}

test("Reveille opens on Servers and the rail lists only visible sections, in order", () => {
  setup();
  assert.equal(activeSection().id, "servers");
  assert.deepEqual(sections().map((section) => section.id), ["servers", "content"]);
  setup(true);
  assert.deepEqual(sections().map((section) => section.id), ["servers", "content", "admin"]);
});

test("showing a section switches to it and runs its enter hook", () => {
  const entered = setup();
  assert.equal(showSection("content"), true);
  assert.equal(state.section, "content");
  assert.equal(activeSection().id, "content");
  assert.deepEqual(entered, ["content"]);
});

test("a hidden or unknown section is refused, and a hidden remembered one falls back to the first", () => {
  setup();
  assert.equal(showSection("admin"), false);
  assert.equal(showSection("nowhere"), false);
  assert.equal(state.section, "servers");
  state.section = "admin";
  assert.equal(activeSection().id, "servers");
});

test("registering one id twice is a boot error, not a second rail button", () => {
  setup();
  assert.throws(() => registerSection({ id: "servers", label: "Again" }), /registered twice/);
});
