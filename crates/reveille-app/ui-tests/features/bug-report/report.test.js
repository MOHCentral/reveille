// SPDX-License-Identifier: GPL-3.0-only

// `features/bug-report`: a prefilled issue opened through the scoped system opener.

import test from "node:test";
import assert from "node:assert/strict";

import { installStorage } from "../../fakes/storage.js";
import { installTauri } from "../../fakes/tauri.js";
import { ISSUE_TRACKER_URL, issueTemplate, issueUrl } from "../../../ui/features/bug-report/format.js";

installStorage();
const bridge = installTauri();
const { state } = await import("../../../ui/lib/store.js");
const { openBugReport } = await import("../../../ui/features/bug-report/index.js");

const LOGS = { current: "C:\\Logs\\reveille.log", previous: "C:\\Logs\\reveille.previous.log" };

function snapshot(overrides = {}) {
  return {
    install: { root: "C:\\Games\\MOHAA" },
    game: "allied_assault",
    engine: "openmohaa",
    selected: "203.0.113.5:12203",
    browse: { error: { kind: "master_unreachable", detail: "connection refused" } },
    previewError: null,
    joinError: "the game did not start",
    ...overrides,
  };
}

test("the issue names the session, the selected server and every error on screen", () => {
  const body = issueTemplate(snapshot(), LOGS);
  assert.match(body, /- Game folder: C:\\Games\\MOHAA\n/u);
  assert.match(body, /- Game: allied_assault\n- Engine: openmohaa\n/u);
  assert.match(body, /- Selected server: 203\.0\.113\.5:12203\n/u);
  assert.match(body, /- Browse error: master_unreachable: connection refused\n/u);
  assert.match(body, /- Preview error: \(none\)\n/u);
  assert.match(body, /- Join error: the game did not start\n/u);
});

test("the issue names both log files, so a crash's log is not lost on restart", () => {
  const body = issueTemplate(snapshot(), LOGS);
  assert.ok(body.includes("Attach `C:\\Logs\\reveille.log`. After a crash and restart, also attach `C:\\Logs\\reveille.previous.log`."));
  assert.ok(body.includes("RUST_LOG=reveille=debug"));
});

test("an issue opened before setup or without log paths still reads sensibly", () => {
  const body = issueTemplate(snapshot({ install: null, selected: null, browse: { error: null }, joinError: null }), null);
  assert.match(body, /- Game folder: \(not selected\)\n/u);
  assert.match(body, /- Selected server: \(none\)\n/u);
  assert.match(body, /- Browse error: \(none\)\n/u);
  assert.match(body, /- Join error: \(none\)\n/u);
  assert.ok(body.includes("Attach the Reveille log from the app's local log folder."));
});

test("the link is a new issue on Reveille's tracker carrying the template", () => {
  const url = new URL(issueUrl(snapshot(), LOGS));
  assert.equal(`${url.origin}${url.pathname}`, ISSUE_TRACKER_URL);
  assert.equal(url.searchParams.get("title"), "bug: ");
  assert.equal(url.searchParams.get("body"), issueTemplate(snapshot(), LOGS));
});

test("a bug report asks for the log paths and opens the issue with the system opener", async () => {
  bridge.reset();
  bridge.results = { app_log_files: LOGS };
  Object.assign(state, snapshot());
  await openBugReport();
  assert.deepEqual(bridge.calls.map(({ command }) => command), ["app_log_files"]);
  assert.deepEqual(bridge.opened, [issueUrl(state, LOGS)]);
});

test("a bug report still opens when the log paths cannot be read", async () => {
  bridge.reset();
  bridge.fail("app_log_files", "denied");
  await openBugReport();
  assert.deepEqual(bridge.opened, [issueUrl(state, null)]);
});
