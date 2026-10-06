// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";

const document = installDom();
const elements = {
  "#info-dialog": document.createElement("dialog"),
  "#info-dialog-title": document.createElement("h2"),
  "#info-dialog-body": document.createElement("div"),
};
document.querySelector = (selector) => elements[selector] ?? null;

const { openShortcuts, SHORTCUTS } = await import("../../../ui/features/shortcuts/view.js");

test("the sheet opens in the shared dialog with one section per group, in order", () => {
  openShortcuts();
  assert.equal(elements["#info-dialog"].open, true);
  assert.equal(elements["#info-dialog-title"].textContent, "Keyboard shortcuts");
  const [grid] = elements["#info-dialog-body"].children;
  assert.equal(grid.className, "shortcuts-grid");
  assert.deepEqual(
    grid.children.map((section) => section.children[0].text),
    ["Selected server", "Server list", "Window"],
  );
});

test("each key of a chord is its own key cap, followed by what it does", () => {
  openShortcuts();
  const [grid] = elements["#info-dialog-body"].children;
  grid.children.forEach((section, index) => {
    const list = section.children[1];
    const expected = SHORTCUTS[index].keys.flatMap(([combo, action]) => [combo, action]);
    const drawn = list.children.map((node) =>
      node.tagName === "DT" ? node.children.map((key) => key.text) : node.text,
    );
    assert.deepEqual(drawn, expected);
    for (const term of list.children.filter((node) => node.tagName === "DT")) {
      assert.ok(term.children.every((key) => key.tagName === "KBD" && key.className === "kbd"));
    }
  });
});
