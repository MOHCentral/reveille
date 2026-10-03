// SPDX-License-Identifier: GPL-3.0-only

// `lib/rcon-maps.js`: the maps typed into the console for one server, kept between runs.

import test from "node:test";
import assert from "node:assert/strict";

import { installBrokenStorage, installStorage } from "../fakes/storage.js";

installStorage();
const { forgetMap, mergeMaps, rememberMap, rememberedMaps } = await import("../../ui/lib/rcon-maps.js");

const A = "203.0.113.10:12203";
const B = "203.0.113.11:12203";

test("a remembered map belongs to one server and survives a reload", () => {
  const storage = installStorage();
  rememberMap(A, "obj/obj_team1");

  assert.deepEqual(rememberedMaps(A), ["obj/obj_team1"]);
  assert.deepEqual(rememberedMaps(B), []);
  assert.ok(storage.raw("reveille.rcon.maps"));
});

test("the same map in another case is one entry, the newest spelling", () => {
  installStorage();
  rememberMap(A, "dm/MyMap");
  rememberMap(A, "dm/mymap");

  assert.deepEqual(rememberedMaps(A), ["dm/mymap"]);
});

test("a name that is not a plain map name is never stored", () => {
  installStorage();
  rememberMap(A, "dm/x; quit");
  rememberMap(A, "../x");
  rememberMap(A, "");

  assert.deepEqual(rememberedMaps(A), []);
});

test("forgetting leaves the other maps and the other servers", () => {
  installStorage();
  rememberMap(A, "dm/one");
  rememberMap(A, "dm/two");
  rememberMap(B, "dm/one");

  forgetMap(A, "DM/ONE");

  assert.deepEqual(rememberedMaps(A), ["dm/two"]);
  assert.deepEqual(rememberedMaps(B), ["dm/one"]);
});

test("a hand-edited or corrupt store reads as empty, and bad entries are skipped", () => {
  installStorage({ "reveille.rcon.maps": "not json" });
  assert.deepEqual(rememberedMaps(A), []);
  installStorage({
    "reveille.rcon.maps": JSON.stringify({ v: 1, servers: { [A]: ["dm/ok", 7, "bad name"] } }),
  });
  assert.deepEqual(rememberedMaps(A), ["dm/ok"]);
});

test("storage that refuses to work does not stop the console", () => {
  installBrokenStorage();
  rememberMap(A, "dm/one");
  assert.deepEqual(rememberedMaps(A), []);
});

test("local and remembered maps merge once each, sorted", () => {
  assert.deepEqual(
    mergeMaps(["obj/obj_team1", "dm/mohdm1"], ["DM/MohDM1", "custom/arena"]),
    ["custom/arena", "dm/mohdm1", "obj/obj_team1"],
  );
});
