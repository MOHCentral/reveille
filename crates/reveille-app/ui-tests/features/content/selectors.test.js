// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

const { installShare, liveSummary, playedMaps, queryKey, runningOn, visibleItems } = await import(
  "../../../ui/features/content/selectors.js"
);

const row = (address, map, players) => ({
  address,
  server: { current_map: map, occupancy: { clients_reported: players } },
});

test("a map is matched to the servers running it with join's normalisation, busiest first", () => {
  const servers = [
    row("a:1", "dm/snipertown", 2),
    row("b:1", "MAPS\\DM\\SniperTown.bsp", 9),
    row("c:1", "dm/snipertown2", 30),
    row("d:1", null, 0),
  ];
  const running = runningOn({ map_key: "dm/snipertown" }, servers);
  assert.deepEqual(running.map((entry) => entry.address), ["b:1", "a:1"]);
  assert.deepEqual(liveSummary(running), { servers: 2, players: 11 });
  assert.deepEqual(runningOn({ map_key: null }, servers), []);
});

test("the rail's download line is bytes received over bytes expected across every install", () => {
  assert.equal(installShare(new Map()), null);
  const installs = new Map([
    [1, { received: 50, total: 100 }],
    [2, { received: 0, total: 300 }],
  ]);
  assert.equal(installShare(installs), 0.125);
});

test("a change of game, tab, search, order or mode is a different question to ask moh-db", () => {
  const session = { path: "C:\\MOHAA", engine: "original", game: "allied_assault" };
  const content = { tab: "maps", query: " snipertown ", sort: "popular", mode: null, playedNow: false };
  const key = queryKey(session, content, []);
  assert.equal(key, queryKey(session, { ...content, query: "snipertown" }, []));
  assert.notEqual(key, queryKey({ ...session, game: "spearhead" }, content, []));
  assert.notEqual(key, queryKey(session, { ...content, sort: "newest" }, []));
  assert.notEqual(key, queryKey(session, { ...content, mode: "objective" }, []));
  assert.notEqual(key, queryKey(session, { ...content, tab: "mods" }, []));
  assert.equal(
    queryKey(session, { ...content, tab: "mods", mode: "objective" }, []),
    queryKey(session, { ...content, tab: "mods" }, []),
    "mods have no mode",
  );
});

test("Played now asks again when the maps being played change, not when the search does", () => {
  const session = { path: "C:\\MOHAA", engine: "original", game: "allied_assault" };
  const content = { tab: "maps", query: "", sort: "played", mode: null, playedNow: true };
  const servers = [row("a:1", "dm/snipertown", 2)];
  const key = queryKey(session, content, servers);
  assert.equal(key, queryKey(session, { ...content, query: "snip", mode: "objective" }, servers));
  assert.notEqual(key, queryKey(session, content, [...servers, row("b:1", "obj/obj_remagen", 1)]));
});

test("the maps being played are listed once each, the most players first", () => {
  const servers = [
    row("a:1", "dm/snipertown", 2),
    row("b:1", "obj/obj_remagen", 5),
    row("c:1", "DM/SniperTown", 4),
    row("d:1", "", 9),
  ];
  assert.deepEqual(playedMaps(servers), ["dm/snipertown", "obj/obj_remagen"]);
});

test("Played now is searched, filtered by mode and ordered by players here", () => {
  const entry = (id, title, key, downloads) => ({ id, title, map_key: key, downloads, added: id });
  const items = [
    entry(1, "Snipertown", "dm/snipertown", 10),
    entry(2, "Remagen", "obj/obj_remagen", 99),
    entry(3, "Sniper Valley", "dm/snipervalley", 50),
  ];
  const content = { tab: "maps", playedNow: true, query: "", mode: null, sort: "played", items };
  const servers = [row("a:1", "dm/snipertown", 7), row("b:1", "obj/obj_remagen", 3)];
  const ids = (shown) => shown.map((item) => item.id);
  const played = (extra) => ids(visibleItems({ ...content, ...extra }, servers));
  assert.deepEqual(played({}), [1, 2, 3]);
  assert.deepEqual(played({ sort: "popular" }), [2, 3, 1]);
  assert.deepEqual(played({ query: "SNIPER" }), [1, 3]);
  assert.deepEqual(played({ mode: "objective" }), [2]);
  assert.deepEqual(ids(visibleItems({ ...content, playedNow: false, sort: "name" }, servers)), [1, 2, 3], "a browse keeps moh-db's order");
});
