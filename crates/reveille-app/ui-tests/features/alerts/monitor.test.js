// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { addPlayerAlert } from "../../../ui/features/alerts/player-alerts.js";
import { nextReading, startPlayerAlertMonitor } from "../../../ui/features/alerts/monitor.js";

const row = {
  address: "127.0.0.1:12203",
  server: { hostname: "Old Bridge", endpoint: { query_port: 12300 } },
};

test("only a measured count below the threshold followed by players alerts", () => {
  let state;
  for (const count of [2, 2, 3]) {
    const result = nextReading(state, count, 1000);
    assert.equal(result.alert, false);
    state = result.state;
  }
  state = nextReading(state, 0, 1000).state;
  const arrival = nextReading(state, 2, 2000);
  assert.equal(arrival.alert, true);
  assert.equal(arrival.toast, true);
  assert.equal(nextReading(arrival.state, 3, 3000).alert, false);
});

test("a server that misses a check or two keeps its last count, so the arrival still alerts", () => {
  let state = nextReading(undefined, 0, 1000).state;
  state = nextReading(state, null, 2000).state;
  state = nextReading(state, null, 3000).state;
  assert.equal(nextReading(state, 3, 4000).alert, true);
});

test("a longer silence forgets the last count rather than guessing an arrival", () => {
  let state = nextReading(undefined, 0, 1000).state;
  for (const at of [2000, 3000, 4000]) state = nextReading(state, null, at).state;
  assert.equal(nextReading(state, 3, 5000).alert, false);
});

test("an arrival inside the cooldown is still an alert, only without a pop-up", () => {
  const first = nextReading(nextReading(undefined, 0, 1000).state, 1, 2000);
  assert.equal(first.toast, true);
  const again = nextReading(nextReading(first.state, 0, 3000).state, 1, 4000);
  assert.equal(again.alert, true);
  assert.equal(again.toast, false);
  assert.equal(again.state.lastAlertAt, 2000);
  const later = nextReading(nextReading(again.state, 0, 5000).state, 1, 902_000);
  assert.equal(later.toast, true);
});

test("each reading records when it was taken, answered or not", () => {
  const first = nextReading(undefined, 2, 1000).state;
  assert.equal(first.count, 2);
  assert.equal(first.checkedAt, 1000);
  assert.equal(first.lastAlertAt, null);
  const unknown = nextReading(first, null, 2000).state;
  assert.equal(unknown.count, null);
  assert.equal(unknown.checkedAt, 2000);
});

test("the monitor asks a silent server once more before counting the check as unanswered", async () => {
  installStorage();
  addPlayerAlert(row, "allied_assault");
  const answers = [null, { clients: 4 }];
  let probes = 0;
  let resolveHeard;
  const heard = new Promise((resolve) => (resolveHeard = resolve));
  const monitor = startPlayerAlertMonitor(
    async () => answers[probes++],
    async () => {},
    (_id, reading) => resolveHeard(reading.count),
  );
  assert.equal(await heard, 4);
  monitor.stop();
  assert.equal(probes, 2);
});

test("the monitor reports every reading so the Watching view can draw it", async () => {
  installStorage();
  addPlayerAlert(row, "allied_assault");
  const heard = [];
  let resolveHeard;
  const done = new Promise((resolve) => (resolveHeard = resolve));
  const monitor = startPlayerAlertMonitor(
    async () => ({ clients: 4, bots: 0, map: "dm/mohdm6", mode: "Team-Match", round_trip: 21 }),
    async () => {},
    (id, reading) => {
      heard.push([id, reading.count]);
      resolveHeard();
    },
  );
  await done;
  monitor.stop();
  assert.deepEqual(heard, [[`allied_assault|${row.address}`, 4]]);
});

test("a watch notifies when players reach its threshold, not on every arrival", () => {
  let state = nextReading(undefined, 2, 1000, 0, 4).state;
  assert.equal(nextReading(state, 3, 2000, 0, 4).alert, false);
  state = nextReading(state, 3, 2000, 0, 4).state;
  const reached = nextReading(state, 5, 3000, 0, 4);
  assert.equal(reached.alert, true);
  assert.equal(nextReading(reached.state, 7, 4000, 0, 4).alert, false);
});
