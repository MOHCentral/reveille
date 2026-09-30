// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import {
  LIFETIME_MS,
  addCard,
  cardTitle,
  expired,
  hiddenCount,
  removeCard,
  resume,
  revealed,
} from "../../ui/lib/popup-stack.js";

const card = (eventId, address = eventId, count = 1) => ({
  eventId,
  game: "aa",
  address,
  hostname: `Server ${address}`,
  count,
});

test("the newest alert comes first", () => {
  const stack = addCard(addCard([], card("a"), 0), card("b"), 1);
  assert.deepEqual(stack.map((shown) => shown.eventId), ["b", "a"]);
});

test("a second alert for a server replaces its card and restarts its time", () => {
  let stack = addCard([], card("a", "1.2.3.4"), 0);
  stack = addCard(stack, card("b", "5.6.7.8"), 0);
  stack = addCard(stack, card("c", "1.2.3.4", 3), 5_000);
  assert.deepEqual(stack.map((shown) => shown.eventId), ["c", "b"]);
  assert.equal(stack[0].leavesAt, 5_000 + LIFETIME_MS);
});

test("only shown cards leave on their own", () => {
  let stack = [];
  for (const id of ["a", "b", "c", "d"]) stack = addCard(stack, card(id), 0);
  assert.equal(hiddenCount(stack), 1);
  assert.deepEqual(expired(stack, LIFETIME_MS).map((shown) => shown.eventId), ["d", "c", "b"]);
});

test("a card moving up from behind +N more gets its full time", () => {
  let stack = [];
  for (const id of ["a", "b", "c", "d"]) stack = addCard(stack, card(id), 0);
  const after = revealed(removeCard(stack, "d"), stack, 20_000);
  assert.equal(after.find((shown) => shown.eventId === "a").leavesAt, 20_000 + LIFETIME_MS);
  assert.equal(after.find((shown) => shown.eventId === "b").leavesAt, LIFETIME_MS);
});

test("time spent hovering is given back", () => {
  const stack = resume(addCard([], card("a"), 0), 3_000);
  assert.deepEqual(expired(stack, LIFETIME_MS), []);
  assert.equal(expired(stack, LIFETIME_MS + 3_000).length, 1);
});

test("the headline counts players", () => {
  assert.equal(cardTitle(card("a", "x", 1)), "1 player on Server x");
  assert.equal(cardTitle(card("a", "x", 2)), "2 players on Server x");
});
