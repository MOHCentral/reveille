// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../../fakes/dom.js";

installDom();
const { mapPicker } = await import("../../../ui/features/admin/map-picker.js");

const key = (input, value) => input.dispatch("keydown", { key: value, preventDefault() {}, stopPropagation() {} });
function setup() {
  let changed = 0;
  const picker = mapPicker({ onSubmit: () => changed++ });
  picker.update({ maps: ["dm/mohdm2", "dm/mohdm6", "dm/mohdm2"], current: "m1l1" });
  const list = picker.root.children[1];
  return { picker, list, changed: () => changed };
}

test("opening lists unique rotation maps first and labels the current map", () => {
  const { picker, list } = setup();
  picker.input.dispatch("focus");
  assert.deepEqual(list.children.map((row) => row.text), ["dm/mohdm2", "dm/mohdm6", "m1l1Current"]);
  assert.equal(picker.input.getAttribute("aria-expanded"), "true");
});

test("typing filters without changing the free-form map name", () => {
  const { picker, list, changed } = setup();
  picker.input.value = "MOHDM6";
  picker.input.dispatch("input");
  assert.deepEqual(list.children.map((row) => row.text), ["dm/mohdm6"]);
  assert.equal(picker.input.value, "MOHDM6");
  picker.input.value = "custom/my-map";
  picker.input.dispatch("input");
  key(picker.input, "Enter");
  assert.equal(picker.input.value, "custom/my-map");
  assert.equal(changed(), 1);
});

test("arrows and Enter select a suggestion without submitting a map change", () => {
  const { picker, list, changed } = setup();
  key(picker.input, "ArrowDown");
  key(picker.input, "ArrowDown");
  assert.equal(list.children[1].getAttribute("aria-selected"), "true");
  key(picker.input, "Enter");
  assert.equal(picker.input.value, "dm/mohdm6");
  assert.equal(changed(), 0);
  assert.equal(picker.input.getAttribute("aria-expanded"), "false");
  key(picker.input, "Enter");
  assert.equal(changed(), 1);
});

test("Escape and blur close suggestions while preserving typed text", () => {
  const { picker } = setup();
  picker.input.value = "custom/map";
  picker.input.dispatch("focus");
  key(picker.input, "Escape");
  assert.equal(picker.input.getAttribute("aria-expanded"), "false");
  assert.equal(picker.input.value, "custom/map");
  picker.input.dispatch("focus");
  picker.input.dispatch("blur");
  assert.equal(picker.input.getAttribute("aria-expanded"), "false");
});

test("clicking a suggestion selects it and server changes close stale suggestions", () => {
  const { picker, list, changed } = setup();
  picker.input.dispatch("focus");
  list.children[0].dispatch("click");
  assert.equal(picker.input.value, "dm/mohdm2");
  assert.equal(changed(), 0);
  picker.input.dispatch("focus");
  picker.update({ maps: ["obj/obj_team1"], current: "", reset: true });
  assert.equal(picker.input.getAttribute("aria-expanded"), "false");
  picker.input.dispatch("focus");
  assert.deepEqual(list.children.map((row) => row.text), ["obj/obj_team1"]);
});
