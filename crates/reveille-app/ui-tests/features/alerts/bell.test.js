// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";
import { FakeElement, installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";

const document = installDom();
installStorage();
globalThis.window = { innerWidth: 1000, innerHeight: 800, addEventListener() {}, removeEventListener() {} };
document.addEventListener = () => {};
document.removeEventListener = () => {};
const anchor = document.createElement("button");
anchor.getBoundingClientRect = () => ({ right: 900, top: 0, bottom: 30 });
anchor.prepend = (...nodes) => anchor.append(...nodes);
const badge = document.createElement("span");
document.querySelector = (selector) => ({ "#arrival-events-btn": anchor, "#arrival-unread": badge })[selector] ?? null;
const query = FakeElement.prototype.querySelector;
const buttons = (node) => node.children.flatMap((child) => child instanceof FakeElement
  ? [...(child.tagName === "BUTTON" ? [child] : []), ...buttons(child)] : []);
FakeElement.prototype.querySelector = function (selector) {
  if (selector === "button:not([disabled]), select, input") return buttons(this).find((button) => !button.disabled) ?? null;
  return query.call(this, selector);
};
FakeElement.prototype.removeEventListener = function (type, handler) {
  this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== handler));
};
FakeElement.prototype.remove = function () {
  this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
  this.parentNode = null;
};

const { state, update, composeState } = await import("../../../ui/lib/store.js");
const { initial } = await import("../../../ui/features/servers/index.js");
const { bell } = await import("../../../ui/features/alerts/bell.js");
const { recordArrival } = await import("../../../ui/features/alerts/arrival-events.js");
const { closePopover } = await import("../../../ui/lib/popover.js");
composeState([initial()]);
const opened = [];
const feed = bell({ onOpenWatching() {}, onNotificationSettings() {}, onBadge() {} });
feed.mount({ openServer: (target) => opened.push(target) });

function showFeed(game = "allied_assault") {
  closePopover();
  installStorage();
  Object.assign(state, initial(), { game: "allied_assault", joining: false });
  state.install = { playable: ["allied_assault", "spearhead"] };
  opened.length = 0;
  recordArrival({ game, address: "127.0.0.1:12203", hostname: "Bridge", queryPort: 12300 }, 3, 1000);
  feed.toggleArrivals();
  return buttons(document.body).filter((button) => ["Show", "Join"].includes(button.text));
}

test("notification actions disable during foreground refresh and restore without reopening", () => {
  const actions = showFeed();
  update((next) => { next.browse.running = true; });
  for (const action of actions) {
    assert.equal(action.getAttribute("aria-disabled"), "true");
    assert.match(action.title, /refresh/u);
    action.dispatch("click");
  }
  assert.deepEqual(opened, []);
  update((next) => { next.browse.running = false; });
  for (const action of actions) {
    assert.notEqual(action.getAttribute("aria-disabled"), "true");
    action.dispatch("click");
  }
  assert.deepEqual(opened.map((target) => target.join === true), [false, true]);
});

test("background refresh keeps current-game notification actions available", () => {
  const actions = showFeed();
  update((next) => { next.browse.running = true; next.browse.background = true; });
  for (const action of actions) {
    assert.notEqual(action.getAttribute("aria-disabled"), "true");
    action.dispatch("click");
  }
  assert.equal(opened.length, 2);
});

test("another game's notification actions wait for background refresh", () => {
  const actions = showFeed("spearhead");
  update((next) => { next.browse.running = true; next.browse.background = true; });
  for (const action of actions) {
    assert.equal(action.getAttribute("aria-disabled"), "true");
    action.dispatch("click");
  }
  assert.deepEqual(opened, []);
});
