// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";

installDom();
installStorage();
const { adminView, withoutColours } = await import("../../../ui/features/admin/view.js");
const { composeState, state } = await import("../../../ui/lib/store.js");
const { initial } = await import("../../../ui/features/admin/state.js");
composeState([initial()]);

const status = (rotation, gameType = 2) => ({
  name: "Stock", map: "dm/a", game_type: "Team-Match", game_type_number: gameType,
  capacity: 16, players: [], rotation, engine: "original", can_message: false, can_ban: false,
});

function setup(rotation = ["dm/a", "dm/b", "dm/c", "dm/d", "dm/e", "dm/f"]) {
  Object.assign(state, initial(), { detailCollapsed: false });
  state.admin.servers = [{ address: "203.0.113.4:12203", name: "Stock" }];
  state.admin.selected = "203.0.113.4:12203";
  state.admin.statuses.set(state.admin.selected, { status: status(rotation) });
  const actions = [];
  const page = adminView({ controller: { act: (action) => actions.push(action) }, onToggleDetail() {} });
  page.render();
  return { page, actions };
}

const findClass = (node, name) => {
  if (node.classList?.contains(name)) return node;
  for (const child of node.children ?? []) {
    const found = findClass(child, name);
    if (found) return found;
  }
  return null;
};

test("rotation shows four maps and can expand and collapse the full list", () => {
  const { page } = setup();
  const rotation = findClass(page.detail, "admin-rotation");
  assert.equal(rotation.children.length, 4);
  let toggle = page.detail.querySelector('[data-focus-key="admin-rotation-more"]');
  assert.equal(toggle.text, "Show all 6");
  toggle.dispatch("click");
  assert.equal(rotation.children.length, 6);
  toggle = page.detail.querySelector('[data-focus-key="admin-rotation-more"]');
  assert.equal(toggle.text, "Show fewer");
  toggle.dispatch("click");
  assert.equal(rotation.children.length, 4);
});

test("switching servers collapses the rotation and short rotations have no toggle", () => {
  const { page } = setup();
  page.detail.querySelector('[data-focus-key="admin-rotation-more"]').dispatch("click");
  state.admin.selected = "203.0.113.9:12203";
  state.admin.statuses.set(state.admin.selected, { status: status(["a", "b", "c", "d", "e"]) });
  page.render();
  assert.equal(findClass(page.detail, "admin-rotation").children.length, 4);
  const short = setup(["a", "b", "c", "d"]).page;
  assert.equal(short.detail.querySelector('[data-focus-key="admin-rotation-more"]'), null);
});

test("game type sends the selected numeric mode only when Apply is pressed", () => {
  const { page, actions } = setup();
  const select = page.detail.querySelector('[data-focus-key="admin-game-type"]');
  assert.equal(select.value, "2");
  select.value = "4";
  select.dispatch("change");
  assert.deepEqual(actions, []);
  page.detail.querySelector('[data-focus-key="admin-game-type-apply"]').dispatch("click");
  assert.deepEqual(actions, [{ kind: "set_game_type", game_type: 4 }]);
});

test("status polling preserves the chosen game type until the active mode changes", () => {
  const { page } = setup();
  const select = page.detail.querySelector('[data-focus-key="admin-game-type"]');
  select.value = "4";
  state.admin.statuses.get(state.admin.selected).status.rotation = ["dm/b"];
  page.render();
  assert.equal(select.value, "4");
  state.admin.statuses.get(state.admin.selected).status.game_type_number = 3;
  page.render();
  assert.equal(select.value, "3");
});

test("the console drops the game's colour codes and keeps every other caret", () => {
  assert.equal(withoutColours('"sv_hostname" is:"^1Red^7 Base^7"'), '"sv_hostname" is:"Red Base"');
  assert.equal(withoutColours("2^x stays"), "2^x stays");
});
