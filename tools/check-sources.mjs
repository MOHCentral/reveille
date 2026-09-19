// SPDX-License-Identifier: GPL-3.0-only

// Six gates nothing else covers.
//
// 1. The shell's frontend has no build step, so a syntax error in it first appears as a blank
//    window rather than as a failed build.
//
//    This is a *parse*, and only a parse. Until 19 Sep 2026 two behavioural assertions lived here
//    too — a localStorage shim exercising `store.js`'s preference migration, and a Tauri stub
//    exercising `api.js`'s error normaliser — because the frontend had no test runner and there
//    was nowhere else to put them. There is now: `crates/reveille-app/ui-tests`, run by
//    `just ui-test` (issue #12). Behaviour goes there. This script is source policy.
// 2. CLAUDE.md requires `SPDX-License-Identifier: GPL-3.0-only` in every source file; the
//    repository licence is GPL-3.0-only and a missing header is a licensing defect, not a style
//    one.
// 3. Rule S3 forbids every elevation path, including setup-time helpers. A code review can miss
//    one verb or manifest change; the source gate must not.
// 4. Rule S7 forbids packaging or publishing from a commit this gate rejects. Nothing in a
//    workflow file compiles, so a dropped `needs:` is invisible until a tag ships an unchecked
//    build — which is exactly how v0.2.1 was released (docs/plan.md).
// 5. The documented local gate and CI must execute the same checks. Until 19 Sep 2026 they did
//    not, silently: the justfile said `just check` was what CI ran while the two lists differed
//    (issue #8). Prose cannot hold that; this does.
// 6. The pinned compiler and the published `rust-version` must agree, or the manifest carries an
//    MSRV claim nothing ever compiles against.
//
// The owned source tree is checked directly, including new files not yet added to Git. Generated
// and third-party directories are excluded explicitly.

import { readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SPDX = "SPDX-License-Identifier: GPL-3.0-only";
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

// --- 4. Release cannot outrun the gate ------------------------------------

// Rule S7. `release.yml` must reach `ci.yml` through `needs:` from every job it runs, so a red
// gate leaves the packaging and publishing jobs skipped rather than merely accompanied by a
// failure nobody reads. Before 16 Sep 2026 the two workflows were independent and a tag did
// publish from a commit CI had rejected.
//
// The reachability is computed rather than pattern-matched, so splitting packaging, signing and
// publishing into separate jobs later keeps working as long as each one still descends from the
// gate.

/** Read the job map of a workflow: each job's `uses`, `if`, and `needs` list. */
function workflowJobs(source) {
  const lines = source.split(/\r?\n/);
  const jobs = new Map();
  let inJobs = false;
  let current = null;
  let pendingNeeds = false;
  for (const line of lines) {
    if (/^\S/u.test(line)) {
      inJobs = line.startsWith("jobs:");
      current = null;
      pendingNeeds = false;
      continue;
    }
    if (!inJobs) continue;
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/u.exec(line);
    if (job) {
      current = { name: job[1], uses: null, conditional: false, needs: [] };
      jobs.set(job[1], current);
      pendingNeeds = false;
      continue;
    }
    if (!current) continue;

    // A block sequence under `needs:`, which the key line below opened.
    if (pendingNeeds) {
      const item = /^ {4,}-\s*(.+?)\s*$/u.exec(line);
      if (item) {
        current.needs.push(item[1].replace(/^["']|["']$/gu, ""));
        continue;
      }
      pendingNeeds = false;
    }

    const key = /^ {4}([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (!key) continue;
    const [, name, value] = key;
    if (name === "uses") current.uses = value.trim();
    else if (name === "if") current.conditional = true;
    else if (name === "needs") {
      const rest = value.trim();
      if (rest === "") pendingNeeds = true;
      else if (rest.startsWith("[")) {
        current.needs.push(
          ...rest
            .slice(1, rest.lastIndexOf("]"))
            .split(",")
            .map((entry) => entry.trim().replace(/^["']|["']$/gu, ""))
            .filter(Boolean),
        );
      } else current.needs.push(rest.replace(/^["']|["']$/gu, ""));
    }
  }
  return jobs;
}

const GATE_WORKFLOW = ".github/workflows/ci.yml";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";

const gateSource = readFileSync(join(repository, GATE_WORKFLOW), "utf8");
if (!/^ {2}workflow_call:\s*$/mu.test(gateSource)) {
  failures.push(`${GATE_WORKFLOW}: must stay callable (\`workflow_call:\`) so Release reuses it`);
}

const releaseJobs = workflowJobs(readFileSync(join(repository, RELEASE_WORKFLOW), "utf8"));
// A reader that stopped finding jobs would pass every check below on an empty map, which is the
// one way this gate could fail open. Release has at least the gate and the job it gates.
if (releaseJobs.size < 2) {
  failures.push(
    `${RELEASE_WORKFLOW}: read ${releaseJobs.size} job(s) — the gate check cannot confirm anything and must not pass by default`,
  );
}
const gateJobs = [...releaseJobs.values()].filter((job) => job.uses === `$/${GATE_WORKFLOW}`);
if (gateJobs.length === 0) {
  failures.push(`${RELEASE_WORKFLOW}: must run the repository gate with \`uses: $/${GATE_WORKFLOW}\``);
} else {
  // An `if:` on the gate itself would let it be skipped, and a skipped dependency satisfies
  // `needs:`. The gate is unconditional or it is not a gate.
  for (const gate of gateJobs) {
    if (gate.conditional) {
      failures.push(`${RELEASE_WORKFLOW}: job "${gate.name}" runs the gate under \`if:\`, so it can be skipped`);
    }
  }
  const gated = new Set(gateJobs.map((gate) => gate.name));
  // Fixed point: a job is gated when it needs a gated job, however many hops away.
  for (let changed = true; changed; ) {
    changed = false;
    for (const job of releaseJobs.values()) {
      if (gated.has(job.name)) continue;
      if (job.needs.some((dependency) => gated.has(dependency))) {
        gated.add(job.name);
        changed = true;
      }
    }
  }
  for (const job of releaseJobs.values()) {
    if (!gated.has(job.name)) {
      failures.push(
        `${RELEASE_WORKFLOW}: job "${job.name}" does not depend on the gate, so it would run for a commit CI rejected (rule S7)`,
      );
    }
  }
}

// --- 5. The local gate and CI run the same checks --------------------------

// `ci.yml` is allowed to set a job up — check out, install a toolchain, install `just` — and then
// it must hand over. Every check lives in a `ci-*` recipe, so the justfile is the single
// definition and `just check` reproduces a CI failure exactly.
//
// Two halves, and both matter. Without the first, someone adds `- run: cargo bench` to a job and
// the local gate silently stops being the gate. Without the second, someone adds `ci-typecheck`
// to CI and forgets `check`, or removes it from `check` and leaves CI running it.

const CI_WORKFLOW = ".github/workflows/ci.yml";
const JUSTFILE = "justfile";

const ciSource = readFileSync(join(repository, CI_WORKFLOW), "utf8");

// Setup steps a job may run before handing over. Each one only selects or reports a tool version;
// none of them can pass or fail a check.
const SETUP_COMMANDS = [/^rustup toolchain install$/u];

const ciRecipesInWorkflow = new Set();
for (const line of ciSource.split(/\r?\n/)) {
  const step = /^\s*-?\s*run:\s*(.+?)\s*$/u.exec(line);
  if (!step) continue;
  const command = step[1];
  const recipe = /^just (ci-[a-z0-9-]+)$/u.exec(command);
  if (recipe) {
    ciRecipesInWorkflow.add(recipe[1]);
  } else if (!SETUP_COMMANDS.some((pattern) => pattern.test(command))) {
    failures.push(
      `${CI_WORKFLOW}: step \`run: ${command}\` defines a check in the workflow. Add it to a \`ci-*\` recipe in the justfile instead, so \`just check\` runs it too`,
    );
  }
}

const justSource = readFileSync(join(repository, JUSTFILE), "utf8");
const checkRecipe = /^check:(.*)$/mu.exec(justSource);
const ciRecipesInCheck = new Set();
if (!checkRecipe) {
  failures.push(`${JUSTFILE}: no \`check:\` recipe — the gate has no definition to compare against`);
} else {
  for (const dependency of checkRecipe[1].trim().split(/\s+/u).filter(Boolean)) {
    if (dependency.startsWith("ci-")) ciRecipesInCheck.add(dependency);
  }
}

for (const recipe of ciRecipesInWorkflow) {
  if (!ciRecipesInCheck.has(recipe)) {
    failures.push(
      `${CI_WORKFLOW}: runs \`just ${recipe}\`, but \`check\` in ${JUSTFILE} does not depend on it, so the local gate is weaker than CI`,
    );
  }
}
for (const recipe of ciRecipesInCheck) {
  if (!ciRecipesInWorkflow.has(recipe)) {
    failures.push(
      `${JUSTFILE}: \`check\` depends on \`${recipe}\`, but no job in ${CI_WORKFLOW} runs it, so a pull request is not held to it`,
    );
  }
}
if (ciRecipesInWorkflow.size === 0) {
  failures.push(
    `${CI_WORKFLOW}: no \`just ci-*\` step found — this check cannot confirm anything and must not pass by default`,
  );
}

// --- 6. The pinned compiler is the published one ---------------------------

const toolchain = /^\s*channel\s*=\s*"([^"]+)"/mu.exec(
  readFileSync(join(repository, "rust-toolchain.toml"), "utf8"),
);
const declared = /^\s*rust-version\s*=\s*"([^"]+)"/mu.exec(
  readFileSync(join(repository, "Cargo.toml"), "utf8"),
);
if (!toolchain) {
  failures.push("rust-toolchain.toml: no `channel` — nothing pins the compiler");
} else if (!declared) {
  failures.push("Cargo.toml: no `rust-version` — either declare the pinned compiler or remove the claim");
} else if (toolchain[1] !== declared[1]) {
  failures.push(
    `Cargo.toml: rust-version is ${declared[1]} but rust-toolchain.toml pins ${toolchain[1]} — an MSRV nothing compiles against`,
  );
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
  `${scripts.length} scripts parse, ${headered.length} sources carry the SPDX header, no elevation path exists, every Release job descends from the gate, and CI runs the same ${ciRecipesInCheck.size} recipes as \`just check\`.`,
);
