// SPDX-License-Identifier: GPL-3.0-only

// Gate 7 in `tools/check-sources.mjs`: each boundary rule fails on a deliberate violation.

import test from "node:test";
import assert from "node:assert/strict";
import { importViolations, readImports } from "../../../../tools/ui-imports.mjs";

/** A small shell that passes, so each case below differs from it by one violation. */
function tree(changes = {}) {
  const files = new Map(Object.entries({
    "app.js": 'import { join } from "./features/join/api.js";\nimport "./features/alerts/preferences.js";\n',
    "features/alerts/popup/main.js": 'import { fit } from "../api.js";\n',
    "lib/bridge.js": "export const invoke = () => window.__TAURI__.core.invoke();\n",
    "lib/store.js": 'import { plural } from "./format.js";\nexport const state = {};\n',
    "lib/format.js": "export const plural = (n) => n;\n",
    "features/join/api.js": 'import { invoke } from "../../lib/bridge.js";\nexport const join = () => invoke();\n',
    "features/alerts/api.js": 'import { invoke } from "../../lib/bridge.js";\nexport const fit = () => invoke();\n',
    "features/alerts/preferences.js": 'import { state } from "../../lib/store.js";\nexport { state };\n',
    "features/alerts/index.js": 'import { fit } from "./api.js";\n\nexport { fit };\n',
    "features/servers/view.js": 'import { fit } from "../alerts/index.js";\nexport function render() {}\n',
    "index.html": '<script type="module" src="app.js"></script>\n',
  }));
  for (const [path, source] of Object.entries(changes)) {
    if (source === null) files.delete(path);
    else files.set(path, source);
  }
  return files;
}

function fails(changes, pattern) {
  const failures = importViolations(tree(changes));
  assert.ok(failures.some((failure) => pattern.test(failure)), `expected ${pattern}, got ${JSON.stringify(failures)}`);
}

test("the reference tree passes the gate", () => {
  assert.deepEqual(importViolations(tree()), []);
});

test("only the bridge may name the Tauri global", () => {
  fails({ "lib/store.js": "export const state = window.__TAURI__;\n" }, /lib\/store\.js: only lib\/bridge\.js may read __TAURI__/);
  fails({ "index.html": "<script>window.__TAURI__</script>\n" }, /index\.html: only lib\/bridge\.js/);
});

test("a view cannot import the bridge, but a feature api and the kernel can", () => {
  fails(
    { "features/servers/view.js": 'import { invoke } from "../../lib/bridge.js";\n' },
    /features\/servers\/view\.js: line 1: only lib\/ and features\/\*\/api\.js may import lib\/bridge\.js/,
  );
  fails({ "app.js": 'import { invoke } from "./lib/bridge.js";\n' }, /app\.js: line 1: only lib\//);
  assert.deepEqual(importViolations(tree({ "lib/format.js": 'import { invoke } from "./bridge.js";\n' })), []);
});

test("a feature reaches another only through its index.js", () => {
  fails(
    { "features/servers/view.js": 'import { fit } from "../alerts/api.js";\n' },
    /features\/servers\/view\.js: line 1: reaches into another feature \(features\/alerts\/api\.js\)/,
  );
});

test("the kernel never imports a feature", () => {
  fails(
    { "lib/store.js": 'import { fit } from "../features/alerts/index.js";\n' },
    /lib\/store\.js: line 1: lib\/ never imports a feature/,
  );
});

test("a module outside lib/ and features/ fails unless it is an entry point", () => {
  fails({ "views/setup.js": "export const view = 1;\n" }, /views\/setup\.js: a module belongs in lib\/ or features\/<name>\//);
  fails({ "features/setup.js": "export const view = 1;\n" }, /features\/setup\.js: a module belongs in lib\//);
  assert.deepEqual(importViolations(tree({ "lib/nested/x.js": "export const x = 1;\n" })), []);
});

test("an import cycle fails, however long", () => {
  fails(
    { "lib/format.js": 'import { state } from "./store.js";\nexport const plural = (n) => n;\n' },
    /import cycle: lib\/format\.js -> lib\/store\.js -> lib\/format\.js|import cycle: lib\/store\.js -> lib\/format\.js -> lib\/store\.js/,
  );
});

test("dynamic import and re-export forms fail", () => {
  fails({ "lib/format.js": 'export const load = () => import("./store.js");\n' }, /lib\/format\.js: line 1: dynamic import\(\)/);
  fails({ "features/alerts/index.js": 'export { fit } from "./api.js";\n' }, /features\/alerts\/index\.js: line 1: re-export/);
  fails({ "features/alerts/index.js": 'export * from "./api.js";\n' }, /features\/alerts\/index\.js: line 1: re-export/);
});

test("nothing imports an entry point", () => {
  fails({ "features/servers/view.js": 'import "../../app.js";\n' }, /imports the entry point app\.js/);
  fails({ "features/alerts/index.js": 'import "./popup/main.js";\n' }, /imports the entry point features\/alerts\/popup\/main\.js/);
});

test("a specifier must be a relative path to a module that exists", () => {
  fails({ "lib/format.js": 'import x from "lodash";\n' }, /"lodash" is not a relative path/);
  fails({ "lib/format.js": 'import { x } from "./missing.js";\n' }, /"\.\/missing\.js" names no module/);
  fails({ "lib/format.js": 'import { x } from "../../outside.js";\n' }, /names no module/);
  // Paths are normalised before the rules apply, so a detour cannot dodge one.
  fails(
    { "features/servers/view.js": 'import { fit } from "./../alerts/./api.js";\n' },
    /reaches into another feature \(features\/alerts\/api\.js\)/,
  );
});

test("comments, strings, templates and regular expressions are not read as imports", () => {
  const source = [
    '// import { x } from "./nowhere.js";',
    "/* export * from './nowhere.js'; */",
    'const a = "import(\'./nowhere.js\')";',
    "const b = `export * from ${a} and import(x)`;",
    "const c = /import\\(/u;",
    'import { y } from "./real.js";',
  ].join("\n");
  assert.deepEqual(readImports(source), { specifiers: [{ specifier: "./real.js", line: 6 }], problems: [] });
});

test("multi-line, default, namespace and bare imports are all read", () => {
  const source = [
    'import a from "./a.js";',
    'import * as b from "./b.js";',
    "import {",
    "  c,",
    "  d,",
    '} from "./c.js";',
    'import e, { f } from "./e.js";',
    'import "./g.js";',
  ].join("\n");
  assert.deepEqual(
    readImports(source).specifiers.map((entry) => entry.specifier),
    ["./a.js", "./b.js", "./c.js", "./e.js", "./g.js"],
  );
});
