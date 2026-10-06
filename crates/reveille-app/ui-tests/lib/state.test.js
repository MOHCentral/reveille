// SPDX-License-Identifier: GPL-3.0-only

// `createState(parts)`: every key in the one state object has one owner.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";

const { createState, state } = await import("../../ui/lib/store.js");

test("parts compose into one object", () => {
  const map = new Map();
  const composed = createState([{ a: 1 }, { b: map }]);
  assert.deepEqual(Object.keys(composed), ["a", "b"]);
  assert.equal(composed.b, map);
});

test("a key two parts declare is refused rather than overwritten", () => {
  assert.throws(
    () => createState([{ selected: null }, { selected: "10.0.0.1:12203" }]),
    /state\.selected/,
  );
});

test("no feature declares a key the kernel or another feature already owns", async () => {
  const features = new URL("../../ui/features/", import.meta.url);
  const parts = [{ ...state }];
  for (const entry of await readdir(features, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const index = new URL(`${entry.name}/index.js`, features);
    if (!existsSync(index)) continue;
    const module = await import(index.href);
    if (module.initial) parts.push(module.initial());
  }
  assert.ok(parts.length > 1, "at least one feature declares its state");
  assert.doesNotThrow(() => createState(parts));
});

test("each initial() returns fresh collections", async () => {
  const { initial } = await import("../../ui/features/self-update/index.js");
  assert.notEqual(initial().selfUpdate, initial().selfUpdate);
});
