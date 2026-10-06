// SPDX-License-Identifier: GPL-3.0-only

// `lib/open-server.js`: the shell's `openServer` intent, as an alert's Show and Join use it. A
// request waits for a sweep or a join to end, a newer request replaces one in flight, and a request
// that ends early leaves nothing behind to block the next.

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../fakes/dom.js";

const document = installDom();
const dialog = document.createElement("dialog");
const title = document.createElement("h2");
const body = document.createElement("div");
const byId = { "#info-dialog": dialog, "#info-dialog-title": title, "#info-dialog-body": body };
document.querySelector = (selector) => byId[selector] ?? null;

const { composeState, state } = await import("../../ui/lib/store.js");
const { initial: serversState } = await import("../../ui/features/servers/index.js");
const { initial: joinState } = await import("../../ui/features/join/index.js");
const { openServerWorkflow } = await import("../../ui/lib/open-server.js");

composeState([serversState(), joinState()]);

const settle = () => new Promise((resolve) => setImmediate(resolve));

const target = (address, extra = {}) => ({
  game: "allied_assault",
  address,
  queryPort: 12300,
  hostname: `Server ${address}`,
  ...extra,
});

/** A workflow whose steps are recorded, with each check held until the test answers it. */
function workflow({ clients = 3 } = {}) {
  const calls = [];
  const checks = [];
  const flow = openServerWorkflow({
    selectGame: async (game) => {
      calls.push(["selectGame", game]);
      state.game = game;
    },
    browseFinished: async () => calls.push(["browseFinished"]),
    check: ({ address, queryPort }) => {
      calls.push(["check", address, queryPort]);
      return new Promise((resolve) =>
        checks.push(() => resolve({ address, server: { occupancy: { clients_reported: clients, bots_reported: 0 } } })),
      );
    },
    reveal: (address) => calls.push(["reveal", address]),
    select: (address) => calls.push(["select", address]),
    activate: (address) => calls.push(["activate", address]),
    focus: async () => calls.push(["focus"]),
  });
  return { flow, calls, checks };
}

function ready() {
  state.install = { root: "C:/Games/MOHAA", playable: ["allied_assault", "spearhead"] };
  state.game = "allied_assault";
  state.browse = { ...state.browse, running: false };
  state.joining = false;
  if (dialog.open) dialog.close();
}

test("Show asks the server again, then reveals and selects it without joining", async () => {
  ready();
  const { flow, calls, checks } = workflow();
  flow.openServer(target("a:1"));
  await settle();
  checks.shift()();
  await settle();
  assert.deepEqual(calls, [["focus"], ["check", "a:1", 12300], ["reveal", "a:1"], ["select", "a:1"]]);
});

test("Join on a server in another game switches game first and joins as a double-click would", async () => {
  ready();
  const { flow, calls, checks } = workflow();
  flow.openServer(target("b:1", { game: "spearhead", join: true }));
  await settle();
  checks.shift()();
  await settle();
  assert.deepEqual(calls.slice(1), [
    ["selectGame", "spearhead"],
    ["check", "b:1", 12300],
    ["reveal", "b:1"],
    ["select", "b:1"],
    ["activate", "b:1"],
  ]);
});

test("Join on an empty server stops at the selection and says why", async () => {
  ready();
  const { flow, calls, checks } = workflow({ clients: 0 });
  flow.openServer(target("a:1", { join: true }));
  await settle();
  checks.shift()();
  await settle();
  assert.ok(!calls.some(([step]) => step === "activate"));
  assert.equal(title.textContent, "No players right now");
});

test("a request made while a sweep runs is delivered once the shell resumes it", async () => {
  ready();
  state.browse = { ...state.browse, running: true };
  const { flow, calls, checks } = workflow();
  flow.openServer(target("a:1"));
  await settle();
  assert.deepEqual(calls, [["focus"]], "nothing is checked while the sweep owns the list");

  flow.resume();
  await settle();
  assert.deepEqual(calls, [["focus"]], "resuming during the sweep still waits");

  state.browse = { ...state.browse, running: false };
  flow.resume();
  await settle();
  checks.shift()();
  await settle();
  assert.deepEqual(calls.slice(1), [["check", "a:1", 12300], ["reveal", "a:1"], ["select", "a:1"]]);
});

test("a second request made during the first one's check replaces it", async () => {
  ready();
  const { flow, calls, checks } = workflow();
  flow.openServer(target("a:1", { join: true }));
  await settle();
  flow.openServer(target("b:1"));
  await settle();
  checks.shift()();
  await settle();
  checks.shift()();
  await settle();
  assert.deepEqual(calls.filter(([step]) => step !== "focus"), [
    ["check", "a:1", 12300],
    ["check", "b:1", 12300],
    ["reveal", "b:1"],
    ["select", "b:1"],
  ]);
});

test("a server this install cannot play is refused, and the next request still runs", async () => {
  ready();
  state.install = { root: "C:/Games/MOHAA", playable: ["allied_assault"] };
  const { flow, calls, checks } = workflow();
  flow.openServer(target("c:1", { game: "breakthrough" }));
  await settle();
  assert.equal(title.textContent, "Server unavailable");
  assert.ok(!calls.some(([step]) => step === "check"));

  flow.openServer(target("a:1"));
  await settle();
  assert.equal(dialog.open, false, "a new request closes the dialog the last one left");
  checks.shift()();
  await settle();
  assert.deepEqual(calls.at(-1), ["select", "a:1"]);
});

test("a server that stops answering is reported rather than selected", async () => {
  ready();
  const flow = openServerWorkflow({
    selectGame: async () => {},
    browseFinished: async () => {},
    check: async () => null,
    reveal: () => assert.fail("a silent server is not revealed"),
    select: () => assert.fail("a silent server is not selected"),
    activate: () => assert.fail("a silent server is not joined"),
    focus: async () => {},
  });
  flow.openServer(target("a:1", { join: true }));
  await settle();
  assert.equal(title.textContent, "Server unavailable");
  assert.equal(dialog.open, true);
});
