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
  // The monitor sees what the list saw, so Watching can be compared with it.
  probe_player_count: ({ address }) =>
    browsePayload().servers.find((row) => row.address === address)?.server.occupancy.clients_reported ?? 3,
};

window.__TAURI__ = {
  core: {
    invoke: (command, args) => {
      const result = RESULTS[command];
      return Promise.resolve((typeof result === "function" ? result(args) : result) ?? null);
    },
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
const played = Number(params.get("history") ?? 0);
if (favorites > 0 || played > 0) {
  const identify = (row) => ({
    address: row.address,
    queryPort: row.server.endpoint.query_port,
    hostname: row.server.hostname,
  });
  const servers = RESULTS.browse_servers.servers;
  const history = servers.slice(3, 3 + played).map((row, index) => ({
    ...identify(row),
    lastLaunchedAt: new Date(Date.now() - (index + 1) * 5_400_000).toISOString(),
    launches: index + 1,
  }));
  localStorage.setItem(
    "reveille.bookmarks",
    JSON.stringify({ v: 1, favorites: servers.slice(0, favorites).map(identify), history }),
  );
}

const watched = Number(params.get("watch") ?? 0);
if (watched > 0) {
  const alerts = RESULTS.browse_servers.servers.slice(1, 1 + watched).map((row) => ({
    game: "allied_assault",
    address: row.address,
    queryPort: row.server.endpoint.query_port,
    hostname: row.server.hostname,
  }));
  // One watched server the sweep did not return, as a server that went quiet overnight would be.
  alerts.push({
    game: "allied_assault",
    address: "203.0.113.77:12203",
    queryPort: 12300,
    hostname: "[FR] Les Anciens | Objective",
  });
  localStorage.setItem("reveille.player-alerts", JSON.stringify(alerts));
  localStorage.setItem("reveille.arrival-events", JSON.stringify([{
    id: "preview-arrival",
    game: "allied_assault",
    address: alerts[0].address,
    queryPort: alerts[0].queryPort,
    hostname: alerts[0].hostname,
    count: 2,
    at: Date.now() - 2 * 3_600_000,
    read: false,
  }]));
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
