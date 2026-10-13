// SPDX-License-Identifier: GPL-3.0-only

// `features/join/presence.js` and the Discord section of Settings: the status is off until the
// player chooses it, the shell hears every change, and the question comes once.

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
const { changeDiscordPresence, discordQuestionDue, syncDiscordPresence } = await import(
  "../../../ui/features/join/presence.js"
);
const { openSettings } = await import("../../../ui/features/settings/dialog.js");
const { discordSettingsSection } = await import("../../../ui/features/join/settings-section.js");

const sent = () =>
  bridge.calls.filter(({ command }) => command === "set_discord_presence").map(({ args }) => args.enabled);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const RUNNING = { outcome: { launch: "launched" }, discord_running: true };

test.beforeEach(() => {
  localStorage.clear();
  reloadPreferences();
  bridge.reset();
});

test("nothing is shared until the player chooses, and the shell hears the saved choice", async () => {
  assert.equal(preferences().discordPresence, false);
  await syncDiscordPresence();
  assert.deepEqual(sent(), [false]);
});

test("the question is due only while Discord runs and the player has not answered", () => {
  assert.equal(discordQuestionDue(RUNNING), true);
  assert.equal(discordQuestionDue({ ...RUNNING, discord_running: false }), false);
  assert.equal(discordQuestionDue(null), false);
});

test("showing it from the question turns the status on and retires the question", async () => {
  await changeDiscordPresence(true);
  assert.equal(discordQuestionDue(RUNNING), false);
  assert.equal(preferences().discordPresence, true);
  assert.deepEqual(sent(), [true]);
});

test("declining retires the question and leaves the status off", async () => {
  await changeDiscordPresence(false);
  assert.equal(discordQuestionDue(RUNNING), false);
  assert.equal(preferences().discordPresence, false);
});

test("the Settings toggle saves the choice, tells the shell, and answers the question", async () => {
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
  assert.equal(find(body).checked, false);

  find(body).dispatch("change", { target: { checked: true } });
  await settle();

  assert.equal(preferences().discordPresence, true);
  assert.deepEqual(sent(), [true]);
  assert.equal(find(body).checked, true);
  assert.equal(discordQuestionDue(RUNNING), false);
});

test("without the shell, syncing the choice fails quietly", async () => {
  bridge.fail("set_discord_presence", new Error("no shell"));
  await syncDiscordPresence();
  delete bridge.results.set_discord_presence;
});
