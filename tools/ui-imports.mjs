// SPDX-License-Identifier: GPL-3.0-only

// Gate 7: the shell's module boundaries (refactor plan, Phase 4b).
//
// The shell has no bundler, so nothing else knows which module may import which. This reads a
// deliberately restricted import syntax rather than all of JavaScript: `import … from "./x.js"`,
// `import "./x.js"`, and exports of local bindings. Anything else that imports or re-exports is a
// failure, so a form this reader does not understand cannot slip past it.

import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

/** Loaded by an HTML page, so nothing may import them. */
export const ENTRY_POINTS = ["app.js", "popup.js"];

const BRIDGE = "lib/bridge.js";
const FEATURE = /^features\/([^/]+)\//u;
const FEATURE_API = /^features\/[^/]+\/api\.js$/u;

/**
 * Blank out comments and the contents of strings, templates and regular expressions, keeping every
 * offset, so keywords are only found in code and a specifier can be read back from the original.
 */
export function maskSource(source) {
  const out = source.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  // A `/` starts a regular expression where an operand is expected, which the previous
  // significant character decides well enough for this codebase.
  const operandBefore = (i) => {
    let j = i - 1;
    while (j >= 0 && /\s/u.test(source[j])) j -= 1;
    if (j < 0) return true;
    if ("(,=:[!&|?{};+-*%<>~^".includes(source[j])) return true;
    const word = /[\w$]+$/u.exec(source.slice(Math.max(0, j - 10), j + 1));
    return word !== null && ["return", "typeof", "case", "do", "else", "in", "of"].includes(word[0]);
  };
  const templates = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else if (c === "`" || (c === "}" && templates.at(-1) === 0)) {
      if (c === "}") templates.pop();
      let j = i + 1;
      while (j < source.length && source[j] !== "`" && !(source[j] === "$" && source[j + 1] === "{")) {
        j += source[j] === "\\" ? 2 : 1;
      }
      blank(i + 1, j);
      if (source[j] === "$") {
        templates.push(0);
        i = j + 2;
      } else i = j + 1;
    } else if (c === "/" && operandBefore(i)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (inClass || source[j] !== "/")) {
        if (source[j] === "\\") j += 1;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j += 1;
      }
      blank(i + 1, j);
      i = j + 1;
    } else {
      if (templates.length > 0) {
        if (c === "{") templates[templates.length - 1] += 1;
        else if (c === "}") templates[templates.length - 1] -= 1;
      }
      i += 1;
    }
  }
  return out.join("");
}

const IMPORT_FROM =
  /^import\s+(?:[\w$]+\s*(?:,\s*)?)?(?:\{[^}]*\}|\*\s*as\s+[\w$]+)?\s*from\s*(["'])(\s*)\1/u;
const IMPORT_BARE = /^import\s*(["'])(\s*)\1/u;
const EXPORT_LOCAL_LIST = /^export\s*\{[^}]*\}(?!\s*from\b)/u;
const EXPORT_DECLARATION = /^export\s+(?:default\b|const\b|let\b|var\b|function\b|class\b|async\s+function\b)/u;

/** The static imports of one module, or the forms it uses that this gate does not accept. */
export function readImports(source) {
  const masked = maskSource(source);
  const specifiers = [];
  const problems = [];
  for (const match of masked.matchAll(/(?<![\w$.])(import|export)(?![\w$])/gu)) {
    const at = match.index;
    const rest = masked.slice(at);
    const line = masked.slice(0, at).split("\n").length;
    if (match[1] === "import") {
      const form = IMPORT_FROM.exec(rest) ?? IMPORT_BARE.exec(rest);
      if (form) {
        const start = at + form[0].length - form[2].length - 1;
        specifiers.push({ specifier: source.slice(start, start + form[2].length), line });
      } else if (/^import\s*\(/u.test(rest)) {
        problems.push(`line ${line}: dynamic import()`);
      } else {
        problems.push(`line ${line}: an import form this gate does not read`);
      }
    } else if (/^export\s*\*/u.test(rest) || /^export\s*\{[^}]*\}\s*from\b/u.test(rest)) {
      problems.push(`line ${line}: re-export; import the binding, then export it`);
    } else if (!EXPORT_LOCAL_LIST.test(rest) && !EXPORT_DECLARATION.test(rest)) {
      problems.push(`line ${line}: an export form this gate does not read`);
    }
  }
  return { specifiers, problems };
}

/** Every file under the shell root, keyed by its path relative to that root. */
export function readShell(root) {
  const files = new Map();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.set(relative(root, path).split(sep).join("/"), readFileSync(path, "utf8"));
  }
  return files;
}

/**
 * Every boundary violation in a shell tree.
 *
 * `files` maps each path relative to the shell root (`lib/store.js`) to its source. Only `.js`
 * modules are read for imports; every file is searched for the bridge global.
 */
export function importViolations(files) {
  const failures = [];
  const modules = [...files.keys()].filter((path) => path.endsWith(".js")).sort();
  const graph = new Map(modules.map((path) => [path, []]));

  for (const [path, source] of files) {
    if (path !== BRIDGE && source.includes("__TAURI__")) {
      failures.push(`${path}: only ${BRIDGE} may read __TAURI__`);
    }
  }

  for (const from of modules) {
    const { specifiers, problems } = readImports(files.get(from));
    for (const problem of problems) failures.push(`${from}: ${problem}`);
    for (const { specifier, line } of specifiers) {
      const where = `${from}: line ${line}`;
      if (!/^\.\.?\//u.test(specifier) || !specifier.endsWith(".js")) {
        failures.push(`${where}: "${specifier}" is not a relative path to a .js module`);
        continue;
      }
      const to = posix.normalize(posix.join(posix.dirname(from), specifier));
      if (to.startsWith("../") || !files.has(to)) {
        failures.push(`${where}: "${specifier}" names no module in the shell`);
        continue;
      }
      graph.get(from).push(to);

      if (ENTRY_POINTS.includes(to)) {
        failures.push(`${where}: imports the entry point ${to}`);
      }
      if (to === BRIDGE && !from.startsWith("lib/") && !FEATURE_API.test(from)) {
        failures.push(`${where}: only lib/ and features/*/api.js may import ${BRIDGE}`);
      }
      if (from.startsWith("lib/") && to.startsWith("features/")) {
        failures.push(`${where}: lib/ never imports a feature (${to})`);
      }
      const fromFeature = FEATURE.exec(from)?.[1];
      const toFeature = FEATURE.exec(to)?.[1];
      if (fromFeature && toFeature && fromFeature !== toFeature && to !== `features/${toFeature}/index.js`) {
        failures.push(`${where}: reaches into another feature (${to}); go through its index.js`);
      }
    }
  }

  failures.push(...cycles(graph));
  return failures;
}

function cycles(graph) {
  const found = [];
  const state = new Map();
  const stack = [];
  const visit = (node) => {
    state.set(node, "open");
    stack.push(node);
    for (const next of graph.get(node)) {
      if (state.get(next) === "open") {
        found.push(`import cycle: ${[...stack.slice(stack.indexOf(next)), next].join(" -> ")}`);
      } else if (!state.has(next)) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };
  for (const node of graph.keys()) if (!state.has(node)) visit(node);
  return found;
}
