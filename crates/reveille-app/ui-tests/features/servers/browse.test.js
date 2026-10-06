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

const EVENT = "reveille://browse";
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
  assert.deepEqual(bridge.calls.at(-1), { command: "browse_servers", args: { session: thisSession() } });
  held.reject({ kind: "offline", detail: "no route" });
  await done;
  assert.deepEqual(state.listSession, thisSession(), "a failed sweep still says what it asked");
});

test("a sweep retires the checks still in flight against the list it replaces", async () => {
  reset();
  const asked = generations.check.current();
  bridge.results.browse_servers = payload([]);
  await sweep.refresh();
  assert.equal(generations.check.isCurrent(asked), false);

  const behind = generations.check.current();
  bridge.results.browse_servers = payload([]);
  await sweep.refreshBehind();
  assert.equal(generations.check.isCurrent(behind), false, "a sweep behind the list retires them too");
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
  bridge.emit(EVENT, { registered: 3, inspected: 1, probed: 1, answered: 1, non_results: 0, row: row("10.0.0.2:12203") });
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
  bridge.emit(EVENT, { registered: 3, inspected: 1, probed: 1, answered: 1, non_results: 0, row: row("10.0.0.2:12203") });
  assert.equal(state.servers, before, "streamed rows do not replace what the player is reading");
  assert.equal(state.browse.probed, 1);
  held.resolve(payload([row("10.0.0.1:12203", { map: "obj/obj_team1" })]));
  await done;
  assert.equal(state.servers[0].server.current_map, "obj/obj_team1");
  assert.deepEqual(reselected, ["10.0.0.1:12203"], "the pane re-asks when the selected map changed");
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
