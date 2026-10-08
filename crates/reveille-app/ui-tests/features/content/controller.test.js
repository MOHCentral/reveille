// SPDX-License-Identifier: GPL-3.0-only

// `features/content/controller.js`: pages load and append, an answer to a search since replaced is
// dropped, and an install moves an entry to Installed, records why it failed, or ends quietly when
// the player cancelled it.

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
  bridge.results = {};
  held = [];
  Object.assign(state, contentState(), {
    install: { root: "C:\\MOHAA" },
    engine: "original",
    game: "allied_assault",
  });
}

test("cards are the default layout", () => {
  assert.equal(preferences().contentLayout, "cards");
});

test("the first page loads once per question, selects its first entry, and Show more appends", async () => {
  reset();
  bridge.results.browse_catalogue = ({ page: number }) => (number === 0 ? page([1, 2], true) : page([2, 3], false, 1));
  controller.ensureLoaded();
  controller.ensureLoaded();
  await settle();
  assert.equal(bridge.calls.filter((call) => call.command === "browse_catalogue").length, 1);
  assert.deepEqual(state.content.items.map((entry) => entry.id), [1, 2]);
  assert.equal(state.content.selected, 1);
  assert.equal(state.content.hasMore, true);

  controller.loadMore();
  await settle();
  assert.deepEqual(state.content.items.map((entry) => entry.id), [1, 2, 3], "a repeated entry is kept once");
  assert.equal(state.content.hasMore, false);
  assert.deepEqual(bridge.calls.at(-1).args.session, { path: "C:\\MOHAA", engine: "original", game: "allied_assault" });
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
  assert.equal(bridge.calls.at(-1).args.search, "sniper");
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
