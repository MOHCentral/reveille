// SPDX-License-Identifier: GPL-3.0-only

// The behaviour inventory: every Rust and UI test, named by the behaviour it guards. Test names
// already state behaviour, so the list is generated rather than kept as a file that would drift.
//
// With a git ref, it prints only what changed since that ref, which is what a refactor PR lists in
// its description. A test whose name survives in another file is reported as moved, with Rust
// `snake_case` and UI sentence names compared as the same words, ignoring case and hyphens.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDED = new Set([".git", "target", "node_modules", "gen"]);

const RUST_TEST =
  /#\[(?:tokio::)?test(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/g;
const UI_TEST = /(?<![\w.])test\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function isTestSource(path) {
  return path.endsWith(".rs") || path.endsWith(".test.js");
}

function testsIn(path, source) {
  const pattern = path.endsWith(".rs") ? RUST_TEST : UI_TEST;
  const group = path.endsWith(".rs") ? 1 : 2;
  return [...source.matchAll(pattern)].map((match) => ({ file: path, name: match[group] }));
}

function workingTree() {
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const file = relative(repository, path).split(sep).join("/");
        if (isTestSource(file)) found.push(...testsIn(file, readFileSync(path, "utf8")));
      }
    }
  };
  visit(repository);
  return found;
}

function atRef(ref) {
  const git = (...args) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8", maxBuffer: 1 << 28 });
  return git("ls-tree", "-r", "--name-only", ref)
    .split("\n")
    .filter((file) => isTestSource(file) && !file.split("/").some((part) => EXCLUDED.has(part)))
    .flatMap((file) => testsIn(file, git("show", `${ref}:${file}`)));
}

const words = (name) => name.replace(/[_-]/g, " ").toLowerCase().trim();
const key = (test) => `${test.file} › ${words(test.name)}`;
const byKey = (tests) => [...tests].sort((a, b) => (key(a) < key(b) ? -1 : 1));

const [ref, ...rest] = process.argv.slice(2);
if (rest.length) {
  console.error("usage: just inventory [GIT_REF]");
  process.exitCode = 2;
} else if (!ref) {
  const tests = byKey(workingTree());
  for (const test of tests) console.log(key(test));
  console.log(`\n${tests.length} tests`);
} else {
  const before = atRef(ref);
  const after = workingTree();
  const beforeKeys = new Set(before.map(key));
  const afterKeys = new Set(after.map(key));
  const removed = byKey(before.filter((test) => !afterKeys.has(key(test))));
  const added = after.filter((test) => !beforeKeys.has(key(test)));
  const moved = new Set();

  console.log(`Removed or renamed since ${ref}:`);
  for (const test of removed) {
    const destinations = added.filter((candidate) => words(candidate.name) === words(test.name));
    for (const destination of destinations) moved.add(destination);
    console.log(`  ${key(test)}`);
    for (const destination of destinations) console.log(`    moved to ${destination.file}`);
  }
  if (!removed.length) console.log("  none");

  console.log("Added:");
  const fresh = byKey(added.filter((test) => !moved.has(test)));
  for (const test of fresh) console.log(`  ${key(test)}`);
  if (!fresh.length) console.log("  none");
  console.log(`\n${before.length} tests at ${ref}, ${after.length} now`);
}
