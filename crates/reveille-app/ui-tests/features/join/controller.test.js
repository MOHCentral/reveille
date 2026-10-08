// SPDX-License-Identifier: GPL-3.0-only

// `features/join/controller.js`: a selection prices its join once it holds still, an answer for a
// selection or session since left is dropped, and a join that needs downloads stops for consent.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

installStorage();
const bridge = installTauri();
const { composeState, state } = await import("../../../ui/lib/store.js");
const { initial: serversState } = await import("../../../ui/features/servers/index.js");
const { initial: joinState } = await import("../../../ui/features/join/index.js");
const { PREVIEW_SETTLE_MS, joinController } = await import("../../../ui/features/join/controller.js");
const { history } = await import("../../../ui/lib/bookmarks.js");
const { retireInFlight } = await import("../../../ui/lib/session.js");

composeState([serversState(), joinState()]);

const shown = [];
const focused = [];
let filesChanged = 0;
const pane = joinController({
  showPane: () => shown.push(true),
  focusJoin: (address) => focused.push(address),
  onFilesChanged: () => filesChanged++,
});

const INSTALL = "reveille://install";

function row(address, verdict = "needs_maps") {
  return {
    address,
    server: {
      hostname: address,
      occupancy: { clients_reported: 4, bots_reported: 0 },
      current_map: "dm/mohdm1",
      endpoint: { query_port: 12300 },
    },
    compatibility: { state: { state: verdict, count: 1 } },
  };
}

function launched(extra = {}) {
  return { outcome: { launch: "launched" }, assessment: null, failures: [], ...extra };
}

/** Answers held per command, so a test decides when each one comes back. */
let held = new Map();
const hold = (command) => () =>
  new Promise((resolve, reject) => held.set(command, { resolve, reject }));

function reset(servers = [row("a:1"), row("b:1"), row("ready:1", "compatible")]) {
  mock.timers.reset();
  mock.timers.enable({ apis: ["setTimeout"] });
  bridge.calls.length = 0;
  bridge.results = {};
  held = new Map();
  Object.assign(state, serversState(), joinState());
  state.install = { root: "C:/Games/MOHAA" };
  state.engine = "original";
  state.game = "allied_assault";
  state.servers = servers;
  shown.length = 0;
  focused.length = 0;
  localStorage.clear();
}

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

const asked = (command) =>
  bridge.calls.filter((call) => call.command === command).map(({ args }) => args.address);

test("arrowing through rows prices only the one the selection settles on", async () => {
  reset();
  pane.select("a:1");
  mock.timers.tick(PREVIEW_SETTLE_MS - 1);
  pane.select("b:1");
  assert.deepEqual(state.previewProgress, { index: -1, of: 0, map: "" }, "the meter goes up at once");
  mock.timers.tick(PREVIEW_SETTLE_MS);
  await settle();
  assert.deepEqual(asked("preview_join"), ["b:1"]);
});

test("a server with nothing to fetch is not priced", async () => {
  reset();
  pane.select("ready:1");
  mock.timers.tick(PREVIEW_SETTLE_MS);
  await settle();
  assert.deepEqual(asked("preview_join"), []);
  assert.equal(state.previewProgress, null);
});

test("selecting clears what the pane said about the previous server", () => {
  reset();
  state.preview = { address: "a:1" };
  state.previewError = "offline";
  state.choices = new Map([["dm/mohdm1", 7]]);
  state.joinResult = { address: "a:1" };
  state.joinError = "refused";
  pane.select("ready:1");
  assert.equal(state.selected, "ready:1");
  assert.equal(state.preview, null);
  assert.equal(state.previewError, null);
  assert.equal(state.choices.size, 0);
  assert.equal(state.joinResult, null);
  assert.equal(state.joinError, null);
});

test("a preview answer for a selection since left is dropped", async () => {
  reset();
  bridge.results.preview_join = hold("preview_join");
  pane.select("a:1");
  mock.timers.tick(PREVIEW_SETTLE_MS);
  await settle();
  pane.select("ready:1");
  held.get("preview_join").resolve({ address: "a:1" });
  await settle();
  assert.equal(state.preview, null);
});

test("a preview that fails says why and takes the meter down", async () => {
  reset();
  bridge.fail("preview_join", { kind: "offline", detail: "no route" });
  pane.select("a:1");
  mock.timers.tick(PREVIEW_SETTLE_MS);
  await settle();
  assert.equal(state.previewProgress, null);
  assert.equal(typeof state.previewError, "string");
});

test("preview progress from a selection since left leaves the meter alone", async () => {
  reset();
  bridge.results.preview_join = hold("preview_join");
  pane.select("a:1");
  mock.timers.tick(PREVIEW_SETTLE_MS);
  await settle();
  bridge.send("preview_join", { address: "a:1", index: 0, of: 2, map: "dm/mohdm1" });
  assert.equal(state.previewProgress.index, 0);
  pane.select("b:1");
  bridge.send("preview_join", { address: "a:1", index: 1, of: 2, map: "dm/mohdm2" });
  assert.deepEqual(state.previewProgress, { index: -1, of: 0, map: "" });
});

test("the preview priced after server files land moves the meter until the selection changes", async () => {
  reset();
  pane.select("a:1");
  bridge.results.install_server_files = hold("install_server_files");
  const done = pane.getServerFiles(row("a:1"));
  bridge.send("install_server_files", { address: "a:1", index: 0, of: 2, map: "dm/mohdm1" });
  assert.equal(state.previewProgress.index, 0);
  pane.select("b:1");
  bridge.send("install_server_files", { address: "a:1", index: 1, of: 2, map: "dm/mohdm2" });
  assert.deepEqual(state.previewProgress, { index: -1, of: 0, map: "" });
  held.get("install_server_files").resolve({ preview: null, failures: [] });
  await done;
});

test("activating a ready server joins at once", async () => {
  reset();
  bridge.results.install_and_launch = launched();
  pane.activate("ready:1");
  await settle();
  assert.deepEqual(asked("install_and_launch"), ["ready:1"]);
  assert.deepEqual(focused, []);
});

test("activating a server that needs downloads stops on the Join button, opening a hidden pane", async () => {
  reset();
  state.detailCollapsed = true;
  pane.activate("a:1");
  await settle();
  assert.deepEqual(asked("install_and_launch"), []);
  assert.deepEqual(shown, [true]);
  assert.deepEqual(focused, ["a:1"]);
});

test("activating a ready server that is being checked waits for the player", async () => {
  reset();
  state.checks.set("ready:1", { status: "checking" });
  pane.activate("ready:1");
  await settle();
  assert.deepEqual(asked("install_and_launch"), []);
  assert.deepEqual(focused, ["ready:1"]);
});

test("a join sends the player's source choices and holds the pane until it ends", async () => {
  reset();
  bridge.results.install_and_launch = hold("install_and_launch");
  state.choices = new Map([["obj/obj_team2", 41]]);
  const done = pane.getAndJoin(row("a:1"), true);
  assert.equal(state.joining, true);
  const call = bridge.calls.find(({ command }) => command === "install_and_launch");
  assert.deepEqual(call.args.selectedCandidateIds, [41]);
  assert.equal(call.args.acceptIncomplete, true);
  held.get("install_and_launch").resolve(launched());
  await done;
  assert.equal(state.joining, false);
  assert.equal(state.joinResult.address, "a:1");
});

test("a launch is remembered even when its result arrives after a game switch", async () => {
  reset();
  bridge.results.install_and_launch = hold("install_and_launch");
  const done = pane.getAndJoin(row("a:1"), false);
  retireInFlight();
  state.joining = false;
  held.get("install_and_launch").resolve(launched());
  await done;
  assert.deepEqual(history().map((entry) => entry.address), ["a:1"]);
  assert.equal(state.joinResult, null, "the result is not rendered into the new session");
});

test("a join that installed maps says the game folder changed, and one that installed none does not", async () => {
  reset();
  filesChanged = 0;
  bridge.results.install_and_launch = launched({ installed: [] });
  await pane.getAndJoin(row("a:1"), false);
  assert.equal(filesChanged, 0);
  bridge.results.install_and_launch = launched({ installed: ["C:\\MOHAA\\main\\map.pk3"] });
  await pane.getAndJoin(row("a:1"), false);
  assert.equal(filesChanged, 1);
});

test("a refused join is not remembered", async () => {
  reset();
  bridge.results.install_and_launch = launched({ outcome: { launch: "refused" } });
  await pane.getAndJoin(row("a:1"), false);
  assert.deepEqual(history(), []);
});

test("a second join supersedes the first one's outcome", async () => {
  reset();
  bridge.results.install_and_launch = hold("install_and_launch");
  const first = pane.getAndJoin(row("a:1"), false);
  const firstHeld = held.get("install_and_launch");
  const second = pane.getAndJoin(row("b:1"), false);
  firstHeld.reject({ kind: "launch", detail: "stale" });
  await first;
  assert.equal(state.joinError, null);
  held.get("install_and_launch").resolve(launched());
  await second;
  assert.equal(state.joinResult.address, "b:1");
});

test("fetching server files reports each map that failed and adopts the new preview", async () => {
  reset();
  bridge.results.install_server_files = {
    preview: { address: "a:1" },
    failures: [
      { map: "dm/mohdm1", reason: "checksum mismatch." },
      { map: "dm/mohdm2", reason: "timed out." },
    ],
  };
  state.choices = new Map([["dm/mohdm1", 3]]);
  await pane.getServerFiles(row("a:1"));
  assert.equal(state.joining, false);
  assert.equal(state.installRun, null);
  assert.deepEqual(state.preview, { address: "a:1" });
  assert.equal(state.choices.size, 0);
  assert.equal(state.joinError, "dm/mohdm1: checksum mismatch. dm/mohdm2: timed out.");
});

test("install progress gathers per file while a run is open, and is ignored otherwise", async () => {
  reset();
  bridge.emit(INSTALL, { map: "dm/mohdm1", filename: "a.pk3", phase: "downloading", received: 1 });
  assert.equal(state.installRun, null);

  bridge.results.install_server_files = hold("install_server_files");
  const done = pane.getServerFiles(row("a:1"));
  bridge.emit(INSTALL, { map: "dm/mohdm1", filename: "a.pk3", phase: "downloading", received: 10, total: 100 });
  bridge.emit(INSTALL, { map: "dm/mohdm1", filename: "a.pk3", phase: "installed" });
  assert.deepEqual(state.installRun.items.get("a.pk3"), {
    map: "dm/mohdm1",
    filename: "a.pk3",
    phase: "installed",
    received: 10,
    total: 100,
    reason: undefined,
  });
  held.get("install_server_files").resolve({ preview: null, failures: [] });
  await done;
});
