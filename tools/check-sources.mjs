// SPDX-License-Identifier: GPL-2.0-only

// Three gates nothing else covers.
//
// 1. The shell's frontend has no build step, so a syntax error in it first appears as a blank
//    window rather than as a failed build.
// 2. CLAUDE.md requires `SPDX-License-Identifier: GPL-2.0-only` in every source file; the
//    repository licence is GPL-2.0-only and a missing header is a licensing defect, not a style
//    one.
// 3. Rule S3 forbids every elevation path, including setup-time helpers. A code review can miss
//    one verb or manifest change; the source gate must not.
//
// The owned source tree is checked directly, including new files not yet added to Git. Generated
// and third-party directories are excluded explicitly.

import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SPDX = "SPDX-License-Identifier: GPL-2.0-only";
// Extensions that carry a comment syntax and belong to us. JSON has no comments, and the
// frozen fixtures under tests/fixtures are captured wire data that must stay byte-faithful.
const NEEDS_HEADER = [".rs", ".js", ".mjs", ".css", ".html", ".yml", ".yaml"];

function ownedFiles() {
  const excluded = new Set([".git", "target", "node_modules", "gen"]);
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) found.push(relative(repository, path).split(sep).join("/"));
    }
  };
  visit(repository);
  return found;
}

const files = ownedFiles();
const failures = [];

// --- 1. JavaScript parses -------------------------------------------------

const scripts = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));
for (const file of scripts) {
  try {
    // This asks Node's own parser to parse the complete ES module without executing it. Keeping the
    // parse in-process also lets `just check` run in restricted Windows shells that forbid a Node
    // process from spawning another Node process.
    const source = readFileSync(join(repository, file), "utf8");
    const parsed = stripTypeScriptTypes(source, { mode: "strip" });
    if (parsed !== source) failures.push(`${file}: contains TypeScript syntax in a JavaScript file`);
  } catch (error) {
    const detail = String(error.message).trim();
    failures.push(`${file}: does not parse\n${detail}`);
  }
}

// The protected-install copy moves three related preferences as one transaction. Exercise the
// actual browser-storage behavior here, offline, rather than only checking that the function is
// spelled in the setup source. `store.js` imports the bookmark store, so the same in-memory shim
// deliberately covers all module-load reads too.
const stored = new Map([
  ["reveille.install", "C:\\Program Files\\MOHAA"],
  [
    "reveille.engines",
    JSON.stringify({ "C:\\Program Files\\MOHAA": "reborn", "D:\\Keep": "original" }),
  ],
  [
    "reveille.games",
    JSON.stringify({ "C:\\Program Files\\MOHAA": "spearhead", "D:\\Keep": "breakthrough" }),
  ],
]);
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
};
try {
  const store = await import(pathToFileURL(join(repository, "crates/reveille-app/ui/lib/store.js")));
  store.migrateInstallationPreferences(
    "C:\\Program Files\\MOHAA",
    "C:\\Users\\Player\\Games\\MOHAA",
    "reborn",
    "spearhead",
  );
  const engines = JSON.parse(stored.get("reveille.engines"));
  const games = JSON.parse(stored.get("reveille.games"));
  if (
    stored.get("reveille.install") !== "C:\\Users\\Player\\Games\\MOHAA" ||
    engines["C:\\Program Files\\MOHAA"] !== undefined ||
    engines["C:\\Users\\Player\\Games\\MOHAA"] !== "reborn" ||
    engines["D:\\Keep"] !== "original" ||
    games["C:\\Program Files\\MOHAA"] !== undefined ||
    games["C:\\Users\\Player\\Games\\MOHAA"] !== "spearhead" ||
    games["D:\\Keep"] !== "breakthrough"
  ) {
    failures.push("ui/lib/store.js: installation-copy preference migration is not atomic");
  }
} catch (error) {
  failures.push(`ui/lib/store.js: preference migration test failed\n${error}`);
}

// Tauri can serialize canonical Windows paths with the extended-length prefix. Stub the bridge and
// exercise the one error normalizer all player-facing command failures use.
globalThis.window = {
  __TAURI__: {
    core: { invoke: () => undefined },
    event: { listen: () => undefined },
    opener: { openUrl: () => undefined },
  },
};
try {
  const api = await import(pathToFileURL(join(repository, "crates/reveille-app/ui/lib/api.js")));
  const normalized = api.errorText(String.raw`Windows protects \\?\C:\Program Files\MOHAA`);
  if (normalized !== String.raw`Windows protects C:\Program Files\MOHAA`) {
    failures.push(`ui/lib/api.js: extended Windows path prefix reached player-facing text: ${normalized}`);
  }
} catch (error) {
  failures.push(`ui/lib/api.js: error normalization test failed\n${error}`);
}

// --- 2. SPDX headers ------------------------------------------------------

const headered = files.filter((file) => NEEDS_HEADER.some((suffix) => file.endsWith(suffix)));
for (const file of headered) {
  // The identifier belongs at the top; reading the first 2 KiB avoids loading large sources
  // while still allowing a shebang or a leading block comment above it.
  const head = readFileSync(join(repository, file), "utf8").slice(0, 2048);
  if (!head.includes(SPDX)) {
    failures.push(`${file}: missing ${SPDX}`);
  }
}

// --- 3. No elevation path -------------------------------------------------

const executableSources = files.filter(
  (file) =>
    file.startsWith("crates/") ||
    file.startsWith(".github/") ||
    file === "crates/reveille-app/tauri.conf.json",
);
const elevationPatterns = [
  [/(?<![A-Za-z])runas(?![A-Za-z])/iu, "Windows run-as verb"],
  [/ShellExecute(?:Ex)?/u, "Windows shell elevation API"],
  [/requireAdministrator/iu, "administrator execution level"],
  [/highestAvailable/iu, "highest-available execution level"],
  [/(?<![A-Za-z])sudo(?![A-Za-z])/u, "sudo helper"],
  [/(?<![A-Za-z])pkexec(?![A-Za-z])/u, "pkexec helper"],
];
for (const file of executableSources) {
  const source = readFileSync(join(repository, file), "utf8");
  for (const [pattern, description] of elevationPatterns) {
    if (pattern.test(source)) failures.push(`${file}: contains forbidden ${description} (${pattern})`);
  }
}

const tauriConfig = JSON.parse(
  readFileSync(join(repository, "crates/reveille-app/tauri.conf.json"), "utf8"),
);
if (tauriConfig.bundle?.windows?.nsis?.installMode !== "currentUser") {
  failures.push("crates/reveille-app/tauri.conf.json: NSIS installMode must remain currentUser (rule S3)");
}

// --- Report ---------------------------------------------------------------

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error(`\n${failures.length} problem(s) in ${files.length} owned files.`);
  process.exit(1);
}

console.log(
  `${scripts.length} scripts parse, ${headered.length} sources carry the SPDX header, and no elevation path exists.`,
);
