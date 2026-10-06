// SPDX-License-Identifier: GPL-3.0-only

// Every kernel and feature module loads in Node with no DOM, no storage and no bridge, and starts
// nothing while it loads. Only the entry points, `app.js` and `features/alerts/popup/main.js`, may
// act at load, and gate 7 keeps every other module from importing them.
//
// This proves a module loads without those globals. It cannot see every top-level effect, so the
// rule is also held by review; timers and listeners are the effects it can see.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ENTRY_POINTS } from "../../../../tools/ui-imports.mjs";

const SHELL = fileURLToPath(new URL("../../ui/", import.meta.url));

const modules = ["lib", "features"].flatMap((directory) =>
  readdirSync(join(SHELL, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => relative(SHELL, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .filter((module) => !ENTRY_POINTS.includes(module))
    .sort(),
);

test("the kernel and every feature module load without a DOM or the bridge, and start nothing", async () => {
  assert.ok(modules.includes("lib/bridge.js"));
  for (const name of ["window", "document", "localStorage"]) {
    assert.equal(globalThis[name], undefined, `${name} is not faked`);
  }

  const started = [];
  const record = (what) => (...args) => {
    started.push(what);
    return 0;
  };
  const originals = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    addEventListener: globalThis.addEventListener,
    eventTarget: EventTarget.prototype.addEventListener,
  };
  globalThis.setTimeout = record("setTimeout");
  globalThis.setInterval = record("setInterval");
  globalThis.addEventListener = record("addEventListener");
  EventTarget.prototype.addEventListener = record("addEventListener");
  try {
    for (const module of modules) {
      const before = started.length;
      await import(pathToFileURL(join(SHELL, module)).href);
      assert.deepEqual(started.slice(before), [], `loading ${module} or a module it imports started ${started.slice(before).join(", ")}`);
    }
  } finally {
    globalThis.setTimeout = originals.setTimeout;
    globalThis.setInterval = originals.setInterval;
    globalThis.addEventListener = originals.addEventListener;
    EventTarget.prototype.addEventListener = originals.eventTarget;
  }
});

test("the entry points are exactly the modules the HTML pages load", () => {
  const loaded = readdirSync(SHELL)
    .filter((name) => name.endsWith(".html"))
    .flatMap((name) => [...readFileSync(join(SHELL, name), "utf8").matchAll(/<script type="module" src="([^"]+)"/gu)])
    .map((match) => match[1])
    .sort();
  assert.deepEqual(loaded, [...ENTRY_POINTS].sort());
});
