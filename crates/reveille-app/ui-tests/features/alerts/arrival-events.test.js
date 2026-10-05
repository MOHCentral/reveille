// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import {
  arrivalById,
  arrivalEvents,
  clearArrivals,
  lastArrivals,
  markArrivalsRead,
  recordArrival,
  unreadArrivalCount,
} from "../../../ui/features/alerts/arrival-events.js";

const server = {
  game: "allied_assault",
  address: "127.0.0.1:12203",
  queryPort: 12300,
  hostname: "Old Bridge",
};

test("arrivals survive reopening, remain independent of watched servers, and mark as read", () => {
  const storage = installStorage();
  const event = recordArrival(server, 1, 1000);
  assert.equal(event.game, "allied_assault");
  assert.equal(unreadArrivalCount(), 1);
  assert.equal(arrivalById(event.id).address, server.address);
  assert.equal(storage.raw("reveille.player-alerts"), null);
  markArrivalsRead();
  assert.equal(unreadArrivalCount(), 0);
  assert.equal(arrivalEvents()[0].at, 1000);
});

test("history keeps the newest 50 events and ignores malformed saved data", () => {
  installStorage();
  for (let i = 0; i < 52; i += 1) recordArrival(server, i + 1, i);
  assert.equal(arrivalEvents().length, 50);
  assert.equal(arrivalEvents()[0].count, 52);
  assert.equal(arrivalEvents().at(-1).count, 3);
  installStorage({ "reveille.arrival-events": "{bad" });
  assert.deepEqual(arrivalEvents(), []);
});

test("clearing empties the bell and its unread count", () => {
  installStorage();
  recordArrival(server, 2, 1000);
  recordArrival(server, 3, 2000);
  clearArrivals();
  assert.deepEqual(arrivalEvents(), []);
  assert.equal(unreadArrivalCount(), 0);
  assert.equal(lastArrivals().size, 0);
});
