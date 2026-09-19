// SPDX-License-Identifier: GPL-3.0-only

import test from "node:test";
import assert from "node:assert/strict";

import { installDom } from "../fakes/dom.js";
import { installStorage } from "../fakes/storage.js";

const document = installDom();
installStorage();
const store = await import("../../ui/lib/store.js");
const { joinView } = await import("../../ui/views/join.js");

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

function renderText(preview) {
  reset(preview);
  const root = document.createElement("div");
  const view = joinView(root, {
    onInstallServerFiles() {},
    onJoin() {},
    onRecheck() {},
  });
  view.render();
  return textOf(root);
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
