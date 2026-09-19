// SPDX-License-Identifier: GPL-3.0-only

// `lib/format.js`: every string the player reads that is derived from pipeline data.
//
// **On locales.** `bytes`, `clockTime` and `timeAgo` reach `toLocale*`, which depends on the
// process locale and time zone. Asserting an exact string would make these tests pass on this
// machine and fail on a contributor's, so where the locale is involved they assert shape and
// invariants instead — the same input gives the same output, a later moment gives a different
// one, the branch taken is the branch expected. Everything else is locale-free and is asserted
// exactly.

import test from "node:test";
import assert from "node:assert/strict";

import * as format from "../../ui/lib/format.js";

/* Sizes ---------------------------------------------------------------------*/

test("bytes keeps a decimal below 100 so a small download is not rounded to nothing", () => {
  assert.equal(format.bytes(512), "512 B");
  assert.equal(format.bytes(1024 * 5), "5.0 KB");
  assert.equal(format.bytes(1024 * 500), "500 KB");
  // 0.4 MB must not read as "0 MB": the figure is the whole point of the button it appears in.
  assert.match(format.bytes(1024 * 1024 * 0.4), /^4\d{2} KB$/u);
  assert.equal(format.bytes(1024 * 1024 * 9.1), "9.1 MB");
  assert.equal(format.bytes(1024 * 1024 * 512), "512 MB");
});

test("a size that does not exist is an em dash, never a zero", () => {
  // Zero bytes and "no figure published" are different claims, and the second one must not be
  // rendered as the first.
  for (const missing of [null, undefined, Number.NaN, Infinity, "not a number"]) {
    assert.equal(format.bytes(missing), "—");
  }
  assert.equal(format.bytes(0), "0 B", "an actual zero is still a figure");
});

/* Counts --------------------------------------------------------------------*/

test("plural agrees with its count", () => {
  assert.equal(format.plural(1, "map"), "1 map");
  assert.equal(format.plural(0, "map"), "0 maps");
  assert.equal(format.plural(3, "map"), "3 maps");
  assert.equal(format.plural(2, "server file"), "2 server files");
  assert.equal(format.plural(2, "entry", "entries"), "2 entries");
});

/* Paths ---------------------------------------------------------------------*/

test("displayPath strips the Windows extended-length prefix", () => {
  assert.equal(
    format.displayPath(String.raw`\\?\C:\Program Files\MOHAA`),
    String.raw`C:\Program Files\MOHAA`,
  );
  // Only at the front: a prefix in the middle of a path is not a prefix.
  assert.equal(format.displayPath(String.raw`C:\Games\MOHAA`), String.raw`C:\Games\MOHAA`);
  assert.equal(format.displayPath(null), "");
});

/* Occupancy (rules H1, H2, H7) ---------------------------------------------- */

test("clients and bots are returned as separate figures, never summed", () => {
  const counts = format.occupancy({
    occupancy: { clients_reported: 0, bots_reported: 6 },
    client_capacity: 32,
  });
  // Bots are not in `svs.clients`, so a naive reading double-counts them. `0 clients (+6 bots)`
  // is the honest rendering and `6` is not.
  assert.deepEqual(counts, { clients: 0, bots: 6, capacity: 32 });
});

test("zero bots are null so nothing draws a +0", () => {
  const counts = format.occupancy({ occupancy: { clients_reported: 4, bots_reported: 0 } });
  assert.equal(counts.bots, null);
});

test("occupancy returns nulls rather than guessing zero", () => {
  assert.deepEqual(format.occupancy({}), { clients: null, bots: null, capacity: null });
});

/* The Ping column (rule H11) ------------------------------------------------ */

test("the round trip is never described as the in-game ping", () => {
  const trip = format.roundTrip({ status_round_trip: 48 });
  assert.equal(trip.text, "48 ms");
  // The column is called Ping because that is the word players look for, but every explanation is
  // the honest one. It is one UDP sample taken while fifteen other probes were in flight.
  assert.match(trip.title, /Not the in-game ping/u);
  assert.match(trip.title, /measured once during this check/u);
});

test("an unmeasured round trip is an em dash with no explanation to give", () => {
  // Never synthesised. A server that produced no reply is not listed at all, so there is no
  // unknown case to fill in.
  for (const missing of [null, undefined, "nonsense"]) {
    assert.deepEqual(format.roundTrip({ status_round_trip: missing }), { text: "—", title: null });
  }
});

/* The Mode column ------------------------------------------------------------*/

test("a gametype is shown exactly as the server spelled it", () => {
  // `g_gametypestring` is an ordinary cvar and a mod may put anything there. An abbreviation
  // Reveille invented would be a claim about a server it cannot check.
  assert.deepEqual(format.gameType({ game_type: "Freeze Tag (custom)" }), {
    text: "Freeze Tag (custom)",
    title: "Freeze Tag (custom)",
  });
});

test("a server that published no gametype says so", () => {
  const mode = format.gameType({ game_type: "   " });
  assert.equal(mode.text, "—");
  assert.match(mode.title, /did not publish/u);
});

/* Versions -------------------------------------------------------------------*/

test("the list uses the short comparable version and the pane the full build string", () => {
  const server = { version: "Medal of Honor Allied Assault 1.11 win-x86", game_version: "1.11" };
  // `version` is a sentence and truncates to "Medal of Honor Allied" in every row, which
  // distinguishes nothing.
  assert.equal(format.shortVersion(server), "1.11");
  assert.equal(format.engineLabel(server), "Medal of Honor Allied Assault 1.11 win-x86");
});

test("with no version published, the protocol number is the fallback", () => {
  assert.equal(format.shortVersion({ protocol: 8 }), "protocol 8");
  assert.equal(format.engineLabel({ protocol: 8 }), "protocol 8");
  assert.equal(format.shortVersion({}), "—");
});

/* Map names — the engine's normalisation, reproduced exactly ---------------- */

test("mapKey reproduces the engine normalisation and nothing else", () => {
  // MapKey::new in crates/reveille-core/src/mapindex.rs, and docs/engine-facts.md §2: trim,
  // backslashes to slashes, ASCII lowercase, strip a leading `maps/` and a trailing `.bsp`.
  assert.equal(format.mapKey("  MAPS\\DM\\MOHDM1.BSP  "), "dm/mohdm1");
  assert.equal(format.mapKey("dm/mohdm1"), "dm/mohdm1");
  assert.equal(format.mapKey("maps/obj/obj_team1.bsp"), "obj/obj_team1");
});

test("mapKey inserts no prefix, because both spellings are legitimate", () => {
  // A bare name and a `maps/`-prefixed one are both legal, so normalising one into the other in
  // either direction would make two different maps compare equal — or a server's current map fail
  // to line up with its own rotation entry.
  assert.equal(format.mapKey("mohdm1"), "mohdm1");
  assert.equal(format.mapKey("maps/mohdm1.bsp"), "mohdm1");
});

test("mapKey strips only one trailing .bsp and only a leading maps/", () => {
  assert.equal(format.mapKey("dm/mohdm1.bsp.bsp"), "dm/mohdm1.bsp");
  assert.equal(format.mapKey("custom/maps/thing"), "custom/maps/thing");
});

test("an empty map name has no key", () => {
  for (const empty of ["", "   ", null, undefined, "maps/", ".bsp"]) {
    assert.equal(format.mapKey(empty), null);
  }
});

test("mapName makes an empty name visible rather than drawing a blank", () => {
  assert.equal(format.mapName("  dm/mohdm1 "), "dm/mohdm1");
  assert.equal(format.mapName(""), "(unnamed)");
  assert.equal(format.mapName(null), "(unnamed)");
});

/* The four states (rule H3) ------------------------------------------------- */

test("the four state names are measurements, not verdicts", () => {
  // There is no boolean "can I join", and none of these is a mood word: the name says what
  // Reveille found and the player draws the verdict.
  assert.equal(format.stateName({ state: "compatible" }), "Compatible");
  assert.equal(format.stateName({ state: "needs_maps", count: 1 }), "Needs 1 map");
  assert.equal(format.stateName({ state: "needs_maps", count: 4 }), "Needs 4 maps");
  assert.equal(format.stateName({ state: "no_source", count: 2 }), "No download for 2 maps");
  assert.equal(format.stateName({ state: "cant_tell" }), "Map list not published");
  assert.equal(format.stateName(null), "Map list not published");
});

test("a ready server explains nothing, because silence is the rendering of nothing to do", () => {
  assert.equal(format.stateExplanation({ state: "compatible" }), null);
});

test("every other state explains how it was arrived at", () => {
  assert.match(format.stateExplanation({ state: "needs_maps", count: 3 }), /Reveille can download/u);
  // Singular and plural are separate sentences rather than one with an "(s)".
  assert.match(format.stateExplanation({ state: "no_source", count: 1 }), /This map is/u);
  assert.match(format.stateExplanation({ state: "no_source", count: 2 }), /These maps are/u);
  // "Checked only the map it is running now" is the whole of the claim: one checked map is not a
  // rotation check, and calling it Compatible would claim one that never happened.
  assert.match(format.stateExplanation({ state: "cant_tell" }), /only the map it is running now/u);
});

/* Non-result reasons -------------------------------------------------------- */

test("the stage is part of the reason, not decoration", () => {
  // A timeout answering the master's server-list query and a timeout answering the game query are
  // different failures; labelling both "did not answer" makes one group look like a duplicate.
  assert.equal(
    format.nonResultReason({ reason: "timeout", stage: "get_status" }),
    "did not answer the game query",
  );
  assert.equal(
    format.nonResultReason({ reason: "timeout", stage: "inspect" }),
    "did not answer the server-list query",
  );
  assert.equal(
    format.nonResultReason({ reason: "malformed", stage: "get_status" }),
    "answered the game query with a reply Reveille could not read",
  );
  assert.equal(
    format.nonResultReason({ reason: "duplicate_endpoint" }),
    "is the same server registered twice",
  );
  assert.equal(
    format.nonResultReason({ reason: "missing_host_port" }),
    "did not publish a game port",
  );
});

test("an unrecognised reason shows itself rather than borrowing another cause", () => {
  // Rule H6: never state a cause that was not observed. An unknown kind must not be quietly
  // filed under one of the known sentences.
  assert.equal(
    format.nonResultReason({ reason: "something_new", stage: "get_status" }),
    "something_new at the game query",
  );
});

/* Sweep failures (rule H6) -------------------------------------------------- */

test("each sweep failure carries a cause and a remedy, and keeps the original message", () => {
  const failure = format.browseFailureText({ kind: "master_unreachable", detail: "ECONNREFUSED" });
  assert.match(failure.title, /master server/u);
  // These two moments are where a non-technical player decides whether the tool is broken or
  // their PC is, so each kind has to say which.
  assert.ok(failure.remedy);
  assert.equal(failure.detail, "ECONNREFUSED");
});

test("a TCP refusal is never rendered as evidence that the player's PC is offline", () => {
  const offline = format.browseFailureText({ kind: "no_network" });
  const refused = format.browseFailureText({ kind: "master_unreachable" });
  assert.match(offline.title, /could not reach the network/u);
  // `no_network` is reserved for local routing, address or permission failures. A reset by the
  // remote master is `master_unreachable` — telling a player their internet is down when it is
  // not sends them to fix the wrong thing.
  assert.notEqual(refused.title, offline.title);
  assert.match(refused.remedy, /community/u);
});

test("an unknown failure kind falls back to internal rather than inventing a cause", () => {
  const unknown = format.browseFailureText({ kind: "brand_new_kind", detail: "raw" });
  assert.equal(unknown.title, "The server list could not be built");
  assert.equal(unknown.remedy, null, "no remedy is offered for a cause nobody established");
  assert.equal(unknown.detail, "raw");
});

/* Freshness — locale-dependent, so shape and invariants only ---------------- */

test("the clock label is absolute, and two different minutes read differently", () => {
  const at = new Date("2026-09-19T14:32:00Z");
  // Absolute, not relative: these labels are drawn once and not redrawn on a timer, so a "just
  // now" left on screen goes quietly wrong as the minutes pass.
  assert.equal(format.clockTime(at), format.clockTime(at), "the same instant reads the same");
  assert.notEqual(format.clockTime(at), format.clockTime(new Date("2026-09-19T14:33:00Z")));
  assert.match(format.clockTime(at), /\d/u);
});

test("timeAgo crosses its branches at the documented boundaries", (t) => {
  const now = new Date("2026-09-19T14:32:00Z").getTime();
  t.mock.method(Date, "now", () => now);
  const ago = (seconds) => format.timeAgo(new Date(now - seconds * 1000).toISOString());
  assert.equal(ago(10), "just now");
  assert.equal(ago(89), "just now");
  assert.equal(ago(60 * 5), "5 min ago");
  assert.equal(ago(60 * 60 * 3), "3h ago");
  assert.equal(ago(60 * 60 * 24 * 3), "3d ago");
  // Beyond a week it becomes a date, because "43 days ago" is arithmetic the reader has to undo.
  // The rendering is locale-dependent, so assert only that it left the relative branch.
  const old = ago(60 * 60 * 24 * 43);
  assert.doesNotMatch(old, /ago/u);
});

test("timeAgo invents nothing for a missing or unreadable timestamp", () => {
  assert.equal(format.timeAgo(null), null);
  assert.equal(format.timeAgo(""), null);
  assert.equal(format.timeAgo("not a date"), null);
});

/* The launch line (rule H12) ------------------------------------------------ */

test("history says Launched, never joined or played", () => {
  const label = format.launchedLabel({ launches: 1, lastLaunchedAt: new Date().toISOString() });
  // Reveille starts the game process and sees that it started. Whether the server admitted the
  // player is decided at connect time and Reveille never observes the answer.
  assert.match(label, /^Launched /u);
  assert.doesNotMatch(label, /join|played/iu);
});

test("a repeat launch is counted, and a server never launched has no line", () => {
  const label = format.launchedLabel({ launches: 4, lastLaunchedAt: new Date().toISOString() });
  assert.match(label, /· 4×/u);
  assert.equal(format.launchedLabel({ launches: 0 }), null);
  assert.equal(format.launchedLabel(null), null);
});

test("a launch with no usable timestamp still says how many, not when", () => {
  assert.equal(format.launchedLabel({ launches: 2, lastLaunchedAt: null }), "Launched 2×");
});
