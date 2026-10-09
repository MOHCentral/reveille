// SPDX-License-Identifier: GPL-3.0-only

// `features/admin/controller.js`: the list loads and keeps a selection that still exists, a status
// failure keeps the last answer beside it, an action is echoed in words and refused while the same
// one is in flight, and only actions that change the server ask for its status again.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

installStorage();
const bridge = installTauri();
const { composeState, state } = await import("../../../ui/lib/store.js");
const { initial: adminState, hasAdminServers } = await import("../../../ui/features/admin/index.js");
const { adminController, busyKey, echo, failureOf } = await import("../../../ui/features/admin/controller.js");

composeState([adminState()]);

const FIRST = "203.0.113.4:12203";
const SECOND = "203.0.113.9:12203";
const PLAYERS = [
  { slot: 0, name: "Hawk", score: 4, ping: 50 },
  { slot: 3, name: "Goat", score: 1, ping: null },
];
const status = (players = PLAYERS) => ({ name: "Stock", map: "dm/mohdm6", players, rotation: [], engine: "open_mohaa" });
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const commands = () => bridge.calls.map((call) => call.command);

function reset(servers = [{ address: FIRST, name: "Stock" }]) {
  bridge.reset();
  bridge.results = {
    admin_servers: () => ({ servers, vault: "credential_manager" }),
    admin_status: () => status(),
    admin_action: () => "",
  };
  Object.assign(state, adminState());
}

test("loading the list selects the first server and shows the Admin section", async () => {
  reset();
  assert.equal(hasAdminServers(), false);
  await adminController().load();
  assert.equal(state.admin.selected, FIRST);
  assert.equal(state.admin.vault, "credential_manager");
  assert.equal(hasAdminServers(), true);
});

test("a selection that left the list moves to the first server that is still there", async () => {
  reset([{ address: SECOND, name: "Clan" }]);
  state.admin.selected = FIRST;
  state.admin.player = 3;
  await adminController().load();
  assert.equal(state.admin.selected, SECOND);
  assert.equal(state.admin.player, null);
});

test("a failed status keeps the last answer on screen with the failure beside it", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  await controller.refresh();
  bridge.fail("admin_status", { reason: "no_answer", message: "The server did not answer." });
  await controller.refresh();
  const entry = state.admin.statuses.get(FIRST);
  assert.deepEqual(entry.status.players, PLAYERS);
  assert.deepEqual(entry.failure, { reason: "no_answer", message: "The server did not answer." });
  assert.equal(entry.loading, false);
});

test("a selected player who left the server is no longer selected", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  controller.selectPlayer(3);
  bridge.results.admin_status = () => status(PLAYERS.slice(0, 1));
  await controller.refresh();
  assert.equal(state.admin.player, null);
});

test("an action is echoed in words, its output logged, and the status asked again", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  await controller.refresh();
  bridge.calls.length = 0;
  bridge.results.admin_action = () => "Hawk was kicked\n";
  assert.equal(await controller.act({ kind: "kick", slot: 0 }), true);
  await settle();
  assert.deepEqual(state.admin.consoles.get(FIRST), [
    { kind: "in", text: "kick Hawk" },
    { kind: "out", text: "Hawk was kicked" },
  ]);
  assert.deepEqual(commands(), ["admin_action", "admin_status"]);
  assert.deepEqual(bridge.calls[0].args, { address: FIRST, action: { kind: "kick", slot: 0 } });
});

test("a message to everyone leaves the status as it was", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  bridge.calls.length = 0;
  await controller.act({ kind: "say", text: "gg" });
  await settle();
  assert.deepEqual(commands(), ["admin_action"]);
});

test("a refused action is logged as an error and reported as not taken", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  bridge.fail("admin_action", { reason: "invalid", message: "Map names use letters, digits and / only." });
  assert.equal(await controller.act({ kind: "change_map", map: "dm/x" }), false);
  assert.deepEqual(state.admin.consoles.get(FIRST).at(-1), { kind: "error", text: "Map names use letters, digits and / only." });
  assert.equal(state.admin.busy.size, 0);
});

test("the same action on the same player is not sent twice while the first is in flight", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  let release;
  bridge.results.admin_action = () => new Promise((resolve) => (release = resolve));
  const first = controller.act({ kind: "kick", slot: 0 });
  assert.equal(await controller.act({ kind: "kick", slot: 0 }), false);
  release("");
  assert.equal(await first, true);
  assert.equal(bridge.calls.filter((call) => call.command === "admin_action").length, 1);
});

test("adding a server selects it and the password goes only to the add command", async () => {
  reset([]);
  const controller = adminController();
  bridge.results.add_admin_server = () => ({ address: SECOND, name: "Clan" });
  bridge.results.admin_servers = () => ({ servers: [{ address: SECOND, name: "Clan" }], vault: "credential_manager" });
  await controller.add("clan.example:12203", "s3cret");
  await settle();
  assert.equal(state.admin.selected, SECOND);
  const carrying = bridge.calls.filter((call) => JSON.stringify(call.args ?? {}).includes("s3cret"));
  assert.deepEqual(carrying.map((call) => call.command), ["add_admin_server"]);
  assert.equal(JSON.stringify([...state.admin.statuses, state.admin.servers]).includes("s3cret"), false);
});

test("removing a server forgets its status and console", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  await controller.act({ kind: "say", text: "bye" });
  bridge.results.admin_servers = () => ({ servers: [], vault: "credential_manager" });
  await controller.remove(FIRST);
  assert.equal(state.admin.consoles.has(FIRST), false);
  assert.equal(state.admin.statuses.has(FIRST), false);
  assert.equal(state.admin.selected, null);
  assert.equal(hasAdminServers(), false);
});

test("watching asks once now and stops when Admin is left", async () => {
  reset();
  const controller = adminController();
  await controller.load();
  bridge.calls.length = 0;
  controller.watch(true);
  controller.watch(true);
  controller.watch(false);
  await settle();
  assert.deepEqual(commands(), ["admin_status"]);
});

test("the echo names the player, never a slot number, when the player is known", () => {
  assert.equal(echo({ kind: "ban", slot: 3 }, PLAYERS), "ban Goat");
  assert.equal(echo({ kind: "message", slot: 0, text: "hi" }, PLAYERS), "message Hawk: hi");
  assert.equal(echo({ kind: "kick", slot: 9 }, PLAYERS), "kick player 9");
  assert.equal(echo({ kind: "set_rotation", maps: ["dm/a", "dm/b"] }), "rotation dm/a dm/b");
  assert.equal(echo({ kind: "console", line: "status" }), "status");
});

test("busy keys tell players apart but not two messages to everyone", () => {
  assert.notEqual(busyKey(FIRST, { kind: "kick", slot: 0 }), busyKey(FIRST, { kind: "kick", slot: 3 }));
  assert.equal(busyKey(FIRST, { kind: "say", text: "a" }), busyKey(FIRST, { kind: "say", text: "b" }));
});

test("a failure Rust did not classify reads as no answer", () => {
  assert.deepEqual(failureOf({ reason: "bad_password", message: "No." }), { reason: "bad_password", message: "No." });
  assert.equal(failureOf(new Error("socket closed")).reason, "no_answer");
});
