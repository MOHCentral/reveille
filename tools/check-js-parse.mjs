// SPDX-License-Identifier: GPL-3.0-only

// Node's own parser over every module the shell loads, one process per file.
//
// This duplicates nothing. `check-sources.mjs` parses the same files *in process*, with
// `node:module`'s type-stripping parser, so that `just check` still runs in restricted Windows
// shells that forbid a Node process from spawning another Node process. That constraint makes it a
// policy script that happens to parse, not a parser — and a policy script is not a parser
// substitute (issue #8). This one is allowed to spawn, because if it cannot run the in-process
// check still covers the same files.
//
// It exists as a script rather than as a shell pipeline because `just` runs recipes under
// `cmd.exe` on Windows, which has neither `find` nor `xargs`. That is the same reason the recipe
// it replaces lived in CI only, where the gate could not be reproduced locally.

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const shell = join(repository, "crates", "reveille-app", "ui");

/** Every `.js` file the webview can load, in a stable order. */
function shellModules(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...shellModules(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) found.push(path);
  }
  return found;
}

const modules = shellModules(shell);
const failures = [];

for (const path of modules) {
  const name = relative(repository, path).split(sep).join("/");
  // `--check` parses and exits; it never evaluates the module, so a top-level `window` read is not
  // a problem here even though importing the same file would be.
  const parsed = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
  if (parsed.error) {
    failures.push(`${name}: could not run the parser\n${parsed.error.message}`);
  } else if (parsed.status !== 0) {
    failures.push(`${name}: does not parse\n${(parsed.stderr || "").trim()}`);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error(`\n${failures.length} problem(s) in ${modules.length} shell modules.`);
  process.exit(1);
}

console.log(`${modules.length} shell modules parse under Node's own parser.`);
