// SPDX-License-Identifier: GPL-3.0-only

// `features/join/presence.js` and the Discord section of Settings: the status is on unless the
// player turns it off, the shell hears every change, and the notice explaining it comes once.

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

installStorage();
const bridge = installTauri();
const document = installDom();
const elements = {
  "#info-dialog": document.createElement("dialog"),
  "#info-dialog-title": document.createElement("h2"),
  "#info-dialog-body": document.createElement("div"),
};
document.querySelector = (selector) => elements[selector] ?? null;

const { preferences, reloadPreferences } = await import("../../../ui/lib/preferences.js");
const { answerDiscordNotice, discordNoticeDue, syncDiscordPresence } = await import(
  "../../../ui/features/join/presence.js"
);
const { openSettings } = await import("../../../ui/features/settings/dialog.js");
const { discordSettingsSection } = await import("../../../ui/features/join/settings-section.js");

const sent = () =>
  bridge.calls.filter(({ command }) => command === "set_discord_presence").map(({ args }) => args.enabled);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const SHOWN = { outcome: { launch: "launched" }, presence_shown: true };

test.beforeEach(() => {
  localStorage.clear();
  reloadPreferences();
  bridge.reset();
});

test("the status is on until the player turns it off, and the shell hears the saved choice", async () => {
  assert.equal(preferences().discordPresence, true);
  await syncDiscordPresence();
  assert.deepEqual(sent(), [true]);
});

test("the notice is due only once Discord actually showed a match", () => {
  assert.equal(discordNoticeDue(SHOWN), true);
  assert.equal(discordNoticeDue({ ...SHOWN, presence_shown: false }), false);
  assert.equal(discordNoticeDue(null), false);
});

test("keeping the status retires the notice and leaves the status on", async () => {
  await answerDiscordNotice(true);
  assert.equal(discordNoticeDue(SHOWN), false);
  assert.equal(preferences().discordPresence, true);
  assert.deepEqual(sent(), []);
});

test("turning it off from the notice retires the notice and ends the status at once", async () => {
  await answerDiscordNotice(false);
  assert.equal(discordNoticeDue(SHOWN), false);
  assert.equal(preferences().discordPresence, false);
  assert.deepEqual(sent(), [false]);
});

test("the Settings toggle saves the choice and tells the shell", async () => {
  openSettings([discordSettingsSection()]);
  const body = elements["#info-dialog-body"];
  const find = (node) => {
    for (const child of node.children ?? []) {
      if (typeof child !== "object") continue;
      if (child.id === "settings-discord-presence") return child;
      const found = find(child);
      if (found) return found;
    }
    return null;
  };
  assert.equal(find(body).checked, true);

  find(body).dispatch("change", { target: { checked: false } });
  await settle();

  assert.equal(preferences().discordPresence, false);
  assert.deepEqual(sent(), [false]);
  assert.equal(find(body).checked, false);
});

test("without the shell, syncing the choice fails quietly", async () => {
  bridge.fail("set_discord_presence", new Error("no shell"));
  await syncDiscordPresence();
  delete bridge.results.set_discord_presence;
});
