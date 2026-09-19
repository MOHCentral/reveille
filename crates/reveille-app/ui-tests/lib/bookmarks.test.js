// SPDX-License-Identifier: GPL-3.0-only

// `lib/bookmarks.js`: what Reveille remembers between runs.
//
// The rule that shapes this whole module is H12, and it is structural rather than editorial: an
// entry stores an address, a query port and a name — **and nothing else**. There is no client
// count, map, round trip or compatibility state to render as current, because the data to lie with
// does not exist here. The first test below asserts exactly that, by shape.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage, installBrokenStorage } from "../fakes/storage.js";

installStorage();
const bookmarks = await import("../../ui/lib/bookmarks.js");

const KEY = "reveille.bookmarks";

/** A live row, with more on it than a bookmark is allowed to keep. */
function row(address, hostname = "A server", queryPort = 12300) {
  return {
    address,
    server: {
      hostname,
      endpoint: { query_port: queryPort },
      occupancy: { clients_reported: 12, bots_reported: 4 },
      status_round_trip: 48,
      current_map: "obj/obj_team1",
    },
  };
}

function seed(store) {
  return installStorage({ [KEY]: JSON.stringify({ v: 1, favorites: [], history: [], ...store }) });
}

/* The storage shape is the rule (H12) --------------------------------------- */

test("a starred row keeps an address, a port and a name, and discards every figure", () => {
  const storage = seed({});
  bookmarks.toggleFavorite(row("10.0.0.1:12203", "Sniper Only"));

  const [saved] = storage.json(KEY).favorites;
  assert.equal(saved.address, "10.0.0.1:12203");
  assert.equal(saved.queryPort, 12300);
  assert.equal(saved.hostname, "Sniper Only");

  // The row that produced this entry carried a client count, a bot count, a round trip and a map.
  // None of them may be here: a remembered measurement drawn in the live table would read as
  // current, and the only reliable way to prevent that is to never store it.
  for (const forbidden of [
    "occupancy",
    "clients_reported",
    "bots_reported",
    "status_round_trip",
    "current_map",
    "compatibility",
  ]) {
    assert.ok(!(forbidden in saved), `${forbidden} must not be stored`);
  }
});

test("history stores the same three facts and no more", () => {
  const storage = seed({});
  bookmarks.recordLaunch(row("10.0.0.2:12203", "Objective"));
  const [saved] = storage.json(KEY).history;
  assert.deepEqual(Object.keys(saved).sort(), [
    "addedAt",
    "address",
    "hostname",
    "lastLaunchedAt",
    "launches",
    "queryPort",
  ]);
});

/* Starring ------------------------------------------------------------------ */

test("toggling stars and unstars, and reports the new state", () => {
  seed({});
  assert.equal(bookmarks.toggleFavorite(row("a:1")), true);
  assert.equal(bookmarks.isFavorite("a:1"), true);
  assert.equal(bookmarks.toggleFavorite(row("a:1")), false);
  assert.equal(bookmarks.isFavorite("a:1"), false);
});

test("a favorite can be unstarred from a remembered entry, not only from a live row", () => {
  seed({ favorites: [{ address: "gone:1", queryPort: 12300, hostname: "Absent" }] });
  // This is the case that matters: the sweep did not return the server, so there is no row — and
  // the star on the absent entry still has to work.
  assert.equal(bookmarks.toggleFavorite({ address: "gone:1", queryPort: 12300 }), false);
  assert.deepEqual(bookmarks.favorites(), []);
});

test("newly starred servers come back first", () => {
  seed({});
  bookmarks.toggleFavorite(row("first:1"));
  bookmarks.toggleFavorite(row("second:1"));
  assert.deepEqual(bookmarks.favorites().map((saved) => saved.address), ["second:1", "first:1"]);
});

test("favoriteAddresses returns the set the table reads once per paint", () => {
  seed({});
  bookmarks.toggleFavorite(row("a:1"));
  bookmarks.toggleFavorite(row("b:1"));
  const addresses = bookmarks.favoriteAddresses();
  // A per-row `isFavorite` would parse the store a hundred-odd times a paint.
  assert.ok(addresses instanceof Set);
  assert.deepEqual([...addresses].sort(), ["a:1", "b:1"]);
});

test("forget removes one favorite by address and leaves the rest", () => {
  seed({
    favorites: [
      { address: "a:1", queryPort: 1, hostname: "A" },
      { address: "b:1", queryPort: 2, hostname: "B" },
    ],
  });
  bookmarks.forget("a:1");
  assert.deepEqual(bookmarks.favorites().map((saved) => saved.address), ["b:1"]);
});

/* History ------------------------------------------------------------------- */

test("a second launch of the same server counts up rather than adding a row", () => {
  seed({});
  bookmarks.recordLaunch(row("a:1"));
  bookmarks.recordLaunch(row("a:1"));
  const entries = bookmarks.history();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].launches, 2);
});

test("history is capped so it stays a history rather than a log", () => {
  seed({});
  for (let index = 0; index < 55; index += 1) bookmarks.recordLaunch(row(`server-${index}:1`));
  const entries = bookmarks.history();
  assert.equal(entries.length, 50);
  // Most recent first, so the cap drops the oldest.
  assert.equal(entries[0].address, "server-54:1");
});

test("historyByAddress keys the entries for the list's launched column", () => {
  seed({});
  bookmarks.recordLaunch(row("a:1"));
  const map = bookmarks.historyByAddress();
  assert.ok(map instanceof Map);
  assert.equal(map.get("a:1").launches, 1);
});

test("clearHistory empties history and leaves favorites alone", () => {
  seed({ favorites: [{ address: "a:1", queryPort: 1, hostname: "A" }] });
  bookmarks.recordLaunch(row("b:1"));
  bookmarks.clearHistory();
  assert.deepEqual(bookmarks.history(), []);
  assert.equal(bookmarks.favorites().length, 1);
});

/* Reading what a previous version wrote ------------------------------------- */

test("the pre-rename favourites field is still read", () => {
  // Read so an existing player's starred list survives the rename; the next write replaces the
  // whole blob under the new name.
  installStorage({
    [KEY]: JSON.stringify({
      v: 1,
      favourites: [{ address: "a:1", queryPort: 12300, hostname: "Old spelling" }],
      history: [],
    }),
  });
  assert.deepEqual(bookmarks.favorites().map((saved) => saved.address), ["a:1"]);
});

test("an entry that could not be acted on is dropped rather than listed", () => {
  installStorage({
    [KEY]: JSON.stringify({
      v: 1,
      favorites: [
        { address: "good:1", queryPort: 12300, hostname: "Fine" },
        { queryPort: 12300, hostname: "No address" },
        { address: "bad-port:1", queryPort: 0 },
        { address: "bad-port:2", queryPort: 70000 },
        { address: "bad-port:3", queryPort: "twelve" },
      ],
      history: [],
    }),
  });
  // A star with no way to re-probe it is a row whose only control cannot work. Dropping it beats
  // drawing a Check button that is guaranteed to fail.
  assert.deepEqual(bookmarks.favorites().map((saved) => saved.address), ["good:1"]);
});

test("a store from another version is ignored rather than half-read", () => {
  installStorage({ [KEY]: JSON.stringify({ v: 99, favorites: [{ address: "a:1", queryPort: 1 }] }) });
  assert.deepEqual(bookmarks.favorites(), []);
});

test("a corrupt store reads as empty rather than refusing to start", () => {
  installStorage({ [KEY]: "{not json at all" });
  assert.deepEqual(bookmarks.favorites(), []);
  assert.deepEqual(bookmarks.history(), []);
});

test("storage that throws is survivable in both directions", () => {
  installBrokenStorage();
  assert.doesNotThrow(() => bookmarks.favorites());
  assert.doesNotThrow(() => bookmarks.toggleFavorite(row("a:1")));
  assert.doesNotThrow(() => bookmarks.recordLaunch(row("a:1")));
  installStorage();
});
