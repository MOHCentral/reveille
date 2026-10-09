// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

const { installShare, liveSummary, queryKey, runningOn } = await import(
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

test("a change of game, search or order is a different question to ask moh-db", () => {
  const session = { path: "C:\\MOHAA", engine: "original", game: "allied_assault" };
  const key = queryKey(session, " snipertown ", "popular");
  assert.equal(key, queryKey(session, "snipertown", "popular"));
  assert.notEqual(key, queryKey({ ...session, game: "spearhead" }, "snipertown", "popular"));
  assert.notEqual(key, queryKey(session, "snipertown", "newest"));
});
