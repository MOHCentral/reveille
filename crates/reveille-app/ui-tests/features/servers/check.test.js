// SPDX-License-Identifier: GPL-3.0-only

// `features/servers/check.js`: asking remembered servers again, one at a time, without one request
// cancelling another and without rendering an answer for a list that has since been replaced.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

installStorage();
const bridge = installTauri();
const { composeState, state, subscribe } = await import("../../../ui/lib/store.js");
const { initial } = await import("../../../ui/features/servers/index.js");
const { checks } = await import("../../../ui/features/servers/check.js");
const { generations } = await import("../../../ui/lib/session.js");
const { toggleFavorite } = await import("../../../ui/lib/bookmarks.js");

composeState([initial()]);
const reselected = [];
const { check, recheck, autoCheckFavorites } = checks({
  onReselect: (address) => reselected.push(address),
});
subscribe(autoCheckFavorites);

function row(address, extra = {}) {
  return {
    address,
    server: {
      hostname: extra.hostname ?? address,
      occupancy: { clients_reported: extra.clients ?? 4, bots_reported: 0 },
      current_map: extra.map ?? "dm/mohdm1",
      map_checksum: 1,
      pr_downloads: null,
      rotation: ["dm/mohdm1"],
      endpoint: { query_port: 12300 },
    },
    compatibility: { state: { state: "compatible" }, current_map: { readiness: "present" } },
  };
}

const entry = (address) => ({ address, queryPort: 12300 });

/** Answers held per address, so a test decides the order in which checks come back. */
let held = new Map();

function reset({ servers = [] } = {}) {
  bridge.calls.length = 0;
  held = new Map();
  bridge.results = {
    check_server: ({ address }) =>
      new Promise((resolve, reject) => held.set(address, { resolve, reject })),
  };
  Object.assign(state, initial());
  state.install = { root: "C:/Games/MOHAA" };
  state.engine = "original";
  state.game = "allied_assault";
  state.joining = false;
  state.preview = { address: "x" };
  state.previewProgress = null;
  state.previewError = null;
  state.choices = new Map();
  state.servers = servers;
  reselected.length = 0;
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const asked = () => bridge.calls.filter(({ command }) => command === "check_server").map(({ args }) => args.address);

// The token counts list generations (a sweep, a game switch), not calls: one per call left a
// favorites batch abandoned mid-way, with its row reading "Checking…" for nobody.
test("one check does not cancel another", async () => {
  reset();
  const batch = check([entry("a:1"), entry("b:1")]);
  await settle();
  const single = check(entry("c:1"));
  await settle();
  held.get("c:1").resolve({ row: row("c:1") });
  await single;
  held.get("a:1").resolve({ row: row("a:1") });
  await settle();
  assert.deepEqual(asked(), ["a:1", "c:1", "b:1"], "the batch carries on after another check");
  held.get("b:1").resolve({ row: row("b:1") });
  await batch;
  assert.deepEqual(state.servers.map((server) => server.address).sort(), ["a:1", "b:1", "c:1"]);
  assert.equal(state.checks.size, 0);
});

test("a check that was asked of a replaced list renders nothing and stops its batch", async () => {
  reset();
  const batch = check([entry("a:1"), entry("b:1")]);
  await settle();
  assert.equal(state.checks.get("a:1").status, "checking");
  generations.check.next();
  held.get("a:1").resolve({ row: row("a:1") });
  await batch;
  assert.deepEqual(state.servers, []);
  assert.deepEqual(asked(), ["a:1"]);
});

test("a check that could not be sent says why and moves on", async () => {
  reset();
  const batch = check([entry("a:1"), entry("b:1")]);
  await settle();
  held.get("a:1").reject("the network is down");
  await settle();
  assert.deepEqual(state.checks.get("a:1"), { status: "failed", error: "the network is down", dropped: null });
  held.get("b:1").resolve({ row: null, non_result: { stage: "status", reason: "timeout" } });
  await batch;
  assert.equal(state.checks.get("b:1").status, "absent");
});

test("a check of the selected server re-asks the pane only when the join question changed", async () => {
  reset({ servers: [row("a:1")] });
  state.selected = "a:1";
  let done = check(entry("a:1"));
  await settle();
  held.get("a:1").resolve({ row: row("a:1", { clients: 9 }) });
  await done;
  assert.deepEqual(reselected, [], "a moved client count keeps the pane's answer");
  assert.deepEqual(state.preview, { address: "x" });

  done = check(entry("a:1"));
  await settle();
  held.get("a:1").resolve({ row: row("a:1", { map: "obj/obj_team1" }) });
  await done;
  assert.deepEqual(reselected, ["a:1"]);
});

test("a check that drops the selected server clears the pane's stale answer", async () => {
  reset({ servers: [row("a:1")] });
  state.selected = "a:1";
  const done = check(entry("a:1"));
  await settle();
  held.get("a:1").resolve({ row: null, non_result: { stage: "status", reason: "timeout" } });
  await done;
  assert.equal(state.preview, null);
  assert.equal(state.selected, "a:1", "the selection stays where the player put it");
  assert.deepEqual(reselected, []);
});

test("a row is not re-asked during a sweep", () => {
  reset({ servers: [row("a:1")] });
  state.browse.running = true;
  recheck(row("a:1"));
  assert.deepEqual(asked(), []);
  state.browse.running = false;
  recheck(row("a:1"));
  assert.deepEqual(asked(), ["a:1"]);
});

test("favorites the sweep missed are checked once, and only while their block is open", async () => {
  reset({ servers: [row("a:1")] });
  toggleFavorite({ address: "a:1", hostname: "A", queryPort: 12300, game: "allied_assault" });
  toggleFavorite({ address: "gone:1", hostname: "Gone", queryPort: 12300, game: "allied_assault" });
  state.scope = "favorites";
  state.browse.completedAt = "12:00";
  autoCheckFavorites();
  assert.deepEqual(asked(), [], "a shut block asks nothing");

  state.showAbsent = true;
  autoCheckFavorites();
  await settle();
  assert.deepEqual(asked(), ["gone:1"], "only the favorite the sweep did not return");
  autoCheckFavorites();
  assert.deepEqual(asked(), ["gone:1"], "once per sweep");
});
