// SPDX-License-Identifier: GPL-3.0-only

// `lib/store.js`: the persisted filters and the derived list.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage, installBrokenStorage } from "../fakes/storage.js";

installStorage();
const store = await import("../../ui/lib/store.js");
const { watchReading } = await import("../../ui/lib/player-alerts.js");
await import("../../ui/lib/bookmarks.js");

/** A live row, carrying only the fields the store actually reads. */
function row(address, extra = {}) {
  return {
    address,
    server: {
      hostname: extra.hostname ?? address,
      occupancy: { clients_reported: extra.clients ?? 0, bots_reported: extra.bots ?? 0 },
      status_round_trip: "roundTrip" in extra ? extra.roundTrip : 50,
      current_map: extra.map ?? "dm/mohdm1",
      game_type: "mode" in extra ? extra.mode : "Deathmatch",
      endpoint: { query_port: extra.queryPort ?? 12300 },
      client_capacity: extra.capacity ?? 32,
      players: (extra.players ?? []).map((name) => ({ name, ping: 40, kills: null, deaths: null })),
    },
    compatibility: { state: { state: extra.needs ? "needs_maps" : "compatible", count: extra.needs } },
  };
}

/** Return the store to the shape a fresh window would have. */
function reset(seed = {}) {
  const storage = installStorage(seed);
  store.state.servers = [];
  store.state.install = null;
  store.state.engine = null;
  store.state.game = "allied_assault";
  store.state.listSession = null;
  store.state.filters = { query: "", maxPing: null, modes: [], ready: false };
  store.state.showEmpty = false;
  store.state.detailCollapsed = false;
  store.state.sort = { column: "clients", direction: "desc" };
  store.state.scope = "all";
  store.state.showAbsent = false;
  store.state.browse = { ...store.state.browse, running: false };
  store.state.joining = false;
  store.state.checks = new Map();
  store.state.previousCounts = new Map();
  return storage;
}

/* Filters -------------------------------------------------------------------*/

test("the search box matches the address as well as the name", () => {
  reset();
  store.state.servers = [row("10.0.0.1:12203", { hostname: "Sniper Only" })];

  store.state.filters.query = "sniper";
  assert.equal(store.visibleServers().length, 1);

  // Pasting an IP used to say "Nothing matches" in All while finding it in Favorites, because the
  // two code paths matched different fields.
  store.state.filters.query = "10.0.0.1";
  assert.equal(store.visibleServers().length, 1);

  store.state.filters.query = "nothing like it";
  assert.equal(store.visibleServers().length, 0);
});

test("the search box also matches the map and the mode", () => {
  reset();
  store.state.servers = [
    row("a:1", { map: "obj/obj_team2", mode: "Objective-Match" }),
    row("b:1", { map: "dm/mohdm6", mode: "Team-Match" }),
  ];

  store.state.filters.query = "mohdm6";
  assert.deepEqual(store.visibleServers().map((item) => item.address), ["b:1"]);

  store.state.filters.query = "objective";
  assert.deepEqual(store.visibleServers().map((item) => item.address), ["a:1"]);
});

test("the search box finds a server by a player on it and names who it found", () => {
  reset();
  store.state.servers = [
    row("a:1", { hostname: "Omaha 24/7", players: ["<[TFC]>Goat", "Raven"] }),
    row("b:1", { hostname: "Sniper Town", players: ["Fox"] }),
  ];

  store.state.filters.query = "goat";
  assert.deepEqual(store.visibleServers().map((item) => item.address), ["a:1"]);
  assert.deepEqual(store.playersFound(store.state.servers[0]), ["<[TFC]>Goat"]);
  assert.deepEqual(store.playersFound(store.state.servers[1]), []);
});

test("a clan tag search names the members on the clan's own server", () => {
  reset();
  store.state.servers = [
    row("a:1", {
      hostname: "-=[PN]=- Custom Objectives | Bots + Squads",
      players: ["-=[PN]=- Feho", "Raven"],
    }),
  ];

  store.state.filters.query = "[pn]";
  assert.equal(store.visibleServers().length, 1);
  assert.deepEqual(store.playersFound(store.state.servers[0]), ["-=[PN]=- Feho"]);

  store.state.filters.query = "";
  assert.deepEqual(store.playersFound(store.state.servers[0]), []);
});

test("equally busy servers sort nearest first", () => {
  reset();
  store.state.servers = [
    row("far:1", { hostname: "A far", clients: 4, roundTrip: 200 }),
    row("near:1", { hostname: "Z near", clients: 4, roundTrip: 20 }),
    row("busy:1", { hostname: "M busy", clients: 9, roundTrip: 300 }),
  ];
  assert.deepEqual(
    store.visibleServers().map((item) => item.address),
    ["busy:1", "near:1", "far:1"],
  );
});

test("the ping ceiling never hides a server that published no round trip", () => {
  reset();
  store.state.servers = [
    row("a:1", { roundTrip: 40 }),
    row("b:1", { roundTrip: 400 }),
    row("c:1", { roundTrip: null }),
  ];
  store.state.filters.maxPing = 80;
  const addresses = store.visibleServers().map((visible) => visible.address).sort();
  // Hiding `c` would be a claim about a figure that does not exist.
  assert.deepEqual(addresses, ["a:1", "c:1"]);
});

test("All folds servers with no players under one row that counts them", () => {
  reset();
  store.state.servers = [
    row("a:1", { clients: 3 }),
    row("b:1", { clients: 0, bots: 6 }),
    row("c:1", { clients: 0, bots: 0 }),
  ];
  const shut = store.scopedRows();
  assert.deepEqual(shut.map((item) => item.kind), ["live", "empty-fold"]);
  assert.equal(shut[1].count, 2);
  assert.equal(shut[1].bots, 1);
  assert.equal(store.foldedEmpty(), 2);

  store.state.showEmpty = true;
  assert.deepEqual(
    store.scopedRows().map((item) => item.address).filter((address) => !address.startsWith("empty:")),
    ["a:1", "b:1", "c:1"],
  );
  assert.equal(store.foldedEmpty(), 0);
});

test("a search unfolds empty servers so they can be found by name", () => {
  reset();
  store.state.servers = [row("a:1", { hostname: "Busy", clients: 3 }), row("b:1", { hostname: "Quiet" })];
  store.state.filters.query = "quiet";
  assert.deepEqual(store.scopedRows().map((item) => item.address), ["b:1"]);
  assert.equal(store.foldedEmpty(), 0);
});

test("no fold is drawn when every server has players", () => {
  reset();
  store.state.servers = [row("a:1", { clients: 3 })];
  assert.deepEqual(store.scopedRows().map((item) => item.kind), ["live"]);
});

test("filtering() reports whether anything is narrowing the list", () => {
  reset();
  assert.equal(store.filtering(), false);
  store.state.filters.query = "   ";
  assert.equal(store.filtering(), false, "whitespace is not a query");
  store.state.filters.query = "x";
  assert.equal(store.filtering(), true);
  reset();
  store.state.filters.maxPing = 80;
  assert.equal(store.filtering(), true);
});

test("the Mode chip keeps only the ticked modes, whatever their case", () => {
  reset();
  store.state.servers = [
    row("a:1", { mode: "Objective-Match" }),
    row("b:1", { mode: "objective-match" }),
    row("c:1", { mode: "Team-Match" }),
    row("d:1", { mode: null }),
  ];
  store.state.filters.modes = ["objective-match"];
  assert.deepEqual(store.visibleServers().map((visible) => visible.address).sort(), ["a:1", "b:1"]);
  assert.equal(store.filtering(), true);
});

test("the Mode chip lists each published mode once, busiest first", () => {
  reset();
  store.state.servers = [
    row("a:1", { mode: "Team-Match" }),
    row("b:1", { mode: "Objective-Match" }),
    row("c:1", { mode: "objective-match" }),
    row("d:1", { mode: null }),
  ];
  store.state.filters.modes = ["freeze-tag"];
  assert.deepEqual(
    store.modeChoices().map((choice) => [choice.key, choice.count]),
    [["objective-match", 2], ["team-match", 1], ["freeze-tag", 0]],
  );
});

test("Ready to join keeps servers with nothing to download and a free slot", () => {
  reset();
  store.state.servers = [
    row("ready:1", { clients: 4 }),
    row("maps:1", { needs: 2 }),
    row("full:1", { clients: 16, capacity: 16 }),
  ];
  store.state.filters.ready = true;
  assert.deepEqual(store.visibleServers().map((visible) => visible.address), ["ready:1"]);
});

test("Clear all empties the search box and every chip", () => {
  reset();
  store.state.filters = { query: "x", maxPing: 80, modes: ["team-match"], ready: true };
  store.clearFilters(store.state);
  assert.equal(store.filtering(), false);
});

test("the chips are remembered across a restart", () => {
  const storage = reset();
  store.state.filters = { query: "sniper", maxPing: 150, modes: ["team-match"], ready: true };
  store.saveFilters();
  reset({ "reveille.filters": storage.getItem("reveille.filters") });
  store.loadFilters();
  assert.deepEqual(store.state.filters, { query: "", maxPing: 150, modes: ["team-match"], ready: true });
});

/* Saved-preference migrations ----------------------------------------------- */

test("the pre-rename scope value is still read", () => {
  reset({
    "reveille.filters": JSON.stringify({
      maxPing: 150,
      scope: "favourites",
      showAbsent: true,
      sort: { column: "ping", direction: "asc" },
    }),
  });
  store.loadFilters();
  assert.equal(store.state.filters.maxPing, 150);
  assert.equal(store.state.scope, "favorites");
  assert.equal(store.state.showAbsent, true);
  assert.deepEqual(store.state.sort, { column: "ping", direction: "asc" });
});

test("a ping ceiling the toolbar does not offer is not restored", () => {
  reset({ "reveille.filters": JSON.stringify({ maxPing: 37 }) });
  store.loadFilters();
  // Otherwise the gate would be applying a limit no control on screen can express or clear.
  assert.equal(store.state.filters.maxPing, null);
});

test("a corrupt preference blob leaves the defaults standing", () => {
  reset({ "reveille.filters": "{not json" });
  assert.doesNotThrow(() => store.loadFilters());
  assert.deepEqual(store.state.filters, { query: "", maxPing: null, modes: [], ready: false });
});

test("the search box is deliberately not persisted", () => {
  const storage = reset();
  store.state.filters.query = "sniper";
  store.state.showEmpty = true;
  store.saveFilters();
  assert.equal(storage.json("reveille.filters").query, "");
  assert.equal(storage.json("reveille.filters").showEmpty, true);
});

test("a hidden detail pane stays hidden after a restart", () => {
  const storage = reset();
  store.state.detailCollapsed = true;
  store.saveFilters();
  store.state.detailCollapsed = false;
  reset({ "reveille.filters": storage.getItem("reveille.filters") });
  store.loadFilters();
  assert.equal(store.state.detailCollapsed, true);
});

/* Scoped rows and the disclosure (H15) -------------------------------------- */

test("folded remembered entries always state their count, open or shut", () => {
  const storage = reset();
  storage.setItem(
    "reveille.bookmarks",
    JSON.stringify({
      v: 1,
      favorites: [
        { address: "here:1", queryPort: 12300, hostname: "Answered" },
        { address: "gone:1", queryPort: 12300, hostname: "Starred under Spearhead" },
        { address: "also-gone:1", queryPort: 12300, hostname: "Also absent" },
      ],
      history: [],
    }),
  );
  store.state.scope = "favorites";
  store.state.servers = [row("here:1", { hostname: "Answered" })];

  const shut = store.scopedRows();
  const disclosure = shut.find((item) => item.kind === "disclosure");
  // Shut: the live row and the disclosure, and the two absent entries behind it. Rows may be
  // folded away, never silently dropped — a fold that does not say what it folds is a filter with
  // an invisible effect (rule H15).
  assert.ok(disclosure, "a disclosure is emitted while anything is behind it");
  assert.equal(disclosure.count, 2);
  assert.equal(shut.filter((item) => item.kind === "absent").length, 0);

  store.state.showAbsent = true;
  const open = store.scopedRows();
  const stillThere = open.find((item) => item.kind === "disclosure");
  // Open: the count is still on screen. "Either way" is the rule, and it is the half a regression
  // would quietly drop.
  assert.ok(stillThere);
  assert.equal(stillThere.count, 2);
  assert.equal(open.filter((item) => item.kind === "absent").length, 2);

  // The open state rides in the disclosure's address because that is what the table's row
  // signature hashes; without it, opening the block would not repaint.
  assert.notEqual(disclosure.address, stillThere.address);
});

test("no disclosure is drawn when the check returned everything remembered", () => {
  const storage = reset();
  storage.setItem(
    "reveille.bookmarks",
    JSON.stringify({
      v: 1,
      favorites: [{ address: "here:1", queryPort: 12300, hostname: "Answered" }],
      history: [],
    }),
  );
  store.state.scope = "favorites";
  store.state.servers = [row("here:1")];
  assert.deepEqual(store.scopedRows().map((item) => item.kind), ["live"]);
});

test("an absent entry carries no figures, only what was remembered", () => {
  const storage = reset();
  storage.setItem(
    "reveille.bookmarks",
    JSON.stringify({
      v: 1,
      favorites: [{ address: "gone:1", queryPort: 12300, hostname: "Remembered name" }],
      history: [],
    }),
  );
  store.state.scope = "favorites";
  store.state.showAbsent = true;

  const absent = store.scopedRows().find((item) => item.kind === "absent");
  // A bookmark stores an address, a query port and a name and nothing else, so there is no stale
  // measurement that could be redrawn as current (rule H12). This asserts the shape that makes
  // that true rather than the wording that reports it.
  assert.deepEqual(Object.keys(absent.entry).sort(), [
    "addedAt",
    "hostname",
    "lastLaunchedAt",
    "launches",
    "queryPort",
    "address",
  ].sort());
  assert.ok(!("occupancy" in absent.entry));
  assert.ok(!("status_round_trip" in absent.entry));
  assert.ok(!("current_map" in absent.entry));
});

test("History lists the most recently launched server first", () => {
  const storage = reset();
  storage.setItem(
    "reveille.bookmarks",
    JSON.stringify({
      v: 1,
      favorites: [],
      history: [
        { address: "old:1", queryPort: 12300, hostname: "Old", launches: 1, lastLaunchedAt: "2026-01-01T00:00:00Z" },
        { address: "new:1", queryPort: 12300, hostname: "New", launches: 1, lastLaunchedAt: "2026-09-01T00:00:00Z" },
      ],
    }),
  );
  store.state.scope = "history";
  store.state.sort = { column: "launched", direction: "desc" };
  store.state.servers = [row("old:1", { clients: 9 }), row("new:1")];
  assert.deepEqual(store.scopedRows().map((item) => item.address), ["new:1", "old:1"]);
});

test("the All scope draws no disclosure and no absent entries", () => {
  const storage = reset();
  storage.setItem(
    "reveille.bookmarks",
    JSON.stringify({
      v: 1,
      favorites: [{ address: "gone:1", queryPort: 12300, hostname: "Absent" }],
      history: [],
    }),
  );
  store.state.scope = "all";
  store.state.servers = [row("here:1", { clients: 2 })];
  assert.deepEqual(store.scopedRows().map((item) => item.kind), ["live"]);
  assert.deepEqual(store.scopedAbsent(), []);
});

test("Watching lists this game's watched servers, answering ones first and the rest unfolded", () => {
  const storage = reset();
  storage.setItem(
    "reveille.player-alerts",
    JSON.stringify([
      { game: "allied_assault", address: "1.2.3.4:12203", queryPort: 12300, hostname: "Quiet" },
      { game: "allied_assault", address: "1.2.3.5:12203", queryPort: 12300, hostname: "Busy" },
      { game: "spearhead", address: "1.2.3.6:12203", queryPort: 12300, hostname: "Other game" },
    ]),
  );
  store.state.scope = "watching";
  store.state.servers = [row("1.2.3.5:12203", { clients: 5 }), row("9.9.9.9:1", { clients: 9 })];
  assert.deepEqual(
    store.scopedRows().map((item) => [item.kind, item.address]),
    [["live", "1.2.3.5:12203"], ["watched", "1.2.3.4:12203"]],
  );
  assert.deepEqual(store.scopedAbsent(), []);
  store.state.watchReadings = new Map([["allied_assault|1.2.3.4:12203", { count: 2, checkedAt: 1 }]]);
  assert.equal(watchReading("1.2.3.4:12203").count, 2);
  assert.equal(watchReading("1.2.3.5:12203"), null);
});

test("the Watching scope is remembered like the others", () => {
  reset({ "reveille.filters": JSON.stringify({ scope: "watching" }) });
  store.loadFilters();
  assert.equal(store.state.scope, "watching");
});

/* Re-checking ---------------------------------------------------------------*/

test("one server may not be re-asked during a sweep, during a join, or while already in flight", () => {
  reset();
  assert.equal(store.canRecheck("a:1"), true);

  store.state.browse.running = true;
  assert.equal(store.canRecheck("a:1"), false, "a sweep is already re-asking every server");
  store.state.browse.running = false;

  store.state.joining = true;
  assert.equal(store.canRecheck("a:1"), false, "the pane belongs to the join command");
  store.state.joining = false;

  store.state.checks.set("a:1", { status: "checking" });
  assert.equal(store.canRecheck("a:1"), false);
  assert.equal(store.canRecheck("b:1"), true, "another address is unaffected");
});

/* Subscribe / update ---------------------------------------------------------*/

test("update mutates and then notifies exactly once", () => {
  reset();
  let notified = 0;
  const unsubscribe = store.subscribe(() => (notified += 1));
  store.update((next) => {
    next.selected = "a:1";
    next.joining = true;
  });
  assert.equal(notified, 1);
  assert.equal(store.state.selected, "a:1");
  unsubscribe();
  store.update(() => {});
  assert.equal(notified, 1, "an unsubscribed handler is not called again");
});

/* Freshness and trends ------------------------------------------------------ */

test("a list turns stale five minutes after its sweep finished", () => {
  reset();
  const finished = Date.parse("2026-09-28T12:00:00Z");
  store.state.browse = { ...store.state.browse, finishedAt: new Date(finished).toISOString() };
  assert.equal(store.listIsStale(finished + store.STALE_AFTER_MS), false);
  assert.equal(store.listIsStale(finished + store.STALE_AFTER_MS + 1), true);
  store.state.browse = { ...store.state.browse, finishedAt: null };
  assert.equal(store.listIsStale(finished + 3_600_000), false, "no list is not a stale list");
});

test("a row's trend compares players with the list it replaced, never bots", () => {
  reset();
  store.state.previousCounts = store.countsByAddress([
    row("up:1", { clients: 2 }),
    row("down:1", { clients: 9 }),
    row("same:1", { clients: 4, bots: 1 }),
  ]);
  assert.deepEqual(store.playerTrend(row("up:1", { clients: 5 })), { direction: "up", before: 2 });
  assert.deepEqual(store.playerTrend(row("down:1", { clients: 3 })), { direction: "down", before: 9 });
  assert.equal(store.playerTrend(row("same:1", { clients: 4, bots: 8 })), null);
  assert.equal(store.playerTrend(row("new:1", { clients: 4 })), null, "a server seen once has no trend");
  store.state.previousCounts = new Map();
});
