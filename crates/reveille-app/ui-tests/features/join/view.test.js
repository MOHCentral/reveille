// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../../fakes/dom.js";
import { installStorage } from "../../fakes/storage.js";

const document = installDom();
installStorage();
const store = await import("../../../ui/lib/store.js");
const { joinView } = await import("../../../ui/features/join/view.js");
const { initial: serversState } = await import("../../../ui/features/servers/index.js");
// The pane reads the server list's rows, selection and checks, so it composes that feature's state.
store.composeState([serversState()]);

const ADDRESS = "127.0.0.1:12203";

function assessment(state = "needs_maps") {
  return {
    state: { state, count: state === "compatible" ? undefined : 1 },
    current_map: { readiness: state === "compatible" ? "present" : "missing" },
  };
}

function row() {
  return {
    address: ADDRESS,
    compatibility: assessment(),
    server: {
      hostname: "Issue 6 fixture",
      current_map: "dm/mohdm1",
      game_type: "Objective-Match",
      game_version: "1.11",
      version: "Medal of Honor Allied Assault 1.11 win-x86 Mar 5 2002",
      occupancy: { clients_reported: 12, bots_reported: 0 },
      client_capacity: 28,
      status_round_trip: 46,
      rotation: ["dm/mohdm1", "obj/obj_team3"],
      allow_download: 1,
      map_checksum: 123,
      endpoint: { query_port: 12300 },
    },
  };
}

function exactCatalogue(size = 18_454_938) {
  return {
    resolutions: [
      {
        outcome: "exact",
        wanted: { name: "dm/mohdm1" },
        name_match: { id: 1, filename: "mohdm1.pk3", file_size: size },
      },
    ],
  };
}

function reset(preview) {
  store.state.servers = [row()];
  store.state.selected = ADDRESS;
  store.state.preview = { address: ADDRESS, server: row().server, ...preview };
  store.state.previewProgress = null;
  store.state.previewError = null;
  store.state.installRun = null;
  store.state.joining = false;
  store.state.joinResult = null;
  store.state.joinError = null;
  store.state.choices = new Map();
  store.state.checks = new Map();
  store.state.checkedAt = new Map();
  store.state.browse = { ...store.state.browse, running: false, completedAt: null };
}

function renderView(preview) {
  reset(preview);
  const root = document.createElement("div");
  const view = joinView(root, {
    onInstallServerFiles() {},
    onJoin() {},
    onRecheck() {},
    onTogglePlayerAlert() {},
  });
  view.render();
  return { root, view };
}

function renderText(preview) {
  return textOf(renderView(preview).root);
}

function textOf(node) {
  if (typeof node === "string") return node;
  return [node.textContent, ...(node.children ?? []).map(textOf)].filter(Boolean).join(" ");
}

test("pending server files hide the provisional catalogue price and do not promise a join", () => {
  const text = renderText({
    assessment: assessment(),
    pakradar: { pending: 8, non_result: null },
    // Deliberately include a stale provisional result: the view must still never price it.
    catalogue: exactCatalogue(),
  });

  assert.match(text, /8 server files/u);
  assert.match(text, /Download size not provided/u);
  assert.match(
    text,
    /Reveille will install and verify these files, then check whether anything else is needed\./u,
  );
  assert.match(text, /Get 8 server files/u);
  assert.doesNotMatch(text, /17\.6 MB/u);
  assert.doesNotMatch(text, /Get 8 server files & join/u);
});

test("the post-server-file rescan prices only the remaining catalogue download", () => {
  const text = renderText({
    assessment: assessment(),
    pakradar: { pending: 0, non_result: null },
    catalogue: exactCatalogue(),
  });

  assert.match(text, /17\.6 MB/u);
  assert.match(text, /to fetch · 1 file/u);
  assert.match(text, /Get 17\.6 MB & join/u);
  assert.doesNotMatch(text, /Download size not provided/u);
});

test("the post-server-file rescan offers Join when nothing remains", () => {
  const text = renderText({
    assessment: assessment("compatible"),
    pakradar: { pending: 0, non_result: null },
    catalogue: null,
  });

  assert.match(text, /Join/u);
  assert.doesNotMatch(text, /Get .*join/u);
  assert.doesNotMatch(text, /Download size not provided/u);
});

test("the pane leads with the six figures, labelled marks and Join", () => {
  const text = renderText({ assessment: assessment("compatible"), catalogue: null });

  assert.match(text, /Favorite/u);
  assert.match(text, /Watch/u);
  for (const figure of ["Players", "12", "/28", "Bots", "none", "46 ms", "dm/mohdm1", "Objective-Match", "1.11"]) {
    assert.ok(text.includes(figure), `missing ${figure}`);
  }
  assert.match(text, /Join/u);
  assert.match(text, /More about this server/u);
  assert.doesNotMatch(text, /win-x86/u);
  assert.doesNotMatch(text, /127\.0\.0\.1/u);
});

test("the More fold holds the address, map list, download policy and build", () => {
  const { root, view } = renderView({ assessment: assessment("compatible"), catalogue: null });
  const toggle = root.querySelector('[data-focus-key="detail-more"]');
  assert.equal(toggle.getAttribute("aria-expanded"), "false");

  toggle.dispatch("click");
  view.render();
  const text = textOf(root);

  assert.equal(root.querySelector('[data-focus-key="detail-more"]').getAttribute("aria-expanded"), "true");
  assert.match(text, /127\.0\.0\.1:12203/u);
  assert.match(text, /dm\/mohdm1, obj\/obj_team3/u);
  assert.match(text, /the server sends missing files/u);
  assert.match(text, /win-x86 Mar 5 2002/u);

  root.querySelector('[data-focus-key="detail-more"]').dispatch("click");
  view.render();
});

test("the players table lists names with scores and folds after eight", () => {
  const { root, view } = renderView({ assessment: assessment("compatible"), catalogue: null });
  assert.doesNotMatch(textOf(root), /Kills/u);

  store.state.servers[0].server.players = Array.from({ length: 10 }, (_, index) => ({
    name: index === 3 ? "" : `Player ${index}`,
    ping: 40 + index,
    kills: index,
    deaths: 1,
  }));
  view.render();
  let text = textOf(root);
  assert.match(text, /Kills/u);
  assert.match(text, /Player 9/u);
  assert.doesNotMatch(text, /Player 1\b/u);
  assert.match(text, /The server listed 10 of its 12 players\./u);

  root.querySelector('[data-focus-key="detail-players"]').dispatch("click");
  view.render();
  text = textOf(root);
  assert.match(text, /Player 1\b/u);
  assert.match(text, /No name/u);
  assert.match(text, /Show fewer/u);

  root.querySelector('[data-focus-key="detail-players"]').dispatch("click");
  view.render();
});

test("players without scores show only name and ping", () => {
  const { root, view } = renderView({ assessment: assessment("compatible"), catalogue: null });
  store.state.servers[0].server.players = [{ name: "<[TFC]>Goat", ping: 35, kills: null, deaths: null }];
  view.render();
  const text = textOf(root);
  assert.match(text, /<\[TFC\]>Goat/u);
  assert.match(text, /35/u);
  assert.doesNotMatch(text, /Kills/u);
  assert.equal(root.querySelector('[data-focus-key="detail-players"]'), null);
});

test("an activated row that needs downloads focuses the priced Join once it can take focus", () => {
  const { root, view } = renderView({ assessment: assessment(), catalogue: exactCatalogue() });
  store.state.preview = null;
  store.state.previewProgress = { index: -1, of: 0, map: "" };
  view.focusJoin(ADDRESS);
  const pricing = root.querySelector('[data-focus-key="join"]');
  assert.equal(pricing.disabled, true);
  assert.equal(pricing.focusCount, 0);

  store.state.previewProgress = null;
  store.state.preview = { address: ADDRESS, assessment: assessment(), catalogue: exactCatalogue() };
  view.render();
  const join = root.querySelector('[data-focus-key="join"]');
  assert.equal(join.focusCount, 1);
  assert.match(textOf(join), /Get 17\.6 MB & join/u);

  // Once is enough: a later repaint after the player moved on does not pull focus back.
  document.activeElement = null;
  view.render();
  assert.equal(root.querySelector('[data-focus-key="join"]').focusCount, 0);
});

test("the header refreshes this server and spins while it is asked", () => {
  const { root, view } = renderView({ assessment: assessment(), catalogue: exactCatalogue() });
  store.state.checkedAt = new Map([[ADDRESS, new Date().toISOString()]]);
  view.render();
  const reload = root.querySelector('[data-focus-key="detail-recheck"]');
  assert.equal(reload.getAttribute("aria-label"), "Refresh this server");
  assert.doesNotMatch(textOf(root), /Check again/u);

  store.state.checks = new Map([[ADDRESS, { status: "checking" }]]);
  view.render();
  const running = root.querySelector('[data-focus-key="detail-recheck"]');
  assert.equal(running.getAttribute("aria-disabled"), "true");
  assert.equal(running.getAttribute("aria-label"), "Refreshing this server");
  // The header says a check is running; Join keeps its own label rather than repeating it.
  assert.doesNotMatch(textOf(root.querySelector('[data-focus-key="join"]')), /Checking/u);
});
