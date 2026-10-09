// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

const { byline, liveText, progressText, stateExplanation, stateNote } = await import(
  "../../../ui/features/content/format.js"
);

test("download progress shares the unit when both sides have it, so it fits a card", () => {
  const mb = 1024 * 1024;
  assert.equal(progressText({ received: 19.7 * mb, total: 31.8 * mb, confirming: false }), "19.7 of 31.8 MB");
  assert.equal(progressText({ received: 512 * 1024, total: 31.8 * mb, confirming: false }), "512 KB of 31.8 MB");
  assert.equal(progressText({ received: 0, total: 1, confirming: true }), "Checking the file…");
});

test("servers running a map are counted with their players, and none says nothing", () => {
  assert.equal(liveText({ servers: 1, players: 6 }), "1 server · 6 players");
  assert.equal(liveText({ servers: 2, players: 1 }), "2 servers · 1 player");
  assert.equal(liveText({ servers: 0, players: 0 }), null);
});

test("the byline names the author and the map name servers show, whichever exist", () => {
  assert.equal(byline({ author: "Dr. Fragg", map_name: "dm/snipertown" }), "by Dr. Fragg · dm/snipertown");
  assert.equal(byline({ author: null, map_name: "dm/snipertown" }), "dm/snipertown");
  assert.equal(byline({ author: null, map_name: null }), "");
});

test("only an entry that can be installed has no note in place of its Install button", () => {
  assert.equal(stateNote("available"), null);
  assert.equal(stateNote("installed"), "✓ Installed");
  assert.equal(stateNote("present"), "In your game folder");
  assert.equal(stateNote("unavailable"), "No download");
});

test("a mod's byline names its kind where a map names its map", () => {
  assert.equal(byline({ kind: "mod", author: "Dizzle813", mod_type: "Avatar", map_name: null }), "by Dizzle813 · Avatar");
});

test("a mod Reveille cannot install points to its notes on moh-db", () => {
  assert.match(stateExplanation("unavailable", "mod"), /single \.pk3.*notes on moh-db/);
  assert.match(stateExplanation("unavailable", "map"), /no file Reveille can install for this map/);
  assert.match(stateExplanation("available"), /Reveille can remove it again/);
});
