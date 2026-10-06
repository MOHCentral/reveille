// SPDX-License-Identifier: GPL-3.0-only

// `features/self-update/format.js`: what the update dialog says about the offer and the download.

import test from "node:test";
import assert from "node:assert/strict";

import { offerText, progressShare, progressText } from "../../../ui/features/self-update/format.js";

test("the offer names the new version and the one installed", () => {
  assert.equal(offerText({ version: "0.7.0", current_version: "0.6.1" }), "Version 0.7.0 is available. You have 0.6.1.");
});

test("a download of known size reports its share, and one of unknown size does not invent one", () => {
  assert.equal(progressText({ phase: "downloading", received: 25, total: 100 }), "25% downloaded");
  assert.equal(progressShare({ phase: "downloading", received: 25, total: 100 }), 25);
  assert.equal(progressText({ phase: "downloading", received: 25, total: null }), "Downloading update");
  assert.equal(progressShare({ phase: "downloading", received: 25, total: null }), null);
});

test("the meter never overfills when more arrives than was announced", () => {
  assert.equal(progressShare({ phase: "downloading", received: 120, total: 100 }), 100);
});

test("each phase after the download says what Reveille is doing", () => {
  assert.equal(progressText({ phase: "verifying" }), "Checking the downloaded update");
  assert.equal(progressText({ phase: "installing" }), "Closing Reveille and installing the update");
  assert.equal(progressText({ phase: "cancelled" }), "Download stopped");
  assert.equal(progressShare({ phase: "verifying" }), null);
});

test("nothing is said before the download starts", () => {
  assert.equal(progressText(null), "");
  assert.equal(progressShare(null), null);
});
