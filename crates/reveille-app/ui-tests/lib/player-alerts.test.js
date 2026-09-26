// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../fakes/storage.js";
import {
  addPlayerAlert,
  hasPlayerAlert,
  nextReading,
  playerAlerts,
  removePlayerAlert,
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
    game: "allied_assault", address: row.address, hostname: "Old Bridge", queryPort: 12300,
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
