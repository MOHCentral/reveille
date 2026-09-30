// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../fakes/storage.js";
import { preferences, reloadPreferences, setPreference } from "../../ui/lib/preferences.js";
import { roundTrip } from "../../ui/lib/format.js";

test("a fresh install keeps today's alert behaviour, ping colours and quits on close", () => {
  installStorage();
  reloadPreferences();
  assert.deepEqual(preferences(), {
    alertsEnabled: true,
    defaultThreshold: 1,
    cooldownMinutes: 15,
    quietWhilePlaying: false,
    alertSound: true,
    pingGood: 80,
    pingFair: 150,
    refreshOnFocus: true,
    closeToTray: false,
    trayChosen: false,
    trayNoticeShown: false,
    alertsIntroShown: false,
  });
});

test("a setting is saved, survives a restart, and refuses values it does not offer", () => {
  const storage = installStorage();
  reloadPreferences();
  assert.equal(setPreference("cooldownMinutes", 30), true);
  assert.equal(setPreference("cooldownMinutes", 7), false);
  assert.equal(setPreference("unknown", true), false);
  reloadPreferences();
  assert.equal(preferences().cooldownMinutes, 30);
  assert.equal(storage.json("reveille.preferences").cooldownMinutes, 30);
});

test("a corrupt or out-of-range saved value falls back to its default", () => {
  installStorage({ "reveille.preferences": JSON.stringify({ pingGood: 3, alertsEnabled: "yes" }) });
  reloadPreferences();
  assert.equal(preferences().pingGood, 80);
  assert.equal(preferences().alertsEnabled, true);
  installStorage({ "reveille.preferences": "{" });
  reloadPreferences();
  assert.equal(preferences().cooldownMinutes, 15);
});

test("the ping dot follows the bands chosen in Settings", () => {
  installStorage();
  reloadPreferences();
  assert.equal(roundTrip({ status_round_trip: 60 }).band, "good");
  setPreference("pingGood", 50);
  setPreference("pingFair", 120);
  assert.equal(roundTrip({ status_round_trip: 60 }).band, "fair");
  assert.equal(roundTrip({ status_round_trip: 130 }).band, "poor");
  reloadPreferences();
});
