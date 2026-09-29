// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../fakes/dom.js";

const document = installDom();
const dialog = Object.assign(document.createElement("dialog"), {
  open: false,
  showModal() { this.open = true; },
  close() { this.open = false; },
});
const parts = {
  "#info-dialog": dialog,
  "#info-dialog-title": document.createElement("h2"),
  "#info-dialog-body": document.createElement("div"),
};
// The shared dialog is looked up by id; the fake models no document-level queries of its own.
document.querySelector = (selector) => parts[selector] ?? null;

const { openTelemetryPrompt } = await import("../../ui/views/telemetry.js");

function button(label) {
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.tagName === "BUTTON" && child.text === label) return child;
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(parts["#info-dialog-body"]);
}

function prompt() {
  const chosen = [];
  let learnedMore = 0;
  openTelemetryPrompt({
    onChoose: (shared) => chosen.push(shared),
    onLearnMore: () => (learnedMore += 1),
  });
  return { chosen, learnedMore: () => learnedMore };
}

test("the question names what is never sent and records nothing until answered", () => {
  const { chosen } = prompt();
  assert.equal(dialog.open, true);
  assert.equal(parts["#info-dialog-title"].textContent, "Help improve Reveille?");
  const text = parts["#info-dialog-body"].text;
  assert.match(text, /player name/u);
  assert.match(text, /CD key/u);
  assert.match(text, /Settings/u);
  assert.deepEqual(chosen, []);
});

test("Share and Don't share each save their own answer and close the question", () => {
  for (const [label, shared] of [["Share", true], ["Don't share", false]]) {
    const { chosen } = prompt();
    button(label).dispatch("click");
    assert.deepEqual(chosen, [shared]);
    assert.equal(dialog.open, false);
  }
});

test("reading what is sent leaves the question open", () => {
  const { chosen, learnedMore } = prompt();
  button("What is sent").dispatch("click");
  assert.equal(learnedMore(), 1);
  assert.equal(dialog.open, true);
  assert.deepEqual(chosen, []);
});
