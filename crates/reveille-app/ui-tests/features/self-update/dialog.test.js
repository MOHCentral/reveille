// SPDX-License-Identifier: GPL-3.0-only

// `features/self-update/index.js`: a background check may reveal an offer, but only the player's
// labelled action installs it, and a running install cannot be dismissed out from under them.

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

const document = installDom();
installStorage();
const bridge = installTauri();
const { state } = await import("../../../ui/lib/store.js");
const { selfUpdate } = await import("../../../ui/features/self-update/index.js");

const OFFER = { version: "0.7.0", current_version: "0.6.1" };
const EVENT = "reveille://self-update";

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function byId(node, id) {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = typeof child === "object" ? byId(child, id) : null;
    if (found) return found;
  }
  return null;
}

/** A fresh controller and dialog, with `offer` already found when given. */
function mount({ offer = OFFER } = {}) {
  bridge.reset();
  bridge.results = { check_reveille_update: offer };
  state.selfUpdate = { offer, running: false, stopping: false, progress: null, error: null };
  state.joining = false;
  const host = document.createElement("div");
  const offers = [];
  const updates = selfUpdate({ host, onOffer: () => offers.push(state.selfUpdate.offer) });
  const dialog = host.children[0];
  const part = (name) => byId(dialog, `reveille-update-${name}`);
  return { updates, dialog, part, offers };
}

/** Make the next install wait until the test settles it. */
function holdInstall() {
  const held = {};
  bridge.results.install_reveille_update = () =>
    new Promise((resolve, reject) => Object.assign(held, { resolve, reject }));
  return held;
}

const commands = () => bridge.calls.map(({ command }) => command);

test("a background check reveals an offer without installing it", async () => {
  const { updates, offers } = mount({ offer: null });
  bridge.results.check_reveille_update = OFFER;
  await updates.find();
  assert.deepEqual(state.selfUpdate.offer, OFFER);
  assert.deepEqual(offers, [OFFER]);
  assert.deepEqual(commands(), ["check_reveille_update"]);
});

test("a background check that fails or finds nothing stays out of the player's way", async () => {
  const { updates, offers } = mount({ offer: null });
  await updates.find();
  bridge.fail("check_reveille_update", "offline");
  await updates.find();
  assert.equal(state.selfUpdate.offer, null);
  assert.deepEqual(offers, []);
});

test("Settings' check reports what it found", async () => {
  const { updates } = mount({ offer: null });
  assert.equal(await updates.check(), null);
  bridge.results.check_reveille_update = OFFER;
  assert.deepEqual(await updates.check(), OFFER);
  assert.deepEqual(state.selfUpdate.offer, OFFER);
});

test("the dialog opens only for an offer, never during a join, and names both versions", () => {
  let { updates, dialog, part } = mount({ offer: null });
  updates.open();
  assert.equal(dialog.open, false);

  ({ updates, dialog, part } = mount());
  state.joining = true;
  updates.open();
  assert.equal(dialog.open, false);

  state.joining = false;
  updates.open();
  assert.equal(dialog.open, true);
  assert.equal(part("copy").textContent, "Version 0.7.0 is available. You have 0.6.1.");
  assert.ok(part("progress").classList.contains("hidden"));
  assert.ok(part("stop").classList.contains("hidden"));
});

test("Later closes the dialog until an install is running, and Escape is refused while it runs", async () => {
  const { updates, dialog, part } = mount();
  updates.open();
  part("later").dispatch("click");
  assert.equal(dialog.open, false);
  assert.deepEqual(commands(), []);

  updates.open();
  holdInstall();
  part("install").dispatch("click");
  await settle();
  assert.deepEqual(commands(), ["install_reveille_update"]);
  assert.equal(part("install").disabled, true);
  assert.equal(part("later").disabled, true);
  part("later").dispatch("click");
  assert.equal(dialog.open, true);
  let refused = false;
  dialog.dispatch("cancel", { preventDefault: () => (refused = true) });
  assert.equal(refused, true);
});

test("a second press of Update and restart does not start a second install", async () => {
  const { updates, part } = mount();
  updates.open();
  holdInstall();
  part("install").dispatch("click");
  part("install").dispatch("click");
  await settle();
  assert.deepEqual(commands(), ["install_reveille_update"]);
});

test("download progress fills the meter, and a known size reads as a share", async () => {
  const { updates, part } = mount();
  updates.open();
  holdInstall();
  part("install").dispatch("click");
  assert.ok(!part("progress").classList.contains("hidden"));
  assert.ok(part("meter").classList.contains("meter--indeterminate"));
  assert.equal(part("status").textContent, "Downloading update");

  bridge.emit(EVENT, { phase: "downloading", received: 40, total: 160 });
  assert.ok(!part("meter").classList.contains("meter--indeterminate"));
  assert.equal(part("meter-fill").style.width, "25%");
  assert.equal(part("status").textContent, "25% downloaded");
  assert.ok(!part("stop").classList.contains("hidden"));

  bridge.emit(EVENT, { phase: "verifying" });
  assert.ok(part("meter").classList.contains("meter--indeterminate"));
  assert.equal(part("meter-fill").style.width, "");
  assert.ok(part("stop").classList.contains("hidden"), "a verified download can no longer be stopped");
});

test("a stopped download reads as stopped, not as a failure, and can be started again", async () => {
  const { updates, part } = mount();
  updates.open();
  const install = holdInstall();
  part("install").dispatch("click");
  part("stop").dispatch("click");
  assert.equal(part("stop").textContent, "Stopping…");
  assert.equal(part("stop").disabled, true);
  await settle();
  assert.deepEqual(commands(), ["install_reveille_update", "cancel_reveille_update"]);

  install.reject("download cancelled");
  await settle();
  assert.equal(part("status").textContent, "Download stopped");
  assert.ok(part("error").classList.contains("hidden"));
  assert.equal(part("install").disabled, false);
  assert.equal(state.selfUpdate.running, false);
});

test("a cancelled event from Rust ends the run even before the install call returns", async () => {
  const { updates, part } = mount();
  updates.open();
  const install = holdInstall();
  part("install").dispatch("click");
  bridge.emit(EVENT, { phase: "cancelled" });
  assert.equal(state.selfUpdate.running, false);
  assert.equal(part("later").disabled, false);

  install.reject("download cancelled");
  await settle();
  assert.ok(part("error").classList.contains("hidden"));
});

test("an install that fails says why and lets the player try again", async () => {
  const { updates, part } = mount();
  updates.open();
  bridge.fail("install_reveille_update", new Error("signature mismatch"));
  part("install").dispatch("click");
  await settle();
  assert.equal(part("error").textContent, "signature mismatch");
  assert.ok(!part("error").classList.contains("hidden"));
  assert.equal(part("install").disabled, false);
});

test("a stop that Rust refuses keeps the download running and says why", async () => {
  const { updates, part } = mount();
  updates.open();
  holdInstall();
  bridge.fail("cancel_reveille_update", "too late");
  part("install").dispatch("click");
  part("stop").dispatch("click");
  await settle();
  assert.equal(part("error").textContent, "too late");
  assert.equal(part("stop").textContent, "Stop download");
  assert.equal(state.selfUpdate.running, true);
});
