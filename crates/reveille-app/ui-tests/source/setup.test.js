// SPDX-License-Identifier: GPL-3.0-only

// Source-text checks over `ui/views/setup.js` for claims `ui-tests/views/setup.test.js` cannot
// reach through the fakes: exact wording, and the order of statements inside the copy flow.

import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./read.js";

const setup = read("ui/views/setup.js");

test("an installed engine can still be changed from setup", () => {
  // Both engine actions were drawn only while nothing was installed, so a player who already had
  // OpenMoHAA could pick Preview, read the newer version off the card, press Continue to servers,
  // and get exactly the binaries they started with — Continue records which engine to launch and
  // installs nothing.
  assert.ok(
    !setup.includes('!isInstalled("openmohaa")') && !setup.includes('!isInstalled("reborn")'),
    "ui/views/setup.js: an engine action must not be withheld merely because something is installed",
  );
  // Installing from nothing rides on the setup's own priced primary button; anything already
  // installed keeps a secondary action on its row, whatever build it is.
  assert.ok(
    setup.includes("return { label: `Install ${name} (${bytes(size)}) and ${verb}`, run: installAndAccept };"),
    "ui/views/setup.js: a program that is not installed must be installable from the primary action",
  );
  assert.ok(
    setup.includes('available && isInstalled("openmohaa") && !view.installing && openAction(install, status, render)'),
    "ui/views/setup.js: an installed OpenMoHAA must keep its action whenever a release is available",
  );
  assert.ok(
    setup.includes('isInstalled("reborn") && !view.installing && rebornAction(install, info, build, render)'),
    "ui/views/setup.js: an installed Reborn must keep its action whatever build it is",
  );

  // The label states the direction the Rust comparison found, and never guesses one.
  for (const wording of [
    'if (build.relation === "newer") return `Update to ${version}`;',
    'if (build.relation === "older") return `Go back to ${version}`;',
    'if (build.relation === "same_version") return `Reinstall ${version}`;',
  ]) {
    assert.ok(
      setup.includes(wording),
      `ui/views/setup.js: the engine action must be named from the receipt comparison — missing ${wording}`,
    );
  }

  // The install can legitimately write nothing, and that is not a success.
  assert.ok(
    setup.includes('if (result.outcome?.outcome === "deferred")'),
    "ui/views/setup.js: a deferred install must be reported as having changed nothing",
  );
});

test("protected setup offers a cancellable copy and migrates only the validated result", () => {
  // The `store.js` migration and the `api.js` path-prefix stripping are asserted behaviourally in
  // `ui-tests/lib/store.test.js` and `ui-tests/lib/api.test.js`. What stays is the ordering claim:
  // the preferences move only after Rust has returned a re-identified installation. That has no
  // runtime equivalent short of driving the whole copy flow with a filesystem behind it.
  for (const wording of [
    "Windows protects this game folder",
    "`Make a copy (${bytes(storage.source_bytes)})`",
    "`Make a copy to install ${name}`",
    "Choose another location",
    "The original stays unchanged.",
    "Cancel copy",
  ]) {
    assert.ok(setup.includes(wording), `setup is missing ${wording}`);
  }
  const copy = setup.split("async function runCopy")[1]?.split("async function stopCopy")[0];
  assert.ok(copy !== undefined, "copy function");
  const validated = copy.indexOf("const copied = result.installation");
  assert.ok(validated !== -1, "validated copy");
  const migrated = copy.indexOf("migrateInstallationPreferences");
  assert.ok(migrated !== -1, "preference migration");
  assert.ok(migrated > validated, "preferences moved before validation");
});
