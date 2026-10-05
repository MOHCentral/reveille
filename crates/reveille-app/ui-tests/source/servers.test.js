// SPDX-License-Identifier: GPL-3.0-only

// Source-text checks over `ui/views/servers.js` for what `ui-tests/fakes/dom.js` deliberately does
// not model: ARIA and tabindex reflection. A fake that approximated those would hand back
// confidence it had not earned.

import test from "node:test";
import assert from "node:assert/strict";

import { read } from "./read.js";

const servers = read("ui/views/servers.js");

test("folded remembered entries always state their count", () => {
  // The fold's rendering half. That `scopedRows` emits the disclosure with its count whether the
  // block is open or shut is asserted behaviourally in `ui-tests/lib/store.test.js`.
  assert.ok(
    servers.includes("`${count} offline`"),
    "ui/views/servers.js: the disclosure must say how many entries it is folding away",
  );
  assert.ok(
    servers.includes(`"aria-expanded": open ? "true" : "false",`),
    "ui/views/servers.js: the disclosure must publish its open state",
  );
});

test("the server table is one tab stop", () => {
  // Every row used to carry `tabIndex: 0`, which put the Join button roughly 260 Tab presses from
  // the search box and made the arrow keys the table was designed around redundant. A grid is a
  // composite widget: exactly one row is tabbable and everything else is reached with the arrows.
  // A regression here is invisible to anyone using a mouse.
  assert.ok(
    servers.includes("tr.tabIndex = tr === tabbable ? 0 : -1;"),
    "ui/views/servers.js: exactly one row may hold the grid's tab stop",
  );
  assert.ok(
    servers.includes("const tabbable = selected ?? rows[0] ?? gridRows[0] ?? null;"),
    "ui/views/servers.js: an absent-only saved scope must still expose a grid tab stop",
  );
  assert.ok(
    servers.includes("control.tabIndex = -1;"),
    "ui/views/servers.js: controls inside a row must not be tab stops of their own",
  );
  assert.ok(
    servers.includes(`{ className: "servers", role: "grid", "aria-label": "Servers" }`),
    "ui/views/servers.js: aria-selected on a row needs the grid role to mean anything",
  );
});
