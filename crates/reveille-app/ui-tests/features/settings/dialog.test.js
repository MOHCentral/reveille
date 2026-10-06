// SPDX-License-Identifier: GPL-3.0-only

// `features/settings/dialog.js` draws the sections it is given and nothing else, and a change
// saves the preference and draws every section again. `privacy.js` keeps the answer it was given
// when a save fails.

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

const { el } = await import("../../../ui/lib/dom.js");
const { preferences } = await import("../../../ui/lib/preferences.js");
const { openSettings, section, toggle } = await import("../../../ui/features/settings/dialog.js");
const { privacySettingsSection } = await import("../../../ui/features/settings/privacy.js");

const body = elements["#info-dialog-body"];
const headings = () => body.children.map((node) => node.children[0].text);
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

test("the sections are drawn in the order given, and one that draws nothing is left out", () => {
  openSettings([
    () => section("First"),
    () => false,
    () => section("Second", el("p", null, "body")),
  ]);
  assert.equal(elements["#info-dialog"].open, true);
  assert.equal(elements["#info-dialog-title"].textContent, "Settings");
  assert.deepEqual(headings(), ["First", "Second"]);
});

test("a change saves the preference and draws every section again", () => {
  let draws = 0;
  const counted = () => {
    draws += 1;
    return section("Counted");
  };
  const refresh = ({ change }) =>
    section("List", toggle("settings-refresh-focus", "Refresh", preferences().refreshOnFocus, (on) =>
      change("refreshOnFocus", on)));
  openSettings([counted, refresh]);
  const before = preferences().refreshOnFocus;

  input("settings-refresh-focus").dispatch("change", { target: { checked: !before } });

  assert.equal(preferences().refreshOnFocus, !before);
  assert.equal(draws, 2);
  assert.equal(input("settings-refresh-focus").checked, !before);
});

test("privacy is left out where statistics are unavailable", () => {
  openSettings([privacySettingsSection({ telemetry: { available: false, shared: false } })]);
  assert.deepEqual(headings(), []);
  openSettings([privacySettingsSection({ telemetry: null })]);
  assert.deepEqual(headings(), []);
});

test("privacy shows the saved answer, and keeps it when saving a new one fails", async () => {
  const answers = [{ available: true, shared: true }, new Error("offline")];
  const privacy = privacySettingsSection({
    telemetry: { available: true, shared: false },
    onTelemetry: async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onTelemetryDetails: () => {},
  });
  openSettings([privacy]);
  assert.deepEqual(headings(), ["Privacy"]);
  assert.equal(input("settings-telemetry").checked, false);

  input("settings-telemetry").dispatch("change", { target: { checked: true } });
  await settle();
  assert.equal(input("settings-telemetry").checked, true);

  input("settings-telemetry").dispatch("change", { target: { checked: false } });
  await settle();
  assert.equal(input("settings-telemetry").checked, true);
});
