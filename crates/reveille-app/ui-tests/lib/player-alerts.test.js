// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../fakes/storage.js";
import {
  addPlayerAlert,
  hasPlayerAlert,
  nextReading,
  playerAlerts,
  playerAlert,
  removePlayerAlert,
  setAlertThreshold,
  startPlayerAlertMonitor,
} from "../../ui/lib/player-alerts.js";

const row = {
  address: "127.0.0.1:12203",
  server: { hostname: "Old Bridge", endpoint: { query_port: 12300 } },
};

test("an alert belongs to its own server and game, independent of favorites", () => {
  const storage = installStorage();
  assert.equal(addPlayerAlert(row, "allied_assault"), true);
  assert.equal(hasPlayerAlert("allied_assault", row.address), true);
  assert.equal(hasPlayerAlert("spearhead", row.address), false);
  assert.deepEqual(playerAlerts(), [{
    game: "allied_assault", address: row.address, hostname: "Old Bridge", queryPort: 12300, threshold: 1,
  }]);
  assert.equal(storage.raw("reveille.bookmarks"), null);
  removePlayerAlert("allied_assault", row.address);
  assert.deepEqual(playerAlerts(), []);
});

test("only a measured zero followed by players alerts; unknown breaks continuity", () => {
  let state;
  for (const count of [2, 0, null, 1, 2, 0]) {
    const result = nextReading(state, count, 1000);
    assert.equal(result.alert, false);
    state = result.state;
  }
  const arrival = nextReading(state, 2, 2000);
  assert.equal(arrival.alert, true);
  assert.equal(nextReading(arrival.state, 3, 3000).alert, false);
  assert.equal(nextReading(nextReading(arrival.state, 0, 4000).state, 1, 5000).alert, false);
  assert.equal(nextReading(nextReading(arrival.state, 0, 4000).state, 1, 902_000).alert, true);
});

test("corrupt or unusable persisted entries cannot become monitoring targets", () => {
  installStorage({ "reveille.player-alerts": JSON.stringify([
    { game: "allied_assault", address: row.address, queryPort: 12300 },
    { game: "allied_assault", address: "not-an-endpoint", queryPort: 12300 },
    { game: "unknown", address: row.address, queryPort: 12300 },
  ]) });
  assert.equal(playerAlerts().length, 1);
});

test("each reading records when it was taken, answered or not", () => {
  const first = nextReading(undefined, 2, 1000).state;
  assert.deepEqual(first, { count: 2, checkedAt: 1000, lastAlertAt: null });
  const unknown = nextReading(first, null, 2000).state;
  assert.equal(unknown.count, null);
  assert.equal(unknown.checkedAt, 2000);
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

test("a saved watch without a threshold, or with an unknown one, waits for one player", () => {
  installStorage({ "reveille.player-alerts": JSON.stringify([
    { game: "allied_assault", address: row.address, queryPort: 12300 },
    { game: "allied_assault", address: "127.0.0.1:12204", queryPort: 12301, threshold: 7 },
  ]) });
  assert.deepEqual(playerAlerts().map((entry) => entry.threshold), [1, 1]);
  assert.equal(setAlertThreshold("allied_assault", row.address, 8), true);
  assert.equal(playerAlert("allied_assault", row.address).threshold, 8);
  assert.equal(setAlertThreshold("allied_assault", row.address, 5), false);
  assert.equal(playerAlert("allied_assault", row.address).threshold, 8);
});

test("a new watch keeps the threshold it was given", () => {
  installStorage();
  addPlayerAlert(row, "allied_assault", 4);
  assert.equal(playerAlert("allied_assault", row.address).threshold, 4);
});
