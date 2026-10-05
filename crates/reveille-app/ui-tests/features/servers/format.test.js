// SPDX-License-Identifier: GPL-3.0-only

// `features/servers/format.js`: non-results, sweep failures and the Map cell.

import test from "node:test";
import assert from "node:assert/strict";

import { browseFailureText, mapNeed, nonResultReason } from "../../../ui/features/servers/format.js";

/* Non-result reasons -------------------------------------------------------- */

test("the stage is part of the reason, not decoration", () => {
  // A timeout answering the master's server-list query and a timeout answering the game query are
  // different failures; labelling both "did not answer" makes one group look like a duplicate.
  assert.equal(
    nonResultReason({ reason: "timeout", stage: "get_status" }),
    "did not answer the game query",
  );
  assert.equal(
    nonResultReason({ reason: "timeout", stage: "inspect" }),
    "did not answer the server-list query",
  );
  assert.equal(
    nonResultReason({ reason: "malformed", stage: "get_status" }),
    "answered the game query with a reply Reveille could not read",
  );
  assert.equal(
    nonResultReason({ reason: "duplicate_endpoint" }),
    "is the same server registered twice",
  );
  assert.equal(
    nonResultReason({ reason: "missing_host_port" }),
    "did not publish a game port",
  );
});

test("an unrecognised reason shows itself rather than borrowing another cause", () => {
  // Rule H6: never state a cause that was not observed. An unknown kind must not be quietly
  // filed under one of the known sentences.
  assert.equal(
    nonResultReason({ reason: "something_new", stage: "get_status" }),
    "something_new at the game query",
  );
});

/* Sweep failures (rule H6) -------------------------------------------------- */

test("each sweep failure carries a cause and a remedy, and keeps the original message", () => {
  const failure = browseFailureText({ kind: "master_unreachable", detail: "ECONNREFUSED" });
  assert.match(failure.title, /master server/u);
  // These two moments are where a non-technical player decides whether the tool is broken or
  // their PC is, so each kind has to say which.
  assert.ok(failure.remedy);
  assert.equal(failure.detail, "ECONNREFUSED");
});

test("a TCP refusal is never rendered as evidence that the player's PC is offline", () => {
  const offline = browseFailureText({ kind: "no_network" });
  const refused = browseFailureText({ kind: "master_unreachable" });
  assert.match(offline.title, /could not reach the network/u);
  // `no_network` is reserved for local routing, address or permission failures. A reset by the
  // remote master is `master_unreachable` — telling a player their internet is down when it is
  // not sends them to fix the wrong thing.
  assert.notEqual(refused.title, offline.title);
  assert.match(refused.remedy, /community/u);
});

test("an unknown failure kind falls back to internal rather than inventing a cause", () => {
  const unknown = browseFailureText({ kind: "brand_new_kind", detail: "raw" });
  assert.equal(unknown.title, "The server list could not be built");
  assert.equal(unknown.remedy, null, "no remedy is offered for a cause nobody established");
  assert.equal(unknown.detail, "raw");
});

test("a saved folder or engine that no longer fits sends the player to change it", () => {
  for (const kind of ["game_unavailable", "engine_unavailable"]) {
    assert.match(browseFailureText({ kind }).remedy, /Change folder or engine/u, kind);
  }
  assert.ok(browseFailureText({ kind: "maps_unreadable" }).remedy);
});

/* The Map cell -------------------------------------------------------------- */

test("the map cell counts the maps a server needs and says nothing otherwise", () => {
  assert.equal(mapNeed({ state: "compatible" }), null);
  assert.equal(mapNeed({ state: "cant_tell" }), null);
  assert.deepEqual(
    { ...mapNeed({ state: "needs_maps", count: 3 }), title: undefined },
    { kind: "download", text: "3", title: undefined },
  );
  assert.equal(mapNeed({ state: "no_source", count: 1 }).kind, "missing");
});
