// SPDX-License-Identifier: GPL-3.0-only

// `features/alerts/controller.js`: nothing listens or polls until the shell starts it with its
// intents, an alert's notification opens its server through `openServer`, and watching a server
// is a toggle that explains itself once.

import test, { mock } from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";

mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
installStorage();
const document = installDom();
const bridge = installTauri();
const elements = {
  "#arrival-events-btn": document.createElement("button"),
  "#arrival-unread": document.createElement("span"),
  "#info-dialog": document.createElement("dialog"),
  "#info-dialog-title": document.createElement("h2"),
  "#info-dialog-body": document.createElement("div"),
};
// The fake DOM models `append` only; the bell's icon goes first, which no assertion here reads.
elements["#arrival-events-btn"].prepend = (...nodes) => elements["#arrival-events-btn"].append(...nodes);
document.querySelector = (selector) => elements[selector] ?? null;
document.hasFocus = () => true;
const windowListeners = [];
window.addEventListener = (type) => windowListeners.push(type);

const { state } = await import("../../../ui/lib/store.js");
const { recordArrival } = await import("../../../ui/features/alerts/arrival-events.js");
const { hasPlayerAlert } = await import("../../../ui/features/alerts/player-alerts.js");
const { preferences } = await import("../../../ui/lib/preferences.js");
await import("../../../ui/features/alerts/preferences.js");
const { playerAlertsController } = await import("../../../ui/features/alerts/controller.js");

const opened = [];
const intents = { openServer: (target) => opened.push(target) };
const alerts = playerAlertsController({ onOpenWatching: () => {}, changeStartAtLogin: async () => null });

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("building the controller listens to nothing and probes nothing", () => {
  assert.deepEqual(bridge.calls, []);
  assert.equal(bridge.listeners.size, 0);
  assert.deepEqual(windowListeners, []);
});

test("starting it mounts the bell and opens a clicked notification's server through openServer", async () => {
  state.game = "allied_assault";
  alerts.start(intents);
  assert.deepEqual(windowListeners, ["focus"]);
  assert.ok(bridge.listeners.has("reveille://player-alert-open"));
  assert.ok(bridge.calls.some(({ command }) => command === "popup_supported"));

  const event = recordArrival(
    { game: "spearhead", address: "10.0.0.1:12203", queryPort: 12300, hostname: "Old Bridge" },
    3,
  );
  bridge.emit("reveille://player-alert-open", { eventId: event.id, join: true });
  bridge.emit("reveille://player-alert-open", { eventId: "forgotten", join: true });
  assert.deepEqual(opened, [
    { game: "spearhead", address: "10.0.0.1:12203", queryPort: 12300, hostname: "Old Bridge", join: true },
  ]);
});

test("watching a server saves it, explains alerts once, and a second toggle forgets it", async () => {
  const row = { address: "10.0.0.2:12203", server: { hostname: "Rail", endpoint: { query_port: 12300 } } };
  await alerts.togglePlayerAlert(row);
  await settle();
  assert.equal(hasPlayerAlert("allied_assault", row.address), true);
  assert.equal(preferences().alertsIntroShown, true);

  await alerts.togglePlayerAlert(row);
  assert.equal(hasPlayerAlert("allied_assault", row.address), false);
  assert.equal(state.watchReadings.has(`allied_assault|${row.address}`), false);
});
