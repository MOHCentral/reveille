// SPDX-License-Identifier: GPL-3.0-only

// `features/alerts/settings-section.js`: the Notifications section of Settings keeps start at
// sign-in from outliving the tray icon, and only offers the pop-up where this desktop can draw it.

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";

installStorage();
const document = installDom();
const elements = {
  "#info-dialog": document.createElement("dialog"),
  "#info-dialog-title": document.createElement("h2"),
  "#info-dialog-body": document.createElement("div"),
};
document.querySelector = (selector) => elements[selector] ?? null;

const { preferences, setPreference } = await import("../../../ui/lib/preferences.js");
await import("../../../ui/features/alerts/preferences.js");
const { openSettings } = await import("../../../ui/features/settings/dialog.js");
const { alertsSettingsSection } = await import("../../../ui/features/alerts/settings-section.js");

const body = elements["#info-dialog-body"];
const find = (node, test) => {
  for (const child of node.children ?? []) {
    if (typeof child === "object" && test(child)) return child;
    const found = typeof child === "object" && find(child, test);
    if (found) return found;
  }
  return null;
};
const input = (id) => find(body, (node) => node.id === id);
const settle = () => new Promise((resolve) => setImmediate(resolve));

function open(options = {}) {
  const calls = { tray: [], login: [] };
  openSettings([
    alertsSettingsSection({
      popupSupported: true,
      startAtLogin: true,
      onCloseToTray: (on) => calls.tray.push(on),
      onStartAtLogin: async (on) => {
        calls.login.push(on);
        return on;
      },
      onNotificationSettings: () => {},
      onTestAlert: async () => {},
      onOpenWatching: () => {},
      ...options,
    }),
  ]);
  return calls;
}

test("closing to the tray off also stops starting hidden at sign-in", async () => {
  setPreference("closeToTray", true);
  const calls = open();
  assert.equal(input("settings-login").checked, true);

  input("settings-tray").dispatch("change", { target: { checked: false } });
  await settle();

  assert.equal(preferences().closeToTray, false);
  assert.equal(preferences().trayChosen, true);
  assert.deepEqual(calls.tray, [false]);
  assert.deepEqual(calls.login, [false]);
  assert.equal(input("settings-login"), null);
});

test("start at sign-in is offered only with the tray on and a known answer", async () => {
  setPreference("closeToTray", true);
  open({ startAtLogin: null });
  assert.equal(input("settings-login"), null);

  const calls = open({ startAtLogin: false });
  input("settings-login").dispatch("change", { target: { checked: true } });
  await settle();
  assert.deepEqual(calls.login, [true]);
  assert.equal(input("settings-login").checked, true);
});

test("the alert style is a choice only where the pop-up can be drawn", () => {
  open({ popupSupported: false });
  assert.equal(input("settings-alert-style"), null);
  open({ popupSupported: true });
  assert.ok(input("settings-alert-style"));
});
