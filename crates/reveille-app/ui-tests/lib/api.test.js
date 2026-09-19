// SPDX-License-Identifier: GPL-3.0-only

// `lib/api.js`: the one module that knows the Rust contract.
//
// The error-normalisation test here is the second of the two behavioural assertions that used to
// live inside `tools/check-sources.mjs`.
//
// What this can and cannot establish: the fake bridge proves what the shell *sends* and how it
// *reads a reply*, which is the half that lives in JavaScript. That the Rust side accepts those
// arguments is a different claim, guarded by `tauri::generate_handler!` and by the Rust tests.

import test from "node:test";
import assert from "node:assert/strict";

import { installTauri } from "../fakes/tauri.js";

const bridge = installTauri();
const api = await import("../../ui/lib/api.js");

const SESSION = { path: "C:/Game", engine: "openmohaa", game: "allied_assault" };

test.beforeEach(() => bridge.reset());

/* Error normalisation -------------------------------------------------------*/

test("the Windows extended-length prefix never reaches player-facing text", async () => {
  // Tauri can serialize a canonical Windows path with `\\?\` in front of it. A message quoting a
  // folder should quote it the way the player would write it.
  assert.equal(
    api.errorText(String.raw`Windows protects \\?\C:\Program Files\MOHAA`),
    String.raw`Windows protects C:\Program Files\MOHAA`,
  );
});

test("errorText yields a string whatever the rejection was", () => {
  assert.equal(api.errorText("plain"), "plain");
  assert.equal(api.errorText(new Error("thrown")), "thrown");
  assert.equal(api.errorText({ message: "shaped" }), "shaped");
  assert.equal(api.errorText(null), "null");
  assert.equal(api.errorText(42), "42");
  // Whatever happened, the caller gets something it can put on screen rather than "[object
  // Object]" arriving in the middle of a sentence.
  assert.equal(typeof api.errorText({ nope: true }), "string");
});

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
  // Consent is the click on the primary button, and this flag is what carries it. A silent
  // inference from the compatibility state is exactly the bug docs/ui.md §5 records.
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
  await api.onBrowseProgress((payload) => seen.push(payload));
  bridge.emit("reveille://browse", { registered: 190, probed: 12 });
  // No view should ever have to know an event arrives wrapped.
  assert.deepEqual(seen, [{ registered: 190, probed: 12 }]);
});

test("each subscriber listens on the channel Rust emits", async () => {
  const channels = [
    [api.onBrowseProgress, "reveille://browse"],
    [api.onPreviewProgress, "reveille://preview"],
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

/* The scoped opener ---------------------------------------------------------*/

test("an external link goes through the scoped system opener", async () => {
  await api.openExternalUrl("https://github.com/MOHCentral/reveille/issues/new");
  // `window.open` inside the webview would open a window the CSP governs and the player cannot
  // escape; the opener plugin hands it to the system browser, and its allowlist is the gate.
  assert.deepEqual(bridge.opened, ["https://github.com/MOHCentral/reveille/issues/new"]);
});
