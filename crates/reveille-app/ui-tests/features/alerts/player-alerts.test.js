// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import {
  addPlayerAlert,
  hasPlayerAlert,
  playerAlerts,
  playerAlert,
  removePlayerAlert,
  setAlertThreshold,
} from "../../../ui/features/alerts/player-alerts.js";

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

test("corrupt or unusable persisted entries cannot become monitoring targets", () => {
  installStorage({ "reveille.player-alerts": JSON.stringify([
    { game: "allied_assault", address: row.address, queryPort: 12300 },
    { game: "allied_assault", address: "not-an-endpoint", queryPort: 12300 },
    { game: "unknown", address: row.address, queryPort: 12300 },
  ]) });
  assert.equal(playerAlerts().length, 1);
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
