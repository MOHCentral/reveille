// SPDX-License-Identifier: GPL-2.0-only

// `lib/store.js`: the persisted preferences, the session identity, and the derived list.
//
// The migration test here is the one that used to live inside `tools/check-sources.mjs`, which had
// grown two behavioural assertions because there was nowhere else to put them. There is now.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage, installBrokenStorage } from "../fakes/storage.js";

installStorage();
const store = await import("../../ui/lib/store.js");

/** A live row, carrying only the fields the store actually reads. */
function row(address, extra = {}) {
  return {
    address,
    server: {
      hostname: extra.hostname ?? address,
      occupancy: { clients_reported: extra.clients ?? 0, bots_reported: extra.bots ?? 0 },
      status_round_trip: "roundTrip" in extra ? extra.roundTrip : 50,
      current_map: extra.map ?? "dm/mohdm1",
      game_type: extra.mode ?? "Deathmatch",
      endpoint: { query_port: extra.queryPort ?? 12300 },
    },
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
  store.state.filters = { query: "", notEmpty: false, maxPing: null };
  store.state.sort = { column: "clients", direction: "desc" };
  store.state.scope = "all";
  store.state.showAbsent = false;
  store.state.browse = { ...store.state.browse, running: false };
  store.state.joining = false;
  store.state.checks = new Map();
  return storage;
}

/* The protected-install copy ------------------------------------------------ */

test("the installation copy moves the root, engine and game together", () => {
  const storage = reset({
    "reveille.install": String.raw`C:\Program Files\MOHAA`,
    "reveille.engines": JSON.stringify({
      [String.raw`C:\Program Files\MOHAA`]: "reborn",
      [String.raw`D:\Keep`]: "original",
    }),
    "reveille.games": JSON.stringify({
      [String.raw`C:\Program Files\MOHAA`]: "spearhead",
      [String.raw`D:\Keep`]: "breakthrough",
    }),
  });

  store.migrateInstallationPreferences(
    String.raw`C:\Program Files\MOHAA`,
    String.raw`C:\Users\Player\Games\MOHAA`,
    "reborn",
    "spearhead",
  );

  const engines = storage.json("reveille.engines");
  const games = storage.json("reveille.games");

  assert.equal(storage.raw("reveille.install"), String.raw`C:\Users\Player\Games\MOHAA`);
  assert.equal(engines[String.raw`C:\Users\Player\Games\MOHAA`], "reborn");
  assert.equal(games[String.raw`C:\Users\Player\Games\MOHAA`], "spearhead");

  // The whole point of "as one transaction": the old root must not be left behind pointing at a
  // folder the player was moved out of.
  assert.ok(!(String.raw`C:\Program Files\MOHAA` in engines));
  assert.ok(!(String.raw`C:\Program Files\MOHAA` in games));

  // And an unrelated installation is not collateral damage.
  assert.equal(engines[String.raw`D:\Keep`], "original");
  assert.equal(games[String.raw`D:\Keep`], "breakthrough");
});

test("a migration survives storage that refuses to be written", () => {
  reset();
  installBrokenStorage();
  // The comment in store.js says a launcher that cannot persist a preference still works. Assert
  // it rather than trust it: this must not throw into the setup flow.
  assert.doesNotThrow(() =>
    store.migrateInstallationPreferences("old", "new", "openmohaa", "spearhead"),
  );
  installStorage();
});

/* Remembered engine and game ------------------------------------------------ */

test("an engine or game the enum does not contain is not recalled", () => {
  reset({
    "reveille.engines": JSON.stringify({ "C:/Game": "quake" }),
    "reveille.games": JSON.stringify({ "C:/Game": "wolfenstein" }),
  });
  assert.equal(store.recallEngine("C:/Game"), null);
  assert.equal(store.recallGame("C:/Game"), null);
});

test("defaultGame prefers the remembered game only while the install can still run it", () => {
  reset({ "reveille.games": JSON.stringify({ "C:/Game": "breakthrough" }) });
  const install = { root: "C:/Game", playable: ["allied_assault", "breakthrough"] };
  assert.equal(store.defaultGame(install), "breakthrough");

  // The expansion's data is gone. Opening on a game the folder cannot serve would be a session
  // that fails on its first command, so the remembered choice is dropped rather than honoured.
  assert.equal(store.defaultGame({ root: "C:/Game", playable: ["allied_assault"] }), "allied_assault");
  assert.equal(store.defaultGame({ root: "C:/Game", playable: [] }), "allied_assault");
});

/* The session the list was swept for (H12) ---------------------------------- */

test("the list belongs to the session only when the folder, engine and game all still match", () => {
  reset();
  store.state.install = { root: "C:/Game", playable: ["allied_assault"] };
  store.state.engine = "openmohaa";
  store.state.game = "allied_assault";
  store.state.listSession = { path: "C:/Game", engine: "openmohaa", game: "allied_assault" };
  assert.equal(store.listIsForCurrentSession(), true);

  // All three facts count. The game decides which master registration was asked and so which
  // servers exist at all; the folder and engine decide the search path every row's compatibility
  // was judged against. Leaving Spearhead's rows on screen under Allied Assault would be the same
  // false currency as a bookmark's old figures (rule H12).
  for (const change of [
    () => (store.state.game = "spearhead"),
    () => (store.state.engine = "reborn"),
    () => (store.state.install = { root: "D:/Other", playable: ["allied_assault"] }),
  ]) {
    reset();
    store.state.install = { root: "C:/Game", playable: ["allied_assault"] };
    store.state.engine = "openmohaa";
    store.state.game = "allied_assault";
    store.state.listSession = { path: "C:/Game", engine: "openmohaa", game: "allied_assault" };
    change();
    assert.equal(store.listIsForCurrentSession(), false);
  }
});

test("a list with no sweep behind it belongs to no session", () => {
  reset();
  store.state.install = { root: "C:/Game", playable: ["allied_assault"] };
  assert.equal(store.listIsForCurrentSession(), false);
});

/* Filters -------------------------------------------------------------------*/

test("the search box matches the address as well as the name", () => {
  reset();
  store.state.servers = [row("10.0.0.1:12203", { hostname: "Sniper Only" })];

  store.state.filters.query = "sniper";
  assert.equal(store.visibleServers().length, 1);

  // Pasting an IP used to say "Nothing matches" in All while finding it in Favorites, because the
  // two code paths matched different fields (docs/design-review.md F13).
  store.state.filters.query = "10.0.0.1";
  assert.equal(store.visibleServers().length, 1);

  store.state.filters.query = "nothing like it";
  assert.equal(store.visibleServers().length, 0);
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

test("Not empty gates on the reported client count, and a missing count is not people", () => {
  reset();
  store.state.servers = [row("a:1", { clients: 3 }), row("b:1", { clients: 0 })];
  store.state.filters.notEmpty = true;
  assert.deepEqual(store.visibleServers().map((visible) => visible.address), ["a:1"]);
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

/* Saved-preference migrations ----------------------------------------------- */

test("the pre-rename filter key and scope value are still read", () => {
  // `hasPeople` asserted in the toolbar exactly what the status bar says is not verified, so the
  // identifier moved with the label (rule H1). An existing player's toggle has to survive that.
  reset({
    "reveille.filters": JSON.stringify({
      hasPeople: true,
      maxPing: 150,
      scope: "favourites",
      showAbsent: true,
      sort: { column: "ping", direction: "asc" },
    }),
  });
  store.loadFilters();
  assert.equal(store.state.filters.notEmpty, true);
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
  assert.deepEqual(store.state.filters, { query: "", notEmpty: false, maxPing: null });
});

test("the search box is deliberately not persisted", () => {
  const storage = reset();
  store.state.filters.query = "sniper";
  store.state.filters.notEmpty = true;
  store.saveFilters();
  assert.equal(storage.json("reveille.filters").query, "");
  assert.equal(storage.json("reveille.filters").notEmpty, true);
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
  store.state.servers = [row("here:1")];
  assert.deepEqual(store.scopedRows().map((item) => item.kind), ["live"]);
  assert.deepEqual(store.scopedAbsent(), []);
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
