// SPDX-License-Identifier: GPL-3.0-only

// `features/alerts/index.js`: what the server list and the join pane read of player alerts.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { state } from "../../../ui/lib/store.js";
import {
  playerAlert,
  setAlertThreshold,
  watchedAddresses,
  watchedEntries,
  watchedLine,
} from "../../../ui/features/alerts/index.js";
import { addPlayerAlert } from "../../../ui/features/alerts/player-alerts.js";

const row = (address, queryPort) => ({ address, server: { hostname: address, endpoint: { query_port: queryPort } } });

test("the Watching scope lists only the watches of the game being browsed", () => {
  installStorage();
  addPlayerAlert(row("10.0.0.1:12203", 12300), "allied_assault");
  addPlayerAlert(row("10.0.0.2:12203", 12300), "spearhead");
  state.game = "allied_assault";
  assert.deepEqual([...watchedAddresses()], ["10.0.0.1:12203"]);
  assert.deepEqual(watchedEntries().map((entry) => entry.address), ["10.0.0.1:12203"]);
  state.game = "spearhead";
  assert.deepEqual([...watchedAddresses()], ["10.0.0.2:12203"]);
});

test("a watched row's line joins the last reading, the last alert in this game and its rule", () => {
  installStorage();
  state.game = "allied_assault";
  const address = "10.0.0.1:12203";
  addPlayerAlert(row(address, 12300), "allied_assault");
  state.watchReadings = new Map();
  assert.equal(watchedLine(address, new Map()), "Not checked yet");

  setAlertThreshold("allied_assault", address, 4);
  state.watchReadings.set(`allied_assault|${address}`, { count: 0, checkedAt: null });
  const alerted = new Map([[`spearhead|${address}`, Date.now()]]);
  assert.equal(watchedLine(address, alerted), "No players · notify at 4+", "another game's alert is not this one's");
  assert.equal(playerAlert("allied_assault", address).threshold, 4);
});
