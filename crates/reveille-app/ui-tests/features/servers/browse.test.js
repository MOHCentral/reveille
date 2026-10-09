// SPDX-License-Identifier: GPL-3.0-only

// `features/servers/browse.js`: a sweep answers one session's question, retires the checks asked of
// the list it replaces, and falls back to that list only when it was this session's own.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

installStorage();
const bridge = installTauri();
const { composeState, state } = await import("../../../ui/lib/store.js");
const { initial } = await import("../../../ui/features/servers/index.js");
const { browse } = await import("../../../ui/features/servers/browse.js");
const { generations } = await import("../../../ui/lib/session.js");

composeState([initial()]);
const reselected = [];
const sweep = browse({ onReselect: (address) => reselected.push(address) });

const INSTALL = { root: "C:/Games/MOHAA" };

function row(address, extra = {}) {
  return {
    address,
    server: {
      hostname: address,
      occupancy: { clients_reported: extra.clients ?? 4, bots_reported: 0 },
      current_map: extra.map ?? "dm/mohdm1",
      endpoint: { query_port: 12300 },
    },
    compatibility: { state: { state: "compatible" } },
  };
}

function payload(servers, extra = {}) {
  return { servers, summary: { servers: servers.length }, non_results: [], cancelled: false, ...extra };
}

/** A fresh window on `game`, with `servers` already on screen as that session's own list. */
function reset({ servers = [], sweptFor = null } = {}) {
  bridge.results = {};
  bridge.calls.length = 0;
  Object.assign(state, initial());
  state.install = INSTALL;
  state.engine = "original";
  state.game = "allied_assault";
  state.preview = null;
  state.joinResult = null;
  state.servers = servers;
  state.listSession = sweptFor;
  state.browse.completedAt = servers.length ? "11:58" : null;
  state.browse.finishedAt = servers.length ? "2026-10-05T11:58:00.000Z" : null;
  reselected.length = 0;
  state.joining = false;
}

/** Make the next sweep wait until the test settles it. */
function holdSweep() {
  const held = {};
  bridge.results.browse_servers = () =>
    new Promise((resolve, reject) => Object.assign(held, { resolve, reject }));
  return held;
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const thisSession = () => ({ path: INSTALL.root, engine: "original", game: "allied_assault" });

test("a sweep records the session its rows were swept for before any row arrives", async () => {
  reset();
  const held = holdSweep();
  const done = sweep.refresh();
  assert.deepEqual(state.listSession, thisSession());
  assert.equal(bridge.calls.at(-1).command, "browse_servers");
  assert.deepEqual(bridge.calls.at(-1).args.session, thisSession());
  held.reject({ kind: "offline", detail: "no route" });
  await done;
  assert.deepEqual(state.listSession, thisSession(), "a failed sweep still says what it asked");
});

test("only a foreground sweep retires checks still in flight", async () => {
  reset();
  const asked = generations.check.current();
  bridge.results.browse_servers = payload([]);
  await sweep.refresh();
  assert.equal(generations.check.isCurrent(asked), false);

  const behind = generations.check.current();
  bridge.results.browse_servers = payload([]);
  await sweep.refreshBehind();
  assert.equal(generations.check.isCurrent(behind), true, "a background sweep keeps individual checks valid");
});

test("a fresh single-server check survives background refresh completion", async () => {
  const { checks } = await import("../../../ui/features/servers/check.js");
  const address = "10.0.0.1:12203";
  reset({ servers: [row(address)], sweptFor: thisSession() });
  state.selected = address;
  const held = holdSweep();
  const done = sweep.refreshBehind();
  assert.equal(bridge.calls.find(({ command }) => command === "browse_servers").args.background, true);
  const fresh = row(address, { clients: 9, map: "obj/obj_team1" });
  bridge.results.check_server = { row: fresh };
  await checks({ onReselect: () => {} }).check({ address, queryPort: 12300 });
  held.resolve(payload([row(address, { clients: 2 })]));
  await done;
  assert.equal(state.servers[0], fresh);
  assert.equal(state.checkedAt.has(address), true);
  assert.deepEqual(reselected, []);
});

test("background refresh cannot drop or reprice the server being joined", async () => {
  const address = "10.0.0.1:12203";
  const joining = row(address);
  reset({ servers: [joining], sweptFor: thisSession() });
  state.selected = address;
  state.joining = true;
  const preview = state.preview = { address };
  const held = holdSweep();
  const done = sweep.refreshBehind();
  held.resolve(payload([]));
  await done;
  assert.equal(state.servers[0], joining);
  assert.equal(state.selected, address);
  assert.equal(state.preview, preview);
  assert.deepEqual(reselected, []);
  state.joining = false;
});

test("background refresh cannot restore a server a direct check found absent", async () => {
  const { checks } = await import("../../../ui/features/servers/check.js");
  const address = "10.0.0.1:12203";
  reset({ servers: [row(address)], sweptFor: thisSession() });
  const held = holdSweep();
  const done = sweep.refreshBehind();
  bridge.results.check_server = { row: null, non_result: { reason: "timeout" } };
  await checks({ onReselect: () => {} }).check({ address, queryPort: 12300 });
  held.resolve(payload([row(address)]));
  await done;
  assert.deepEqual(state.servers, []);
  assert.equal(state.checks.get(address).status, "absent");
});

test("a check begun before background refresh can finish after the sweep", async () => {
  const { checks } = await import("../../../ui/features/servers/check.js");
  const address = "10.0.0.1:12203";
  reset({ servers: [row(address)], sweptFor: thisSession() });
  let answer;
  bridge.results.check_server = () => new Promise((resolve) => { answer = resolve; });
  const checked = checks({ onReselect: () => {} }).check({ address, queryPort: 12300 });
  const held = holdSweep();
  const done = sweep.refreshBehind();
  held.resolve(payload([row(address)]));
  await done;
  assert.equal(state.checks.get(address).status, "checking");
  const fresh = row(address, { clients: 9 });
  answer({ row: fresh });
  await checked;
  assert.equal(state.servers[0], fresh);
});

test("a check that could not run does not override successful background readings", async () => {
  const { checks } = await import("../../../ui/features/servers/check.js");
  const address = "10.0.0.1:12203";
  reset({ servers: [row(address)], sweptFor: thisSession() });
  const held = holdSweep();
  const done = sweep.refreshBehind();
  bridge.fail("check_server", "cannot read installation");
  await checks({ onReselect: () => {} }).check({ address, queryPort: 12300 });
  const fresh = row(address, { clients: 7 });
  held.resolve(payload([fresh]));
  await done;
  assert.equal(state.servers[0], fresh);
  assert.equal(state.checks.has(address), false);
});

test("a failed sweep keeps this session's rows, marked with when they were measured", async () => {
  const kept = [row("10.0.0.1:12203")];
  reset({ servers: kept, sweptFor: thisSession() });
  bridge.fail("browse_servers", { kind: "offline", detail: "no route" });
  await sweep.refresh();
  assert.equal(state.servers, kept);
  assert.equal(state.staleAt, "11:58");
  assert.equal(state.browse.completedAt, "11:58");
  assert.equal(state.browse.finishedAt, "2026-10-05T11:58:00.000Z");
  assert.equal(state.browse.error.kind, "offline");
});

test("a failed sweep never keeps another session's rows as a stale answer", async () => {
  reset({ servers: [row("10.0.0.1:12203")], sweptFor: { ...thisSession(), game: "spearhead" } });
  bridge.fail("browse_servers", { kind: "offline", detail: "no route" });
  await sweep.refresh();
  assert.deepEqual(state.servers, []);
  assert.equal(state.staleAt, null);
});

test("rows that streamed in before a failure stand as the sweep's own", async () => {
  reset({ servers: [row("10.0.0.1:12203")], sweptFor: thisSession() });
  const held = holdSweep();
  const done = sweep.refresh();
  bridge.send("browse_servers", { registered: 3, inspected: 1, probed: 1, answered: 1, non_results: 0, row: row("10.0.0.2:12203") });
  held.reject({ kind: "offline", detail: "no route" });
  await done;
  assert.deepEqual(state.servers.map((entry) => entry.address), ["10.0.0.2:12203"]);
  assert.equal(state.staleAt, null);
});

test("a sweep behind the list keeps its rows on screen until it finishes", async () => {
  const before = [row("10.0.0.1:12203", { map: "dm/mohdm1" })];
  reset({ servers: before, sweptFor: thisSession() });
  state.selected = "10.0.0.1:12203";
  const held = holdSweep();
  const done = sweep.refreshBehind();
  bridge.send("browse_servers", { registered: 3, inspected: 1, probed: 1, answered: 1, non_results: 0, row: row("10.0.0.2:12203") });
  assert.equal(state.servers, before, "streamed rows do not replace what the player is reading");
  assert.equal(state.browse.probed, 1);
  held.resolve(payload([row("10.0.0.1:12203", { map: "obj/obj_team1" })]));
  await done;
  assert.equal(state.servers[0].server.current_map, "obj/obj_team1");
  assert.deepEqual(reselected, ["10.0.0.1:12203"], "the pane re-asks when the selected map changed");
});

test("progress that arrives after its sweep settled changes nothing", async () => {
  reset();
  const held = holdSweep();
  const done = sweep.refresh();
  held.resolve(payload([row("10.0.0.1:12203")]));
  await done;
  bridge.send("browse_servers", { registered: 9, inspected: 9, probed: 9, answered: 9, non_results: 0, row: row("10.0.0.9:12203") });
  assert.deepEqual(state.servers.map((entry) => entry.address), ["10.0.0.1:12203"]);
  assert.equal(state.browse.probed, 0);
});

test("stopping asks the sweep to cancel, and finished() resolves once it has", async () => {
  reset();
  const held = holdSweep();
  const done = sweep.refresh();
  let over = false;
  const waiting = sweep.finished().then(() => (over = true));
  sweep.stop();
  assert.equal(state.browse.stopping, true);
  assert.equal(bridge.calls.at(-1).command, "cancel_browse");
  await settle();
  assert.equal(over, false, "still draining");
  held.resolve(payload([], { cancelled: true }));
  await done;
  await waiting;
  assert.equal(state.browse.cancelled, true);
});
