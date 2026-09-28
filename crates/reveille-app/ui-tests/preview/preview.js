// SPDX-License-Identifier: GPL-3.0-only

import { INSTALL, browsePayload } from "./fixture.js";

const SHELL = new URL("../../ui/", import.meta.url);
const params = new URLSearchParams(location.search);

const OVERVIEW = {
  resolved: "original",
  capabilities: { engines: ["original"] },
  inventory: { original_installed: true, openmohaa_installed: false, reborn_installed: false },
  reborn: { supported: false },
  selection_error: null,
};

const RESULTS = {
  detect_install: INSTALL,
  engine_overview: OVERVIEW,
  select_engine: OVERVIEW,
  installation_storage: { status: "writable" },
  check_reveille_update: null,
  browse_servers: browsePayload(),
  probe_player_count: 0,
};

window.__TAURI__ = {
  core: {
    invoke: (command) => Promise.resolve(RESULTS[command] ?? null),
  },
  event: { listen: () => Promise.resolve(() => {}) },
  opener: { openUrl: () => Promise.resolve() },
  window: {
    getCurrentWindow: () => ({
      setFocus: () => Promise.resolve(),
      requestUserAttention: () => Promise.resolve(),
    }),
    UserAttentionType: { Informational: 2 },
  },
  notification: {
    isPermissionGranted: () => Promise.resolve(true),
    requestPermission: () => Promise.resolve("granted"),
  },
};

localStorage.clear();
localStorage.setItem("reveille.install", INSTALL.root);
const favorites = Number(params.get("favorites") ?? 0);
if (favorites > 0) {
  const saved = RESULTS.browse_servers.servers.slice(0, favorites).map((row) => ({
    address: row.address,
    queryPort: row.server.endpoint.query_port,
    hostname: row.server.hostname,
  }));
  localStorage.setItem("reveille.bookmarks", JSON.stringify({ v: 1, favorites: saved, history: [] }));
}

const watched = Number(params.get("watch") ?? 0);
if (watched > 0) {
  const alerts = RESULTS.browse_servers.servers.slice(1, 1 + watched).map((row) => ({
    game: "allied_assault",
    address: row.address,
    queryPort: row.server.endpoint.query_port,
    hostname: row.server.hostname,
  }));
  localStorage.setItem("reveille.player-alerts", JSON.stringify(alerts));
}

const page = new DOMParser().parseFromString(
  await (await fetch(new URL("index.html", SHELL))).text(),
  "text/html",
);
for (const link of page.head.querySelectorAll('link[rel="stylesheet"]')) {
  const sheet = document.createElement("link");
  sheet.rel = "stylesheet";
  sheet.href = new URL(link.getAttribute("href"), SHELL).href;
  document.head.append(sheet);
}
for (const script of page.body.querySelectorAll("script")) script.remove();
document.body.replaceChildren(...page.body.childNodes);
await import(new URL("app.js", SHELL).href);
