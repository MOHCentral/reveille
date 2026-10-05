// SPDX-License-Identifier: GPL-3.0-only

// Checks that span the shell, its markup, the Tauri configuration and the release workflow. No
// single runtime sees all of them, and they have to agree for the feature to exist at all.

import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./read.js";

const shell = read("ui/app.js");
const setup = read("ui/views/setup.js");

test("the self-update offer is explicit and keeps the checked release", () => {
  // A background response may reveal an offer, but only the player's labelled action may install
  // it. The Rust half, that the checked Update object is retained, is in `src/self_update.rs`.
  const workflow = read("../../.github/workflows/release.yml");
  const config = read("tauri.conf.json");

  assert.ok(shell.includes("await checkReveilleUpdate()"));
  assert.ok(shell.includes("await installReveilleUpdate()"));
  assert.ok(shell.includes("if (!state.selfUpdate.running)"));
  assert.ok(shell.includes("setup.renderUpdateOffer()"));
  assert.ok(!shell.includes("if (!state.install) setup.render();"));
  assert.ok(shell.includes("if (!state.selfUpdate.offer || state.joining) return;"));
  assert.ok(shell.includes(`$("#reveille-update-btn").disabled = state.joining;`));
  assert.ok(!shell.includes(`$("#reveille-update-btn").disabled = state.browse.running`));
  assert.ok(setup.includes("data-self-update-offer"));
  assert.ok(setup.includes("Update Reveille"));
  assert.ok(workflow.includes("REVEILLE_UPDATER_PUBKEY"));
  assert.ok(workflow.includes("createUpdaterArtifacts = $true"));
  assert.ok(workflow.includes("latest.json"));
  assert.ok(config.includes(`"pubkey": ""`));
});

test("bug reports use the scoped system opener and name persistent logs", () => {
  // That `openExternalUrl` reaches the opener plugin rather than `window.open` is asserted
  // behaviourally in `ui-tests/lib/api.test.js`. What stays is the capability allowlist, the
  // markup and the stylesheet that have to agree with each other for the control to exist.
  const index = read("ui/index.html");
  const styles = read("ui/styles/components.css");
  const capability = read("capabilities/default.json");

  assert.ok(shell.includes("await openExternalUrl(issueUrl)"));
  assert.ok(!shell.includes("window.open("));
  assert.ok(shell.includes("await appLogFiles()"));
  assert.ok(capability.includes("opener:allow-open-url"));
  assert.ok(capability.includes("https://github.com/MOHCentral/reveille/issues/new*"));
  assert.ok(setup.includes("btn btn--sm btn--utility"));
  // In the shell it lives in the titlebar's More menu.
  assert.ok(index.includes(`id="more-btn"`));
  assert.ok(shell.includes(`label: "Report a bug", onSelect: () => void openBugReport()`));
  assert.ok(styles.includes(".btn--utility"));
});
