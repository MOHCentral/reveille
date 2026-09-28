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

const GAMES = ["allied_assault", "spearhead", "breakthrough"];
const install = params.has("games")
  ? { ...INSTALL, products: GAMES, playable: GAMES.slice(0, Number(params.get("games"))) }
  : INSTALL;

let sweeps = 0;
const RESULTS = {
  detect_install: install,
  engine_overview: OVERVIEW,
  select_engine: OVERVIEW,
  installation_storage: { status: "writable" },
  check_reveille_update: null,
  // ?drift=1 moves some player counts on every sweep after the first, so the trend arrows show.
  browse_servers: () => {
    sweeps += 1;
    const payload = browsePayload();
    if (!params.has("drift") || sweeps < 2) return payload;
    payload.servers.forEach((row, index) => {
      const occupancy = row.server.occupancy;
      const step = [2, -3, 0, 1, 0, -1][index % 6];
      occupancy.clients_reported = Math.max(0, Math.min(row.server.client_capacity, occupancy.clients_reported + step));
    });
    payload.summary.clients_reported = payload.servers.reduce(
      (sum, row) => sum + row.server.occupancy.clients_reported,
      0,
    );
    return payload;
  },
  check_server: ({ address }) => ({
    row: browsePayload().servers.find((row) => row.address === address) ?? null,
    non_result: { stage: "status", reason: "timeout" },
  }),
  // The monitor sees what the list saw, so Watching can be compared with it.
  read_watched_server: ({ address }) => {
    const server = browsePayload().servers.find((row) => row.address === address)?.server;
    return {
      clients: server?.occupancy.clients_reported ?? 3,
      bots: server?.occupancy.bots_reported ?? 0,
      map: server?.current_map ?? "obj/obj_team1",
      mode: server?.game_type ?? "Objective-Match",
      round_trip: server?.status_round_trip ?? 48,
    };
  },
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
  const servers = browsePayload().servers;
  const history = servers.slice(3, 3 + played).map((row, index) => ({
    ...identify(row),
    lastLaunchedAt: new Date(Date.now() - (index + 1) * 5_400_000).toISOString(),
    launches: index + 1,
  }));
  localStorage.setItem(
    "reveille.bookmarks",
    JSON.stringify({
      v: 1,
      // One starred server the sweep did not return, so the offline fold shows.
      favorites: [
        ...servers.slice(0, favorites).map(identify),
        { address: "203.0.113.90:12203", queryPort: 12300, hostname: "[UK] Old Guard | Stalingrad" },
      ],
      history,
    }),
  );
}

const watched = Number(params.get("watch") ?? 0);
if (watched > 0) {
  const alerts = browsePayload().servers.slice(1, 1 + watched).map((row) => ({
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
    detail: "dm/chantilly · Team-Match · 25 ms",
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
