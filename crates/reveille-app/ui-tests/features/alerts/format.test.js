// SPDX-License-Identifier: GPL-3.0-only

// `features/alerts/format.js`: the watch line and the toast detail.

import test from "node:test";
import assert from "node:assert/strict";

import { alertDetail, watchLine } from "../../../ui/features/alerts/format.js";

test("the watch line says what the monitor last saw and when it last alerted", () => {
  const now = Date.now();
  assert.equal(watchLine(null, null), "Not checked yet");
  assert.equal(watchLine({ count: 3, checkedAt: now }, null), "3 players just now");
  assert.equal(watchLine({ count: 0, checkedAt: now }, null), "No players just now");
  assert.equal(watchLine({ count: null, checkedAt: now - 5 * 60_000 }, null), "No answer 5 min ago");
  assert.equal(
    watchLine({ count: 1, checkedAt: now }, now - 2 * 3_600_000),
    "1 player just now · alerted 2h ago",
  );
});

test("a toast's second line names the round players arrived for", () => {
  assert.equal(
    alertDetail({ clients: 4, map: "dm/mohdm6", mode: "Team-Match", round_trip: 21 }),
    "dm/mohdm6 · Team-Match · 21 ms",
  );
  assert.equal(alertDetail({ clients: 4, map: null, mode: null, round_trip: 30 }), "30 ms");
  assert.equal(alertDetail(null), null);
});

test("the watch line states a threshold above one", () => {
  assert.equal(watchLine({ count: 2, checkedAt: Date.now() }, null, 4), "2 players just now · notify at 4+");
  assert.equal(watchLine(null, null, 1), "Not checked yet");
});
