// SPDX-License-Identifier: GPL-3.0-only

// The features' `api.js` modules: the only modules that know the Rust contract.
//
// What this can and cannot establish: the fake bridge proves what the shell *sends* and how it
// *reads a reply*, which is the half that lives in JavaScript. That the Rust side accepts those
// arguments is a different claim, guarded by `tauri::generate_handler!` and by the Rust tests.

import test from "node:test";
import assert from "node:assert/strict";

import { installTauri } from "../fakes/tauri.js";
import * as alerts from "../../ui/features/alerts/api.js";
import * as bugReport from "../../ui/features/bug-report/api.js";
import * as join from "../../ui/features/join/api.js";
import * as selfUpdate from "../../ui/features/self-update/api.js";
import * as servers from "../../ui/features/servers/api.js";
import * as settings from "../../ui/features/settings/api.js";
import * as setup from "../../ui/features/setup/api.js";
import * as shell from "../../ui/lib/shell.js";

const api = { ...alerts, ...bugReport, ...join, ...selfUpdate, ...servers, ...settings, ...setup, ...shell };

const bridge = installTauri();

const SESSION = { path: "C:/Game", engine: "openmohaa", game: "allied_assault" };

test.beforeEach(() => bridge.reset());

/* Classified sweep failures (rule H6) ---------------------------------------*/

test("a classified sweep failure keeps the kind Rust decided", () => {
  const failure = api.browseFailure({ kind: "master_unreachable", detail: "connection refused" });
  // The kind is decided in Rust beside the errors it names. The shell must never read a cause out
  // of a formatted message, which is how "no internet" and "the master sent nonsense" ended up as
  // the same unreadable line.
  assert.deepEqual(failure, { kind: "master_unreachable", detail: "connection refused" });
});

test("an unclassified failure is carried through as internal with its own message intact", () => {
  assert.deepEqual(api.browseFailure("something else entirely"), {
    kind: "internal",
    detail: "something else entirely",
  });
  assert.deepEqual(api.browseFailure({ detail: "no kind" }), {
    kind: "internal",
    detail: "[object Object]",
  });
});

test("a classified failure with no detail still normalises to a string", () => {
  assert.deepEqual(api.browseFailure({ kind: "no_network" }), { kind: "no_network", detail: "" });
});

/* The session goes to every server-facing command --------------------------- */

test("every server-facing command sends the whole session", async () => {
  // A folder and an engine without a game names no search path, so all three travel together.
  await api.browseServers(SESSION);
  await api.checkServer(SESSION, "10.0.0.1:12203", 12300);
  await api.previewJoin(SESSION, "10.0.0.1:12203");
  await api.installServerFiles(SESSION, "10.0.0.1:12203");
  await api.installAndLaunch(SESSION, "10.0.0.1:12203", [7], true);

  assert.deepEqual(
    bridge.calls.map((call) => call.command),
    [
      "browse_servers",
      "check_server",
      "preview_join",
      "install_server_files",
      "install_and_launch",
    ],
  );
  for (const call of bridge.calls) {
    assert.deepEqual(call.args.session, SESSION, `${call.command} sends the session`);
  }
});

test("the join command passes the chosen candidates and the consent flag through", async () => {
  await api.installAndLaunch(SESSION, "10.0.0.1:12203", [11, 22], true);
  const { args } = bridge.calls[0];
  assert.deepEqual(args.selectedCandidateIds, [11, 22]);
  // Consent is the click on the primary button, and this flag is what carries it, never an
  // inference from the compatibility state.
  assert.equal(args.acceptIncomplete, true);
});

test("check_server carries the query port the master published, not the game port", async () => {
  await api.checkServer(SESSION, "10.0.0.1:12203", 12300);
  assert.equal(bridge.calls[0].args.queryPort, 12300);
});

/* Command names -------------------------------------------------------------*/

test("each wrapper invokes the command it is named for", async () => {
  const cases = [
    [() => api.detectInstall(), "detect_install"],
    [() => api.identifyInstall("C:/Game"), "identify_install"],
    [() => api.engineOverview("C:/Game"), "engine_overview"],
    [() => api.selectEngine("C:/Game", "reborn"), "select_engine"],
    [() => api.installReborn("C:/Game"), "install_reborn"],
    [() => api.openMohaaStatus("C:/Game", "stable"), "openmohaa_status"],
    [() => api.installOpenMohaa("C:/Game", "offer"), "install_openmohaa"],
    [() => api.installationStorage("C:/Game"), "installation_storage"],
    [() => api.pickCopyDestination("C:/Game"), "pick_copy_destination"],
    [() => api.copyGameInstallation("C:/Game", "D:/Game"), "copy_game_installation"],
    [() => api.pickInstallFolder(), "pick_install_folder"],
    [() => api.checkReveilleUpdate(), "check_reveille_update"],
    [() => api.appLogFiles(), "app_log_files"],
  ];
  for (const [call, command] of cases) {
    bridge.reset();
    await call();
    assert.equal(bridge.calls[0].command, command);
  }
});

test("detect_install sends null rather than omitting the argument", async () => {
  await api.detectInstall();
  // Rust's parameter is an `Option<String>`; omitting the key and sending null are not the same
  // thing over IPC, and the deserialiser is the one that decides.
  assert.deepEqual(bridge.calls[0].args, { selectedPath: null });
});

/* Events --------------------------------------------------------------------*/

test("event handlers receive the payload, never the Tauri envelope", async () => {
  const seen = [];
  await api.onInstallProgress((payload) => seen.push(payload));
  bridge.emit("reveille://install", { filename: "a.pk3", index: 1, of: 3 });
  // No view should ever have to know an event arrives wrapped.
  assert.deepEqual(seen, [{ filename: "a.pk3", index: 1, of: 3 }]);
});

test("each subscriber listens on the channel Rust emits", async () => {
  const channels = [
    [api.onInstallProgress, "reveille://install"],
    [api.onOpenMohaaInstallProgress, "reveille://openmohaa-install"],
    [api.onRebornInstallProgress, "reveille://reborn-install"],
    [api.onInstallationCopyProgress, "reveille://installation-copy"],
    [api.onSelfUpdateProgress, "reveille://self-update"],
  ];
  for (const [subscribe, channel] of channels) {
    await subscribe(() => {});
    assert.ok(bridge.listeners.has(channel), `${channel} is subscribed`);
  }
});

test("browse progress arrives over a channel handed to browse_servers itself", async () => {
  const seen = [];
  bridge.results.browse_servers = () => {
    bridge.send("browse_servers", { registered: 190, probed: 12 });
    return "swept";
  };
  assert.equal(await api.browseServers(SESSION, (progress) => seen.push(progress)), "swept");
  assert.deepEqual(bridge.calls[0].args.session, SESSION);
  assert.deepEqual(seen, [{ registered: 190, probed: 12 }]);
});

test("preview progress arrives over a channel handed to the command that prices the join", async () => {
  const seen = [];
  bridge.results.preview_join = () => {
    bridge.send("preview_join", { index: 0, of: 2 });
    return "priced";
  };
  bridge.results.install_server_files = () => {
    bridge.send("install_server_files", { index: 1, of: 2 });
    return "installed";
  };
  assert.equal(await api.previewJoin(SESSION, "10.0.0.1:12203", (progress) => seen.push(progress)), "priced");
  assert.equal(await api.installServerFiles(SESSION, "10.0.0.1:12203", (progress) => seen.push(progress)), "installed");
  assert.deepEqual(seen, [{ index: 0, of: 2 }, { index: 1, of: 2 }]);
});

/* The scoped opener ---------------------------------------------------------*/

test("an external link goes through the scoped system opener", async () => {
  await api.openExternalUrl("https://github.com/MOHCentral/reveille/issues/new");
  // `window.open` inside the webview would open a window the CSP governs and the player cannot
  // escape; the opener plugin hands it to the system browser, and its allowlist is the gate.
  assert.deepEqual(bridge.opened, ["https://github.com/MOHCentral/reveille/issues/new"]);
});

/* Telemetry ----------------------------------------------------------------- */

test("a telemetry event is sent as the typed event Rust accepts", () => {
  api.trackEvent({ event: "server_selected", ready: true });
  assert.deepEqual(bridge.calls, [
    { command: "track_event", args: { event: { event: "server_selected", ready: true } } },
  ]);
});

test("a telemetry event that fails never reaches the caller", async () => {
  bridge.fail("track_event", "no such command");
  assert.equal(api.trackEvent({ event: "server_selected", ready: false }), undefined);
  // An unhandled rejection would fail this file under `node --test`.
  await new Promise((resolve) => setTimeout(resolve, 0));
  delete bridge.results.track_event;
});

test("the sharing choice is saved through its own command", async () => {
  bridge.results.set_telemetry_shared = ({ shared }) => ({ available: true, shared });
  assert.deepEqual(await api.setTelemetryShared(false), { available: true, shared: false });
  assert.deepEqual(bridge.calls.at(-1), { command: "set_telemetry_shared", args: { shared: false } });
});

test("the pop-up window speaks to Rust through the alerts API", async () => {
  bridge.results.alert_popup_ready = [{ eventId: "a" }];
  assert.deepEqual(await alerts.alertPopupReady(), [{ eventId: "a" }]);
  await alerts.alertPopupAction("snooze", "");
  await alerts.fitAlertPopup(0);
  assert.deepEqual(bridge.calls, [
    { command: "alert_popup_ready", args: undefined },
    { command: "alert_popup_action", args: { action: "snooze", eventId: "" } },
    { command: "fit_alert_popup", args: { height: 0 } },
  ]);
  const cards = [];
  await alerts.onPopupCard((card) => cards.push(card));
  bridge.emit("reveille://popup-card", { eventId: "b" });
  assert.deepEqual(cards, [{ eventId: "b" }]);
  delete bridge.results.alert_popup_ready;
});
