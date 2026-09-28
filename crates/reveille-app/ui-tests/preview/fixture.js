// SPDX-License-Identifier: GPL-3.0-only

// A deterministic Allied Assault browse result for the preview page, shaped like the payload
// `browse_servers` returns. Hostnames, maps and counts follow a real evening sweep so the layout is
// judged against realistic lengths, not lorem ipsum.

const GAME = "allied_assault";

// [hostname, map, mode, players, capacity, bots, ping, needs]
// `needs`: 0 compatible, n > 0 needs n maps, -1 map list not published, "x" no download.
const LIVE = [
  ["=|LuV|= Freeze-Tag Server @ www.luvclan.eu", "dm/mohdm2", "=|LuV|= Freeze-Tag", 25, 36, 0, 19, 0],
  ["[DSB]Clan DM", "dm/chantilly", "Team-Match", 4, 16, 0, 25, 0],
  ["= Pingperfect.com US Central =", "obj/obj_team2", "Objective-Match", 3, 32, 0, 124, 0],
  ["-=[PN]=- | Custom Objective | Bots + Squads", "m5l1a", "Ticket-Match", 1, 24, 22, 20, 1],
  ["=|LuV|= Custom Maps Server @ www.luvclan.eu", "dm/dm_rockbound", "=|LuV|= Freeze-Tag", 1, 40, 0, 21, 4],
  ["[ Julien ] [ MOHAA 03 | Round Based Match ]", "dm/mohdm1", "Round-Based-Match", 1, 64, 0, 18, 0],
  ["*** [FORTE] Rifles Only | Objective ***", "obj/obj_team4", "Objective-Match", 21, 32, 0, 14, 0],
  ["harzCore | Stock Maps 24/7", "dm/mohdm6", "Team-Match", 32, 32, 0, 21, 0],
  ["<[TFC]> The Fallen Comrades | Sniper Town", "dm/snipertown", "Free-For-All", 6, 20, 0, 38, 2],
  ["-=[PN]=- | Custom Objective | Bots + Squads #2", "m5l1a", "Ticket-Match", 0, 24, 23, 4, 1],
  ["=[v]= FFA | Bots | www.mohaa.online for custom maps download", "dm/cambodia_docks", "Free-For-All", 0, 16, 8, 301, 6],
  ["Omaha Beach 24/7 | Allies vs Axis", "obj/obj_team3", "Objective-Match", 12, 28, 0, 46, 0],
  ["[KILLERS] Spearhead Veterans DM", "dm/mohdm4", "Free-For-All", 2, 18, 0, 63, 0],
  ["Mod Party | Zombies & Freeze", "dm/zombie_bridge", "Zombies", 5, 24, 4, 88, "x"],
];

const EMPTY_NAMES = [
  "##{EGY}## AFTERMATH FFA 2025", "PART1CL3.NET MOHAA", "=MFC= FFA CUSTOM MAP SNIPER II map",
  "***** Death Run Server ***** | RIP EaTmEiNtHeBuTt", "=|LuV|= Custom Maps Server @ www.luvclan.eu #3",
  "=:AnUbIs:= CUSTOM MAPS @ anubis.clan", "_[B.A.D]_Mohaa_server", "[DOGS] {UK} Clan Freezetag TDM",
  "Brothers in Arms | Obj", "WWII Online Veterans", "Bazooka Madness", "Stalingrad Nights",
  "Rifle Range 1944", "Normandy Hedgerows", "=VIPER= Sniper Only", "[AAF] Allied Assault France",
  "Old School 1.11", "Breakthrough Italia", "Bridge At Remagen 24/7", "Hunt | Southern France",
];
const EMPTY_MAPS = [
  "dm/aftermath", "dm/canal", "dm/codharbor", "dm/dm_deathrun-wipeout", "dm/dm_routenord",
  "dm/mohdm1", "dm/mohdm3", "dm/mohdm7", "obj/obj_team1", "dm/stlo",
];
const EMPTY_MODES = ["Free-For-All", "Team-Match", "Objective-Match", "Round-Based-Match", "= Death Run: Wipeout"];

function compatibility(needs) {
  if (needs === -1) return { state: { state: "cant_tell" }, preflight: null, current_map: { readiness: "unknown" } };
  if (needs === "x") {
    return { state: { state: "no_source", count: 1 }, preflight: null, current_map: { readiness: "missing" } };
  }
  if (needs > 0) {
    return {
      state: { state: "needs_maps", count: needs, shopping_list: null },
      preflight: null,
      current_map: { readiness: "missing" },
    };
  }
  return { state: { state: "compatible" }, preflight: null, current_map: { readiness: "playable" } };
}

function server(index, [hostname, map, mode, players, capacity, bots, ping, needs]) {
  const octet = 20 + ((index * 37) % 200);
  const address = `${octet}.${(index * 53) % 250}.${(index * 17) % 250}.${10 + (index % 200)}`;
  const port = 12203 + (index % 5);
  return {
    address: `${address}:${port}`,
    server: {
      endpoint: { address, query_port: port + 97 },
      game_port: port,
      hostname,
      game_name: "mohaa",
      game_version: index % 4 === 0 ? "1.12+0.83.0" : "1.11",
      version: "Medal of Honor Allied Assault 1.11 win-x86 Mar 5 2002",
      protocol: "8",
      current_map: map,
      game_type: mode,
      rotation: needs === -1 ? [] : [map, "dm/mohdm1", "dm/mohdm2"],
      allow_download: null,
      map_checksum: null,
      pr_downloads: null,
      minimum_ping: null,
      maximum_ping: null,
      join_window: null,
      reserved_slots: index % 6 === 0 ? 4 : null,
      occupancy: { clients_reported: players, bots_reported: bots },
      client_capacity: capacity,
      pure: null,
      status_round_trip: ping,
    },
    compatibility: compatibility(needs),
  };
}

function rows() {
  const live = LIVE.map((entry, index) => server(index, entry));
  const empties = Array.from({ length: 99 }, (_, index) => {
    const name = EMPTY_NAMES[index % EMPTY_NAMES.length];
    const suffix = index >= EMPTY_NAMES.length ? ` #${Math.floor(index / EMPTY_NAMES.length) + 1}` : "";
    const bots = index % 3 === 0 ? 4 + (index % 9) : 0;
    const needs = index % 7 === 0 ? 2 + (index % 5) : index % 11 === 0 ? -1 : 0;
    return server(LIVE.length + index, [
      name + suffix,
      EMPTY_MAPS[index % EMPTY_MAPS.length],
      EMPTY_MODES[index % EMPTY_MODES.length],
      0,
      [16, 20, 24, 32, 40, 64][index % 6],
      bots,
      12 + ((index * 29) % 280),
      needs,
    ]);
  });
  return [...live, ...empties];
}

export function browsePayload() {
  const servers = rows();
  const clients = servers.reduce((sum, row) => sum + row.server.occupancy.clients_reported, 0);
  const bots = servers.reduce((sum, row) => sum + row.server.occupancy.bots_reported, 0);
  return {
    servers,
    summary: {
      registered: 212,
      inspected: 212,
      gamespy_reachable: 150,
      getstatus_reachable: servers.length,
      clients_reported: clients,
      bots_reported: bots,
      rotations_published: servers.length,
      map_checksums_published: 0,
      pakradar_published: 0,
      pure_published: 0,
      non_results: 99,
      protocols: { 8: servers.length },
    },
    non_results: [],
    cancelled: false,
  };
}

export const INSTALL = {
  root: "D:\\Jeux\\EA GAMES\\MOHDA",
  products: [GAME],
  playable: [GAME],
};
