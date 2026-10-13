// SPDX-License-Identifier: GPL-3.0-only

// `features/content/viewer.js`: going from fitted to actual size keeps the point under the pointer
// where it was.

import test from "node:test";
import assert from "node:assert/strict";

const { scrollToKeep } = await import("../../../ui/features/content/viewer.js");

test("the point clicked stays under the pointer at actual size", () => {
  // Three quarters across a 1024 px screenshot that starts 64 px in, clicked 500 px into the stage.
  assert.equal(scrollToKeep(0.75, 64, 1024, 500), 64 + 768 - 500);
});

test("a point near the start never asks for a negative scroll", () => {
  assert.equal(scrollToKeep(0.05, 0, 1024, 300), 0);
});
