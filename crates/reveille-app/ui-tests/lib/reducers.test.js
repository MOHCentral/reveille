// SPDX-License-Identifier: GPL-3.0-only

// The list reducers, and the sweep's live-region cadence.
//
// These four behaviours used to be guarded only by Rust tests that read `app.js` and
// `views/servers.js` as text with `include_str!` and `contains` — which held the exact line that
// had regressed once, and nothing else. They are now ordinary functions in `lib/store.js` and
// `lib/format.js`, and what follows asserts the behaviour instead of the spelling (issue #12).
//
// They moved rather than being reimplemented: `rememberReadyJoin` is the same function, and
// `applyCheckedRow`/`applyCheckNonResult` are the two branches that were inline in `check`'s
// `update` callback. `app.js` still owns the async sequencing around them — the generation guard
// that stops one check cancelling another, and `resettle` — because that part genuinely cannot run
// outside the shell.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../fakes/storage.js";

installStorage();
const store = await import("../../ui/lib/store.js");
const { sweepProgressText } = await import("../../ui/lib/format.js");

function row(address, extra = {}) {
  return {
    address,
    server: {
      hostname: extra.hostname ?? address,
      occupancy: { clients_reported: extra.clients ?? 4, bots_reported: 0 },
      status_round_trip: 50,
      current_map: "dm/mohdm1",
      endpoint: { query_port: extra.queryPort ?? 12300 },
    },
    compatibility: extra.compatibility ?? { state: { state: "needs_maps", count: 2 } },
  };
}

/** A fresh state object shaped like the store's, for a reducer to act on. */
function draft(servers = []) {
  return {
    servers,
    checks: new Map(),
    checkedAt: new Map(),
    preview: { address: "x" },
    previewProgress: { index: 1, of: 4 },
    previewError: "stale",
    choices: new Map([["dm/a", 7]]),
  };
}

/* A check that got no answer drops the row (rule H12) ----------------------- */

test("a check that got no answer drops the row it was checking", () => {
  const next = draft([row("gone:1"), row("other:1")]);
  next.checkedAt.set("gone:1", "14:32");

  store.applyCheckNonResult(next, { address: "gone:1", queryPort: 12300 }, { non_result: "timeout" }, {
    hostname: "Gone",
    queryPort: 12300,
  });

  // The check that just ran is evidence about now; the figures it replaces have been shown not to
  // be. Leaving the row standing would present a measurement the check disproved.
  assert.deepEqual(next.servers.map((r) => r.address), ["other:1"]);
  // And its freshness stamp goes too — a "Checked at 14:32" for a row that is gone is a claim
  // about a measurement that no longer exists.
  assert.equal(next.checkedAt.has("gone:1"), false);
});

test("the dropped row's name survives so the pane can say what the check was about", () => {
  const next = draft([row("gone:1", { hostname: "Sniper Only" })]);
  store.applyCheckNonResult(
    next,
    { address: "gone:1", queryPort: 12300 },
    { non_result: "timeout" },
    { hostname: "Sniper Only", queryPort: 12300 },
  );
  const check = next.checks.get("gone:1");
  assert.equal(check.status, "absent");
  assert.equal(check.dropped.hostname, "Sniper Only");
  assert.equal(check.nonResult, "timeout");
});

test("a check carries forward what it knows about a row already dropped", () => {
  store.state.servers = [];
  store.state.checks = new Map([
    ["gone:1", { status: "absent", dropped: { hostname: "Remembered", queryPort: 12300 } }],
  ]);
  // The second check of an address the first one dropped has no row to read a name from. Losing
  // it would leave the pane asking for this check unable to name what it is about.
  assert.deepEqual(store.droppedIdentity({ address: "gone:1", queryPort: 12300 }), {
    hostname: "Remembered",
    queryPort: 12300,
  });
});

test("a check of a listed row takes the identity from the row", () => {
  store.state.servers = [row("here:1", { hostname: "Live name" })];
  store.state.checks = new Map();
  assert.deepEqual(store.droppedIdentity({ address: "here:1", queryPort: 12300 }), {
    hostname: "Live name",
    queryPort: 12300,
  });
});

test("an address never seen has no identity to carry, and that is not an error", () => {
  store.state.servers = [];
  store.state.checks = new Map();
  assert.equal(store.droppedIdentity({ address: "new:1", queryPort: 12300 }), null);
});

/* A check that answered ------------------------------------------------------*/

test("an answering check replaces the row and stamps when it was measured", () => {
  const next = draft([row("here:1", { clients: 0 })]);
  const fresh = row("here:1", { clients: 9 });

  store.applyCheckedRow(next, { address: "here:1" }, { row: fresh }, null, "14:32");

  assert.equal(next.servers.length, 1);
  assert.equal(next.servers[0].server.occupancy.clients_reported, 9);
  // The pane words a re-checked row differently from one the sweep returned, because a sweep's
  // finish time is not when any particular row inside it answered.
  assert.equal(next.checkedAt.get("here:1"), "14:32");
  assert.equal(next.checks.has("here:1"), false, "a clean answer clears the check entry");
});

test("a server that moved is listed once, not twice", () => {
  const next = draft([row("old:1")]);
  const moved = row("new:1");

  store.applyCheckedRow(next, { address: "old:1" }, { row: moved }, null, "14:32");

  // Filtering only the answering address would leave the server listed twice, once with its old
  // figures — which is exactly the stale reading H12 forbids.
  assert.deepEqual(next.servers.map((r) => r.address), ["new:1"]);
  // The old address keeps an entry saying where the answer came from, so a star or a selection
  // pointing at it can explain itself.
  assert.deepEqual(next.checks.get("old:1"), {
    status: "absent",
    movedTo: "new:1",
    dropped: null,
  });
});

test("a moved server does not inherit the old address's freshness stamp", () => {
  const next = draft([row("old:1")]);
  next.checkedAt.set("old:1", "13:00");
  store.applyCheckedRow(next, { address: "old:1" }, { row: row("new:1") }, null, "14:32");
  assert.equal(next.checkedAt.has("old:1"), false);
  assert.equal(next.checkedAt.get("new:1"), "14:32");
});

/* A clean join refreshes the row it was launched from ---------------------- */

const CLEAN = {
  outcome: { launch: "launched" },
  assessment: { state: { state: "compatible" } },
  failures: [],
};

test("a clean join replaces the row's stale pre-download assessment", () => {
  const stale = row("a:1", { compatibility: { state: { state: "needs_maps", count: 2 } } });
  const next = draft([stale]);

  store.rememberReadyJoin(next, stale, CLEAN);

  // The row was measured before its downloads. Leaving it that way makes selecting another server
  // and returning start a new preview for maps Reveille has just installed, disabling Join while
  // the manifest and catalogue are queried again.
  assert.deepEqual(next.servers[0].compatibility, CLEAN.assessment);
  assert.equal(next.preview, null);
  assert.equal(next.previewProgress, null);
  assert.equal(next.previewError, null);
  assert.equal(next.choices.size, 0);
});

test("a join with a failed package leaves the old question in place", () => {
  const stale = row("a:1");
  const before = stale.compatibility;
  const next = draft([stale]);

  store.rememberReadyJoin(next, stale, {
    ...CLEAN,
    failures: [{ map: "Server download list", reason: "404" }],
  });

  // Any failed server package must leave the question standing, so selecting the row retries it
  // rather than presenting a clean state the install did not actually reach.
  assert.deepEqual(next.servers[0].compatibility, before);
  assert.notEqual(next.preview, null, "the preview is not cleared either");
});

test("a refused join and an incompatible one remember nothing", () => {
  for (const result of [
    { ...CLEAN, outcome: { launch: "refused", reason: "current map missing" } },
    { ...CLEAN, assessment: { state: { state: "cant_tell" } } },
  ]) {
    const stale = row("a:1");
    const before = stale.compatibility;
    const next = draft([stale]);
    store.rememberReadyJoin(next, stale, result);
    assert.deepEqual(next.servers[0].compatibility, before);
  }
});

/* Sweep progress is announced at milestones, not per probe ------------------ */

test("sweep progress is announced at quarters rather than once per probe", () => {
  // The sweep emits one event per probed endpoint. A region restating "N of M done" fired roughly
  // two hundred announcements per sweep, which is a denial of service against the one output a
  // blind player has.
  const said = new Set();
  for (let probed = 0; probed <= 200; probed += 1) {
    said.add(sweepProgressText({ probed, inspected: 200 }));
  }
  assert.equal(said.size, 4, "start plus three milestones, over two hundred probes");
});

test("the milestone sentences carry no running count", () => {
  const milestones = [50, 100, 150, 200].map((probed) =>
    sweepProgressText({ probed, inspected: 200 }),
  );
  for (const sentence of milestones) {
    // A running total inside the sentence would make the string differ on every probe and defeat
    // the whole point of the milestone.
    assert.doesNotMatch(sentence, /\d/u, sentence);
  }
  assert.deepEqual(milestones, [
    "A quarter of the servers checked.",
    "Half of the servers checked.",
    "Three quarters of the servers checked.",
    "Three quarters of the servers checked.",
  ]);
});

test("the sweep says what it is doing before it knows how much there is", () => {
  // Indeterminate only during the master handshake, where nothing is known yet.
  assert.equal(
    sweepProgressText({ probed: 0, inspected: 0 }),
    "Getting the server list. Contacting the master server.",
  );
  assert.equal(sweepProgressText({ probed: 0, inspected: 190 }), "Checking 190 servers.");
});
