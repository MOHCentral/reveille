// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import {
  catchUpNotice,
  hiddenNotice,
  isStale,
  needsBackgroundWatching,
  trayTooltip,
} from "../../../ui/features/alerts/reach.js";

const prefs = { closeToTray: false, trayChosen: false };

test("watching a server keeps Reveille watching after the window closes, unless the player chose", () => {
  assert.equal(needsBackgroundWatching(prefs, 1), true);
  assert.equal(needsBackgroundWatching(prefs, 0), false);
  assert.equal(needsBackgroundWatching({ ...prefs, closeToTray: true }, 1), false);
  assert.equal(needsBackgroundWatching({ ...prefs, trayChosen: true }, 1), false);
});

test("the tray names what is watched and what is unread", () => {
  assert.equal(trayTooltip(0, 0), "Reveille");
  assert.equal(trayTooltip(1, 0), "Reveille is watching 1 server");
  assert.equal(trayTooltip(3, 2), "Reveille is watching 3 servers · 2 unread alerts");
});

test("the first close says Reveille is still there and how to quit it", () => {
  assert.match(hiddenNotice(2).body, /2 servers/);
  assert.match(hiddenNotice(0).body, /Right-click its icon/);
  assert.equal(hiddenNotice(0).title, "Reveille is still running");
});

const arrival = (hostname, address, count, at) => ({ game: "allied_assault", hostname, address, count, at });

test("what a game held back becomes one summary, newest arrival per server", () => {
  assert.equal(catchUpNotice([]), null);
  assert.deepEqual(catchUpNotice([arrival("Old Bridge", "1.1.1.1:1", 2, 1), arrival("Old Bridge", "1.1.1.1:1", 5, 2)]), {
    title: "While you were playing",
    body: "5 players joined Old Bridge.",
  });
  const many = catchUpNotice([
    arrival("A", "1.1.1.1:1", 2, 1),
    arrival("B", "1.1.1.2:1", 2, 3),
    arrival("C", "1.1.1.3:1", 2, 2),
  ]);
  assert.equal(many.body, "Players joined 3 servers: B, C and 1 more.");
});

test("an alert older than ten minutes is marked as possibly out of date", () => {
  assert.equal(isStale({ at: 0 }, 10 * 60_000), false);
  assert.equal(isStale({ at: 0 }, 10 * 60_000 + 1), true);
});
