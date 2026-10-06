// SPDX-License-Identifier: GPL-3.0-only

// `lib/session.js`: the remembered setup, the session identity, and the generations.
//
// The migration test here is the one that used to live inside `tools/check-sources.mjs`, which had
// grown two behavioural assertions because there was nowhere else to put them. There is now.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage, installBrokenStorage } from "../fakes/storage.js";

installStorage();
const { state } = await import("../../ui/lib/store.js");
const session = await import("../../ui/lib/session.js");

function reset(seed = {}) {
  const storage = installStorage(seed);
  state.install = null;
  state.engine = null;
  state.game = "allied_assault";
  state.listSession = null;
  return storage;
}

/* Storage keys ----------------------------------------------------------------*/

test("the remembered setup is read from the keys earlier releases wrote", () => {
  assert.deepEqual(
    { ...session.STORAGE_KEYS },
    { install: "reveille.install", engines: "reveille.engines", games: "reveille.games" },
  );
  reset({
    "reveille.install": "C:/Game",
    "reveille.engines": JSON.stringify({ "C:/Game": "reborn" }),
    "reveille.games": JSON.stringify({ "C:/Game": "spearhead" }),
  });
  assert.equal(session.recallInstall(), "C:/Game");
  assert.equal(session.recallEngine("C:/Game"), "reborn");
  assert.equal(session.recallGame("C:/Game"), "spearhead");
});

test("a remembered choice is written where the next run reads it", () => {
  const storage = reset();
  session.rememberInstall("C:/Game");
  session.rememberEngine("C:/Game", "openmohaa");
  session.rememberGame("C:/Game", "breakthrough");
  assert.equal(storage.raw("reveille.install"), "C:/Game");
  assert.deepEqual(storage.json("reveille.engines"), { "C:/Game": "openmohaa" });
  assert.deepEqual(storage.json("reveille.games"), { "C:/Game": "breakthrough" });
});

/* The protected-install copy ------------------------------------------------ */

test("the installation copy moves the root, engine and game together", () => {
  const storage = reset({
    "reveille.install": String.raw`C:\Program Files\MOHAA`,
    "reveille.engines": JSON.stringify({
      [String.raw`C:\Program Files\MOHAA`]: "reborn",
      [String.raw`D:\Keep`]: "original",
    }),
    "reveille.games": JSON.stringify({
      [String.raw`C:\Program Files\MOHAA`]: "spearhead",
      [String.raw`D:\Keep`]: "breakthrough",
    }),
  });

  session.migrateInstallationPreferences(
    String.raw`C:\Program Files\MOHAA`,
    String.raw`C:\Users\Player\Games\MOHAA`,
    "reborn",
    "spearhead",
  );

  const engines = storage.json("reveille.engines");
  const games = storage.json("reveille.games");

  assert.equal(storage.raw("reveille.install"), String.raw`C:\Users\Player\Games\MOHAA`);
  assert.equal(engines[String.raw`C:\Users\Player\Games\MOHAA`], "reborn");
  assert.equal(games[String.raw`C:\Users\Player\Games\MOHAA`], "spearhead");

  // The whole point of "as one transaction": the old root must not be left behind pointing at a
  // folder the player was moved out of.
  assert.ok(!(String.raw`C:\Program Files\MOHAA` in engines));
  assert.ok(!(String.raw`C:\Program Files\MOHAA` in games));

  // And an unrelated installation is not collateral damage.
  assert.equal(engines[String.raw`D:\Keep`], "original");
  assert.equal(games[String.raw`D:\Keep`], "breakthrough");
});

test("a migration survives storage that refuses to be written", () => {
  reset();
  installBrokenStorage();
  // The comment in session.js says a launcher that cannot persist a preference still works. Assert
  // it rather than trust it: this must not throw into the setup flow.
  assert.doesNotThrow(() =>
    session.migrateInstallationPreferences("old", "new", "openmohaa", "spearhead"),
  );
  installStorage();
});

/* Remembered engine and game ------------------------------------------------ */

test("an engine or game the enum does not contain is not recalled", () => {
  reset({
    "reveille.engines": JSON.stringify({ "C:/Game": "quake" }),
    "reveille.games": JSON.stringify({ "C:/Game": "wolfenstein" }),
  });
  assert.equal(session.recallEngine("C:/Game"), null);
  assert.equal(session.recallGame("C:/Game"), null);
});

test("defaultGame prefers the remembered game only while the install can still run it", () => {
  reset({ "reveille.games": JSON.stringify({ "C:/Game": "breakthrough" }) });
  const install = { root: "C:/Game", playable: ["allied_assault", "breakthrough"] };
  assert.equal(session.defaultGame(install), "breakthrough");

  // The expansion's data is gone. Opening on a game the folder cannot serve would be a session
  // that fails on its first command, so the remembered choice is dropped rather than honoured.
  assert.equal(session.defaultGame({ root: "C:/Game", playable: ["allied_assault"] }), "allied_assault");
  assert.equal(session.defaultGame({ root: "C:/Game", playable: [] }), "allied_assault");
});

/* The session the list was swept for (H12) ---------------------------------- */

test("the list belongs to the session only when the folder, engine and game all still match", () => {
  reset();
  state.install = { root: "C:/Game", playable: ["allied_assault"] };
  state.engine = "openmohaa";
  state.game = "allied_assault";
  state.listSession = { path: "C:/Game", engine: "openmohaa", game: "allied_assault" };
  assert.equal(session.listIsForCurrentSession(), true);

  // All three facts count. The game decides which master registration was asked and so which
  // servers exist at all; the folder and engine decide the search path every row's compatibility
  // was judged against. Leaving Spearhead's rows on screen under Allied Assault would be the same
  // false currency as a bookmark's old figures (rule H12).
  for (const change of [
    () => (state.game = "spearhead"),
    () => (state.engine = "reborn"),
    () => (state.install = { root: "D:/Other", playable: ["allied_assault"] }),
  ]) {
    reset();
    state.install = { root: "C:/Game", playable: ["allied_assault"] };
    state.engine = "openmohaa";
    state.game = "allied_assault";
    state.listSession = { path: "C:/Game", engine: "openmohaa", game: "allied_assault" };
    change();
    assert.equal(session.listIsForCurrentSession(), false);
  }
});

test("a list with no sweep behind it belongs to no session", () => {
  reset();
  state.install = { root: "C:/Game", playable: ["allied_assault"] };
  assert.equal(session.listIsForCurrentSession(), false);
});

/* Generations ---------------------------------------------------------------*/

test("a newer selection makes an earlier preview stale", () => {
  const first = session.generations.preview.next();
  assert.equal(session.generations.preview.isCurrent(first), true);
  const second = session.generations.preview.next();
  assert.equal(session.generations.preview.isCurrent(first), false);
  assert.equal(session.generations.preview.isCurrent(second), true);
});

test("one check does not cancel another", () => {
  // Checks join the generation in force; only a new list retires it.
  const batch = session.generations.check.current();
  const single = session.generations.check.current();
  assert.equal(session.generations.check.isCurrent(batch), true);
  assert.equal(session.generations.check.isCurrent(single), true);

  session.generations.check.next();
  assert.equal(session.generations.check.isCurrent(batch), false);
});

test("retiring in-flight work discards every preview, check and join, and touches no state", () => {
  reset();
  state.preview = { address: "10.0.0.1:12203" };
  const preview = session.generations.preview.next();
  const check = session.generations.check.current();
  const join = session.generations.join.next();

  session.retireInFlight();

  assert.equal(session.generations.preview.isCurrent(preview), false);
  assert.equal(session.generations.check.isCurrent(check), false);
  assert.equal(session.generations.join.isCurrent(join), false);
  // The resets differ per caller and stay at the call sites.
  assert.deepEqual(state.preview, { address: "10.0.0.1:12203" });
});
