// SPDX-License-Identifier: GPL-3.0-only

// `features/content/controller.js`: pages load and append, an answer to a search since replaced is
// dropped, and an install moves an entry to Installed, records why it failed, or ends quietly when
// the player cancelled it. Tabs, mode and Played now ask the right question; Remove takes an entry
// off Installed or keeps why it was refused; Install and join joins only once the map is there.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

installStorage();
const bridge = installTauri();
const { composeState, state } = await import("../../../ui/lib/store.js");
const { initial: contentState } = await import("../../../ui/features/content/index.js");
const { contentController } = await import("../../../ui/features/content/controller.js");
const { preferences } = await import("../../../ui/lib/preferences.js");

composeState([contentState()]);

const controller = contentController();

const item = (id, extra = {}) => ({
  id,
  title: `Map ${id}`,
  map_name: `dm/map${id}`,
  map_key: `dm/map${id}`,
  image_count: 0,
  file: { filename: `map${id}.pk3`, size: 1000 },
  state: "available",
  ...extra,
});
const page = (ids, more = false, number = 0) => ({ entries: ids.map((id) => item(id)), total: 40, page: number, has_more: more });

/** Answers held per command, so a test decides when each one comes back. */
let held = [];
const hold = () => new Promise((resolve, reject) => held.push({ resolve, reject }));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function reset() {
  bridge.reset();
  bridge.results = { installed_content: () => ({ items: [], total_size: 0 }) };
  held = [];
  Object.assign(state, contentState(), {
    install: { root: "C:\\MOHAA" },
    engine: "original",
    game: "allied_assault",
    servers: [],
    browse: { running: false },
  });
}

const calls = (command) => bridge.calls.filter((call) => call.command === command);
const installedEntry = (id, extra = {}) => ({
  id,
  kind: "map",
  title: `Map ${id}`,
  filename: `map${id}.pk3`,
  page_url: null,
  size: 100,
  installed_at: id,
  changed: false,
  ...extra,
});

test("cards are the default layout", () => {
  assert.equal(preferences().contentLayout, "cards");
});

test("the first page loads once per question, selects its first entry, and Show more appends", async () => {
  reset();
  bridge.results.browse_catalogue = ({ page: number }) => (number === 0 ? page([1, 2], true) : page([2, 3], false, 1));
  controller.ensureLoaded();
  controller.ensureLoaded();
  await settle();
  assert.equal(calls("browse_catalogue").length, 1);
  assert.equal(calls("installed_content").length, 1, "the status bar's installed count is read too");
  assert.deepEqual(state.content.items.map((entry) => entry.id), [1, 2]);
  assert.equal(state.content.selected, 1);
  assert.equal(state.content.hasMore, true);

  controller.loadMore();
  await settle();
  assert.deepEqual(state.content.items.map((entry) => entry.id), [1, 2, 3], "a repeated entry is kept once");
  assert.equal(state.content.hasMore, false);
  assert.deepEqual(calls("browse_catalogue").at(-1).args.session, { path: "C:\\MOHAA", engine: "original", game: "allied_assault" });
});

test("a search typed while the last one was loading wins, whichever answer arrives first", async () => {
  reset();
  bridge.results.browse_catalogue = hold;
  controller.search("snip");
  controller.search("sniper");
  held[1].resolve(page([7]));
  await settle();
  held[0].resolve(page([1, 2, 3]));
  await settle();
  assert.deepEqual(state.content.items.map((entry) => entry.id), [7]);
  assert.equal(calls("browse_catalogue").at(-1).args.search, "sniper");
});

test("a page that fails says why, and keeps nothing from the question before", async () => {
  reset();
  bridge.fail("browse_catalogue", "the map catalogue did not answer in time");
  controller.ensureLoaded();
  await settle();
  assert.equal(state.content.error, "the map catalogue did not answer in time");
  assert.deepEqual(state.content.items, []);
  assert.equal(state.content.loading, false);
});

test("an install streams its progress, then marks the entry Installed", async () => {
  reset();
  state.content.items = [item(1)];
  bridge.results.install_catalogue_item = hold;
  const running = controller.install(state.content.items[0]);
  assert.deepEqual(state.content.installs.get(1), { received: 0, total: 1000, confirming: false });
  bridge.send("install_catalogue_item", { phase: "downloading", received: 400, total: 1000 });
  assert.equal(state.content.installs.get(1).received, 400);
  bridge.send("install_catalogue_item", { phase: "confirming" });
  assert.equal(state.content.installs.get(1).confirming, true);
  held[0].resolve({ id: 1, path: "C:\\MOHAA\\main\\map1.pk3", state: "installed" });
  await running;
  assert.equal(state.content.items[0].state, "installed");
  assert.equal(state.content.installs.size, 0);
});

test("a failed install keeps its reason; a cancelled one leaves no error behind", async () => {
  reset();
  state.content.items = [item(1), item(2)];
  bridge.fail("install_catalogue_item", "download size 3 differs from published size 1000");
  await controller.install(state.content.items[0]);
  assert.equal(state.content.failures.get(1), "download size 3 differs from published size 1000");
  assert.equal(state.content.items[0].state, "available");

  bridge.fail("install_catalogue_item", "cancelled");
  await controller.install(state.content.items[1]);
  assert.equal(state.content.failures.has(2), false);
  assert.equal(state.content.installs.size, 0);
});

test("only an available entry can be installed, and only once at a time", async () => {
  reset();
  bridge.results.install_catalogue_item = hold;
  await controller.install(item(1, { state: "present" }));
  await controller.install(item(2, { file: null, state: "unavailable" }));
  const first = controller.install(item(3));
  void controller.install(item(3));
  assert.equal(bridge.calls.filter((call) => call.command === "install_catalogue_item").length, 1);
  controller.cancel(item(3));
  assert.deepEqual(bridge.calls.at(-1), { command: "cancel_catalogue_install", args: { id: 3 } });
  held[0].reject("cancelled");
  await first;
});

test("screenshots are asked for once each and land as data URLs", async () => {
  reset();
  bridge.results.catalogue_image = ({ id, index }) => `data:image/jpeg;base64,${id}-${index}`;
  const entry = item(5, { image_count: 2 });
  controller.requestImage(entry, 0);
  controller.requestImage(entry, 0);
  controller.requestImage(entry, 2);
  await settle();
  assert.equal(bridge.calls.filter((call) => call.command === "catalogue_image").length, 1);
  assert.equal(state.content.images.get("5:0"), "data:image/jpeg;base64,5-0");
});

test("links out open moh-db in the default browser", () => {
  reset();
  controller.openLink("https://www.moh-db.com/maps/4301-snipertown");
  assert.deepEqual(bridge.opened, ["https://www.moh-db.com/maps/4301-snipertown"]);
});

test("Mods browse moh-db's mods, without the maps' mode", async () => {
  reset();
  bridge.results.browse_catalogue = () => page([9]);
  controller.setMode("objective");
  await settle();
  assert.deepEqual(calls("browse_catalogue").at(-1).args.mode, "objective");
  controller.setTab("mods");
  controller.ensureLoaded();
  await settle();
  const asked = calls("browse_catalogue").at(-1).args;
  assert.equal(asked.kind, "mod");
  assert.equal(asked.mode, null);
  assert.equal(state.content.totals.mods, 40);
  assert.equal(state.content.totals.maps, null, "a filtered browse is not the listing's size");
});

test("Played now asks for the maps servers run, then searches and orders them here", async () => {
  reset();
  state.servers = [
    { address: "a:1", server: { current_map: "dm/snipertown", occupancy: { clients_reported: 3 } } },
    { address: "b:1", server: { current_map: "obj/obj_remagen", occupancy: { clients_reported: 9 } } },
  ];
  bridge.results.catalogue_played_now = () => [item(1, { map_key: "dm/snipertown" }), item(2, { map_key: "obj/obj_remagen" })];
  controller.togglePlayedNow();
  await settle();
  assert.deepEqual(calls("catalogue_played_now")[0].args.maps, ["obj/obj_remagen", "dm/snipertown"]);
  assert.equal(calls("catalogue_played_now")[0].args.fresh, false);
  assert.equal(state.content.sort, "played");
  controller.search("snip");
  controller.setMode("deathmatch");
  controller.setSort("name");
  controller.ensureLoaded();
  await settle();
  assert.equal(calls("browse_catalogue").length, 0, "nothing more is asked of moh-db");
  assert.equal(calls("catalogue_played_now").length, 1);
  controller.refresh();
  await settle();
  assert.equal(calls("catalogue_played_now").at(-1).args.fresh, true);
  controller.togglePlayedNow();
  assert.equal(state.content.sort, "popular");
});

test("Remove takes an entry off Installed and makes it installable again", async () => {
  reset();
  bridge.results.installed_content = () => ({ items: [installedEntry(1), installedEntry(2)], total_size: 200 });
  controller.setTab("installed");
  await settle();
  assert.equal(state.content.installed.selected, "map1.pk3");
  state.content.items = [item(1, { state: "installed" })];
  bridge.results.remove_installed_item = ({ filename }) => ({ filename, state: "available" });
  await controller.remove(state.content.installed.items[0]);
  assert.deepEqual(calls("remove_installed_item")[0].args.filename, "map1.pk3");
  assert.deepEqual(state.content.installed.items.map((entry) => entry.id), [2]);
  assert.equal(state.content.installed.totalSize, 100);
  assert.equal(state.content.installed.selected, "map2.pk3");
  assert.equal(state.content.items[0].state, "available");
});

test("a map is removed from Maps by its file, whatever its case, even when a join installed it", async () => {
  reset();
  state.content.installed.items = [installedEntry(0, { filename: "MAP7.pk3" }), installedEntry(0, { filename: "other.pk3" })];
  state.content.items = [item(7, { state: "installed" })];
  bridge.results.remove_installed_item = () => ({ filename: "MAP7.pk3", state: "available" });
  await controller.remove({ filename: "map7.pk3", title: "Map 7" });
  assert.deepEqual(state.content.installed.items.map((entry) => entry.filename), ["other.pk3"]);
  assert.equal(state.content.items[0].state, "available");
});

test("a refused removal keeps the entry and says why", async () => {
  reset();
  state.content.installed.items = [installedEntry(1)];
  bridge.fail("remove_installed_item", "This file changed since Reveille installed it, so Reveille left it in place.");
  await controller.remove(state.content.installed.items[0]);
  assert.equal(state.content.installed.items.length, 1);
  assert.match(state.content.installed.failures.get("map1.pk3"), /left it in place/);
  assert.equal(state.content.installed.removing.size, 0);
});

test("files written by a join are asked about again, on the tab and in Installed", async () => {
  reset();
  bridge.results.browse_catalogue = () => page([1]);
  controller.ensureLoaded();
  await settle();
  assert.equal(calls("browse_catalogue").length, 1);
  controller.forget();
  controller.ensureLoaded();
  await settle();
  assert.equal(calls("browse_catalogue").length, 2);
  assert.equal(calls("installed_content").length, 2);
});

test("Install and join joins once the map is installed, and not when the install fails", async () => {
  reset();
  const joined = [];
  const row = { address: "a:1" };
  bridge.results.install_catalogue_item = ({ id }) => ({ id, path: "map.pk3", state: "installed" });
  await controller.installAndJoin(item(1), row, (target) => joined.push(target.address));
  assert.deepEqual(joined, ["a:1"]);

  await controller.installAndJoin(item(2, { state: "present" }), row, (target) => joined.push(target.address));
  assert.equal(calls("install_catalogue_item").length, 1, "a map the game has joins without installing");
  assert.deepEqual(joined, ["a:1", "a:1"]);

  bridge.fail("install_catalogue_item", "download size 3 differs from published size 1000");
  await controller.installAndJoin(item(3), row, (target) => joined.push(target.address));
  assert.equal(joined.length, 2);
});
