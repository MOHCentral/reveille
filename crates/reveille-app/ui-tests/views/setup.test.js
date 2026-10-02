// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../fakes/dom.js";
import { installStorage } from "../fakes/storage.js";
import { installTauri } from "../fakes/tauri.js";

const document = installDom();
installStorage();
const bridge = installTauri();
const store = await import("../../ui/lib/store.js");
const { setupView } = await import("../../ui/views/setup.js");

const GAMES = ["allied_assault", "spearhead", "breakthrough"];
const INSTALL = { root: "C:\\Games\\MOHAA", products: GAMES, playable: GAMES };
const MB = 1024 * 1024;

function overview({ installed = ["original"], resolved = "original" } = {}) {
  return {
    resolved,
    capabilities: { engines: ["openmohaa", "reborn", "original"] },
    inventory: {
      original_installed: installed.includes("original"),
      openmohaa_installed: installed.includes("openmohaa"),
      reborn_installed: installed.includes("reborn"),
      reborn_build: { state: installed.includes("reborn") ? "current" : "absent" },
    },
    reborn: { version: "1.12", size: 9 * MB, filename: "reborn.zip", sha256: "0", supported: true },
    selection_error: null,
  };
}

const OPEN_STATUS = {
  availability: "available",
  package: { version: "v0.82.1", prerelease: false, size: 40 * MB, asset_name: "openmohaa.zip", digest: "0", offer_id: "offer" },
  installed_build: { state: "absent" },
  activity: { state: "stopped" },
};

function answer({ storage = { status: "writable" }, installed, resolved } = {}) {
  bridge.reset();
  const engines = overview({ installed, resolved });
  bridge.results = {
    detect_install: INSTALL,
    identify_install: INSTALL,
    engine_overview: engines,
    select_engine: engines,
    openmohaa_status: OPEN_STATUS,
    installation_storage: storage,
  };
}

function fakeDialog() {
  const body = document.createElement("div");
  const foot = document.createElement("div");
  const listeners = new Map();
  return {
    body, foot, open: false,
    querySelector: (selector) => (selector === "[data-setup-body]" ? body : foot),
    addEventListener: (type, handler) => listeners.set(type, handler),
    showModal() { this.open = true; },
    close() { this.open = false; listeners.get("close")?.(); },
  };
}

const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function nodes(node, found = []) {
  if (typeof node !== "object" || node === null) return found;
  found.push(node);
  for (const child of node.children ?? []) nodes(child, found);
  return found;
}

function textOf(node) {
  if (typeof node === "string") return node;
  return [node.textContent, ...(node.children ?? []).map(textOf)].filter(Boolean).join(" ");
}

function button(root, pattern) {
  return nodes(root).find((node) => node.tagName === "BUTTON" && pattern.test(textOf(node)));
}

function radio(root, engine) {
  return nodes(root).find((node) => node.tagName === "INPUT" && node.value === engine);
}

async function firstRun(options) {
  answer(options);
  store.state.install = null;
  store.state.rememberedInstall = null;
  const root = document.createElement("div");
  const dialog = fakeDialog();
  const applied = [];
  const setup = setupView(root, dialog, {
    onReady() {},
    onApply: (change) => applied.push(change),
    onUpdate() {},
    onReportBug() {},
  });
  setup.detect();
  await settle();
  return { root, dialog, setup, applied };
}

test("the first run offers the installed program without asking which game to play", async () => {
  const { root } = await firstRun();
  const text = textOf(root);

  assert.ok(button(root, /^Continue to servers$/u), "the installed program continues at once");
  assert.doesNotMatch(text, /Which game do you want to play/u);
  assert.match(text, /Opens on\s+Allied Assault/u);
  assert.match(text, /Switch to Spearhead or Breakthrough from the title bar/u);
  assert.match(text, /Recommended/u);
  assert.match(text, /40\.0 MB download/u, "OpenMoHAA is priced on its row before it is chosen");
  assert.match(text, /9\.0 MB download/u);
});

test("choosing a program that is not installed prices the one button that finishes setup", async () => {
  const { root } = await firstRun();
  radio(root, "openmohaa").dispatch("change");
  await settle();

  const action = button(root, /Install OpenMoHAA/u);
  assert.equal(textOf(action), "Install OpenMoHAA (40.0 MB) and continue");
  assert.ok(!action.disabled);
  assert.equal(button(root, /^Continue to servers$/u), undefined, "there is only one primary action");
});

test("a protected folder keeps the original game playable and says why installs wait", async () => {
  const storage = { status: "protected", folders: [INSTALL.root], source_bytes: 1_288_490_188, suggested_destination: "D:\\MOHAA" };
  const { root } = await firstRun({ storage });

  assert.match(textOf(root), /Windows protects this game folder/u);
  assert.ok(button(root, /^Make a copy \(1\.2 GB\)$/u), "the copy is priced before it starts");
  assert.ok(!button(root, /^Continue to servers$/u).disabled);

  radio(root, "openmohaa").dispatch("change");
  await settle();
  assert.match(textOf(root), /Needs a copy/u);
  assert.ok(button(root, /^Make a copy to install OpenMoHAA$/u).disabled);
});

test("the change dialog keeps the session's game and reports only a real change", async () => {
  const { dialog, setup, applied } = await firstRun({ installed: ["original", "reborn"] });
  store.state.install = INSTALL;
  store.state.engine = "original";
  store.state.game = "spearhead";

  setup.change();
  await settle();
  assert.ok(dialog.open);
  assert.match(textOf(dialog.body), /Installed · in use/u);
  assert.ok(button(dialog.foot, /^No changes$/u).disabled, "confirming nothing is not offered");
  assert.ok(!button(dialog.foot, /^Cancel$/u).disabled);

  radio(dialog.body, "reborn").dispatch("change");
  await settle();
  button(dialog.foot, /^Switch to Reborn$/u).dispatch("click");
  await settle();

  assert.equal(dialog.open, false);
  assert.deepEqual(applied, [{ install: INSTALL, engine: "reborn", game: "spearhead" }]);
  assert.ok(bridge.calls.some((call) => call.command === "select_engine" && call.args.engine === "reborn"));
});

test("a saved folder that is gone asks for the folder again instead of showing raw errors", async () => {
  const { dialog, setup } = await firstRun();
  store.state.install = INSTALL;
  store.state.engine = "openmohaa";
  store.state.game = "allied_assault";
  bridge.fail("identify_install", `install path is not a directory: ${INSTALL.root}`);
  bridge.calls.length = 0;

  setup.change();
  await settle();
  const text = textOf(dialog.body);
  assert.match(text, /cannot find the game in this folder any more/u);
  assert.doesNotMatch(text, /not a directory|could not be checked/u);
  assert.ok(!bridge.calls.some((call) => ["engine_overview", "installation_storage"].includes(call.command)),
    "no program or storage check runs against a folder that is gone");
  assert.ok(button(dialog.body, /^Change folder…$/u));
  assert.equal(textOf(button(dialog.foot, /Choose a game folder/u)), "Choose a game folder");
  assert.ok(!bridge.calls.some((call) => call.command === "detect_install"),
    "reopening the dialog is not reported as a new detection");
});

test("a saved folder that lost the session's game offers to apply the game it still has", async () => {
  const { dialog, setup, applied } = await firstRun();
  const shrunk = { ...INSTALL, products: ["allied_assault"], playable: ["allied_assault"] };
  bridge.results.identify_install = shrunk;
  store.state.install = INSTALL;
  store.state.engine = "original";
  store.state.game = "spearhead";

  setup.change();
  await settle();
  const action = button(dialog.foot, /^Use this folder$/u);
  assert.ok(action && !action.disabled, "the refreshed folder is not reported as no change");
  action.dispatch("click");
  await settle();

  assert.deepEqual(applied, [{ install: shrunk, engine: "original", game: "allied_assault" }]);
});
