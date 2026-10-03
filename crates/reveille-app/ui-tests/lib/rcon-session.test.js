// SPDX-License-Identifier: GPL-3.0-only

// `lib/rcon-session.js`: what the remote console keeps in memory, and how it words an answer.
//
// The module's one structural rule is that it never writes anywhere. The first test enforces it
// from the outside: it hands the module a storage that fails the test on any access.

import test from "node:test";
import assert from "node:assert/strict";

const tripwire = {
  getItem: () => assert.fail("rcon-session read storage"),
  setItem: () => assert.fail("rcon-session wrote storage"),
  removeItem: () => assert.fail("rcon-session wrote storage"),
};
globalThis.localStorage = tripwire;
globalThis.sessionStorage = tripwire;

const { createRconMemory, describeOutcome, describePasswordNote, isSafeMapName, playerLabel } = await import("../../ui/lib/rcon-session.js");

/* Memory --------------------------------------------------------------------*/

test("history walks back through commands and returns to an empty line", () => {
  const memory = createRconMemory();
  for (const command of ["status", "serverinfo", "map dm/mohdm1"]) memory.remember(command);

  let step = memory.step(null, -1);
  assert.deepEqual(step, { cursor: 2, text: "map dm/mohdm1" });
  step = memory.step(step.cursor, -1);
  assert.deepEqual(step, { cursor: 1, text: "serverinfo" });
  step = memory.step(step.cursor, -1);
  step = memory.step(step.cursor, -1);
  assert.deepEqual(step, { cursor: 0, text: "status" }, "the oldest entry is a wall, not a wrap");

  step = memory.step(step.cursor, 1);
  step = memory.step(step.cursor, 1);
  assert.deepEqual(step, { cursor: 2, text: "map dm/mohdm1" });
  assert.deepEqual(memory.step(step.cursor, 1), { cursor: null, text: "" });
});

test("stepping with nothing to step through changes nothing", () => {
  const memory = createRconMemory();

  assert.deepEqual(memory.step(null, -1), { cursor: null, text: null });
  assert.deepEqual(memory.step(null, 1), { cursor: null, text: null });
});

test("a repeated command is one history entry, and the history is bounded", () => {
  const memory = createRconMemory();
  memory.remember("status");
  memory.remember("status");
  assert.deepEqual(memory.step(null, -1), { cursor: 0, text: "status" });

  for (let index = 0; index < 120; index += 1) memory.remember(`say ${index}`);
  let step = { cursor: null };
  let seen = 0;
  while (true) {
    const next = memory.step(step.cursor, -1);
    if (next.cursor === step.cursor) break;
    step = next;
    seen += 1;
  }
  assert.equal(seen, 50);
  assert.equal(step.text, "say 70", "the oldest entries are the ones dropped");
});

/* Wording -------------------------------------------------------------------*/

const reply = (fields) => ({
  status: "reply",
  output: "",
  verdict: "executed",
  packets: 1,
  truncated: false,
  round_trip: 30,
  ...fields,
});

test("what the server printed is shown as it printed it, minus trailing blank space", () => {
  const described = describeOutcome(reply({ output: "map: mohdm1\nnum score ping\n\n" }));

  assert.deepEqual(described, {
    tone: "output",
    text: "map: mohdm1\nnum score ping",
    password: "accepted",
  });
});

test("a command that ran and printed nothing says so, and still proves the password", () => {
  const described = describeOutcome(reply({ output: "" }));

  assert.equal(described.text, "(no output)");
  assert.equal(described.password, "accepted");
});

test("cut output says it was cut", () => {
  const described = describeOutcome(reply({ output: "a\nb\n", truncated: true }));

  assert.match(described.text, /^a\nb\n… The server printed more/u);
});

test("a refused password is an error that tells the console to drop the password", () => {
  for (const verdict of ["wrong_password", "password_not_set"]) {
    const described = describeOutcome(reply({ verdict, output: "Bad rconpassword.\n" }));

    assert.equal(described.tone, "error", verdict);
    assert.equal(described.password, "rejected", verdict);
    assert.doesNotMatch(described.text, /Bad rconpassword/u, "it is worded here, not echoed");
  }
});

test("a server that has no rcon password is told apart from one that rejected ours", () => {
  const none = describeOutcome(reply({ verdict: "password_not_set" }));
  const wrong = describeOutcome(reply({ verdict: "wrong_password" }));

  assert.match(none.text, /no rcon password/u);
  assert.match(wrong.text, /refused the password/u);
});

test("silence proves nothing about the password and says the command may have run", () => {
  const described = describeOutcome({ status: "no_answer" });

  assert.equal(described.tone, "notice");
  assert.equal(described.password, "unknown");
  assert.match(described.text, /may still have run/u);
});

test("a refusal from the Rust side becomes a sentence", () => {
  assert.equal(
    describeOutcome({ status: "refused", reason: "the command is empty" }).text,
    "The command is empty.",
  );
  assert.equal(
    describeOutcome({ status: "refused", reason: "Already a sentence." }).text,
    "Already a sentence.",
  );
});

test("a network failure carries the system's words", () => {
  const described = describeOutcome({ status: "failed", detail: "network is unreachable" });

  assert.equal(described.text, "The network failed: network is unreachable.");
  assert.equal(described.password, "unknown");
});

test("an answer the console does not recognise is an error, never a silent success", () => {
  for (const odd of [null, undefined, {}, { status: "something_new" }]) {
    const described = describeOutcome(odd);

    assert.equal(described.tone, "error");
    assert.equal(described.password, "unknown");
  }
});

test("a password note is worded, and no change says nothing", () => {
  assert.match(describePasswordNote("saved"), /saved/i);
  assert.match(describePasswordNote("not_saved"), /would not keep/i);
  assert.match(describePasswordNote("forgotten"), /removed/i);
  assert.equal(describePasswordNote("unchanged"), null);
  assert.equal(describePasswordNote(undefined), null);
});

test("only names a server could list are accepted as maps", () => {
  assert.equal(isSafeMapName("dm/mohdm1"), true);
  assert.equal(isSafeMapName("obj/obj_team1-v2"), true);
  assert.equal(isSafeMapName("dm/mohdm1; quit"), false);
  assert.equal(isSafeMapName("../x"), false);
  assert.equal(isSafeMapName("a//b"), false);
  assert.equal(isSafeMapName(""), false);
  assert.equal(isSafeMapName("a".repeat(64)), false);
});

test("a player is labelled by slot, name, ping and any half-connected state", () => {
  assert.equal(playerLabel({ slot: 3, name: "Goat", ping: 42, state: "playing" }), "#3 Goat · 42 ms");
  assert.equal(playerLabel({ slot: 4, name: "Raven", ping: null, state: "connecting" }), "#4 Raven · connecting");
  assert.equal(playerLabel({ slot: 5, name: "", ping: null, state: "zombie" }), "#5 (no name) · dropping");
});
