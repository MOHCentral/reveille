// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";

installDom();
installStorage();
const { composeState, state } = await import("../../../ui/lib/store.js");
const { initial } = await import("../../../ui/features/admin/state.js");
const { consoleView } = await import("../../../ui/features/admin/console-view.js");
composeState([initial()]);

const FIRST = "203.0.113.4:12203";
const SECOND = "203.0.113.9:12203";
const node = (view, key) => view.root.querySelector(`[data-focus-key="${key}"]`);
function setup() {
  Object.assign(state, initial());
  state.admin.servers = [{ address: FIRST, name: "Stock" }, { address: SECOND, name: "Clan" }];
  state.admin.selected = FIRST;
  const actions = [];
  const view = consoleView({ controller: { act: async (action) => { actions.push(action); return true; } } });
  view.render();
  return { view, actions };
}

test("Clear removes only the selected server's output", () => {
  const { view } = setup();
  state.admin.consoles.set(FIRST, [{ kind: "out", text: "first", at: 1000 }]);
  state.admin.consoles.set(SECOND, [{ kind: "out", text: "second", at: 2000 }]);
  view.render();
  node(view, "admin-console-clear").dispatch("click");
  assert.deepEqual(state.admin.consoles.get(FIRST), []);
  assert.equal(state.admin.consoles.get(SECOND)[0].text, "second");
});

test("copy output includes timestamps and strips game colour codes", async (t) => {
  const { view } = setup();
  let copied;
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value) => { copied = value; } } });
  t.after(() => {
    if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
    else delete navigator.clipboard;
  });
  state.admin.consoles.set(FIRST, [{ kind: "in", text: "status", at: 1000 }, { kind: "out", text: "^1Red^7 Base", at: 2000 }]);
  view.render();
  node(view, "admin-console-copy").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(copied, /^\[\d{2}:\d{2}:\d{2}\] > status\n\[\d{2}:\d{2}:\d{2}\] Red Base$/u);
  assert.equal(node(view, "admin-console-copy-result").textContent, "Output copied.");
});

test("new output preserves reading position and follows when already at the bottom", () => {
  const { view } = setup();
  const log = node(view, "admin-console-log");
  // Synthetic geometry checks the follow decision, not browser layout.
  log.scrollHeight = 1000;
  log.clientHeight = 128;
  log.scrollTop = 200;
  state.admin.consoles.set(FIRST, [{ kind: "out", text: "first", at: 1000 }]);
  view.render();
  assert.equal(log.scrollTop, 200);
  log.scrollTop = 872;
  state.admin.consoles.set(FIRST, [...state.admin.consoles.get(FIRST), { kind: "out", text: "second", at: 2000 }]);
  view.render();
  assert.equal(log.scrollTop, 1000);
});

test("console drafts and command history do not cross servers", async () => {
  const { view, actions } = setup();
  view.input.value = "status";
  view.input.dispatch("input");
  node(view, "admin-console-send").dispatch("click");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(actions, [{ kind: "console", line: "status" }]);
  state.admin.selected = SECOND;
  view.render();
  view.input.dispatch("keydown", { key: "ArrowUp", preventDefault() {} });
  assert.equal(view.input.value, "");
  view.input.value = "sv_maplist";
  view.input.dispatch("input");
  state.admin.selected = FIRST;
  view.render();
  view.input.dispatch("keydown", { key: "ArrowUp", preventDefault() {} });
  assert.equal(view.input.value, "status");
  state.admin.selected = SECOND;
  view.render();
  assert.equal(view.input.value, "sv_maplist");
});

test("without a server console submission is disabled and preserves typed input", () => {
  const { view, actions } = setup();
  state.admin.selected = null;
  view.render();
  assert.equal(view.input.disabled, true);
  assert.equal(node(view, "admin-console-send").disabled, true);
  view.input.value = "status";
  node(view, "admin-console-send").dispatch("click");
  assert.equal(view.input.value, "status");
  assert.deepEqual(actions, []);
});

test("evicting old multiline output preserves the position within retained output", () => {
  const { view } = setup();
  const first = { kind: "out", text: "first", at: 1000 };
  const second = { kind: "out", text: "second\nsecond line", at: 2000 };
  const retained = { kind: "out", text: "retained", at: 3000 };
  state.admin.consoles.set(FIRST, [first, second, retained]);
  view.render();
  const log = node(view, "admin-console-log");
  log.scrollHeight = 1000;
  log.clientHeight = 128;
  log.scrollTop = 200;
  log.children[0].offsetHeight = 20;
  log.children[1].offsetHeight = 40;
  state.admin.consoles.set(FIRST, [retained, { kind: "out", text: "new", at: 4000 }]);
  view.render();
  assert.equal(log.scrollTop, 140);
});
