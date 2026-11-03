// SPDX-License-Identifier: GPL-3.0-only

// `features/servers/address-dialog.js`: finding a server by an address someone shared. The text
// goes to Rust as typed, a failure says why in the dialog, and a found server is handed on once.

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installTauri } from "../../fakes/tauri.js";

const document = installDom();
const dialog = document.createElement("dialog");
const title = document.createElement("h2");
const body = document.createElement("div");
const byId = { "#info-dialog": dialog, "#info-dialog-title": title, "#info-dialog-body": body };
document.querySelector = (selector) => byId[selector] ?? null;
const bridge = installTauri();

const { openFindByAddress } = await import("../../../ui/features/servers/address-dialog.js");
const { openDialog } = await import("../../../ui/lib/dialog.js");

const FOUND = { address: "203.0.113.4:12204", query_port: 12301, game: "spearhead", hostname: "Friday Night" };

const settle = () => new Promise((resolve) => setImmediate(resolve));

function find(node, test) {
  if (test(node)) return node;
  for (const child of node.children ?? []) {
    const found = typeof child === "object" ? find(child, test) : null;
    if (found) return found;
  }
  return null;
}

function open(options = {}) {
  if (dialog.open) dialog.close();
  bridge.reset();
  const found = [];
  openFindByAddress({ onFound: (server) => found.push(server), ...options });
  return {
    found,
    input: find(body, (node) => node.tagName === "INPUT"),
    button: find(body, (node) => node.tagName === "BUTTON"),
    error: find(body, (node) => node.className === "form-error"),
  };
}

test("an empty field asks for an address without asking Rust", () => {
  const { button, error } = open();
  assert.equal(title.textContent, "Find a server by its address");
  button.dispatch("click");
  assert.equal(error.textContent, "Enter the server's address.");
  assert.deepEqual(bridge.calls, []);
});

test("a found server closes the dialog and is handed on", async () => {
  bridge.results.locate_server = FOUND;
  const { input, button, found } = open();
  input.value = "connect 203.0.113.4:12204";
  button.dispatch("click");
  assert.equal(button.disabled, true, "one lookup at a time");
  await settle();
  assert.deepEqual(bridge.calls.map(({ args }) => args.address), ["connect 203.0.113.4:12204"]);
  assert.deepEqual(found, [FOUND]);
  assert.equal(dialog.open, false);
});

test("a paste fills the field and looks straight away", async () => {
  bridge.results.locate_server = FOUND;
  const { input, found } = open({ text: "  203.0.113.4:12204\n" });
  assert.equal(input.value, "203.0.113.4:12204");
  await settle();
  assert.deepEqual(found, [FOUND]);
});

test("a failure says why in the dialog and leaves it open to correct", async () => {
  const { input, button, error, found } = open();
  bridge.fail("locate_server", "Nothing answered at 203.0.113.4:12204.");
  input.value = "203.0.113.4:12204";
  button.dispatch("click");
  await settle();
  assert.equal(error.textContent, "Nothing answered at 203.0.113.4:12204.");
  assert.equal(dialog.open, true);
  assert.equal(button.disabled, false);
  assert.deepEqual(found, []);
  input.dispatch("input");
  assert.equal(error.textContent, "", "editing the address clears the old reason");
});

test("a server found after the dialog was replaced is not handed on", async () => {
  let answer;
  bridge.results.locate_server = () => new Promise((resolve) => { answer = resolve; });
  const { input, button, found } = open();
  input.value = "203.0.113.4";
  button.dispatch("click");
  openDialog("Keyboard shortcuts");
  answer(FOUND);
  await settle();
  assert.deepEqual(found, []);
  assert.equal(title.textContent, "Keyboard shortcuts");
});
