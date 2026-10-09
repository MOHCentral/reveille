// SPDX-License-Identifier: GPL-3.0-only

// Deterministic moh-db pages for the preview, shaped like `browse_catalogue`'s payload, and what
// Reveille installed. Several maps are ones the preview's servers run, so "On servers now" and
// Played now have something to match.

const MAPS = [
  ["Snipertown", "dm/snipertown", "Dr. Fragg", 14_889_000, "available", ["#a59a7c", "#6a5d44"], 3, "Deathmatch", "A sniper town in the hills: rooftops, a bell tower and one long main street.\nBuilt for 8 to 20 players."],
  ["Rock Bound", "dm/dm_rockbound", "Bonzo", 33_345_000, "available", ["#7c8c99", "#3f4a3a"], 2, "Deathmatch, Freeze-Tag", null],
  ["V2 Rocket Facility", "m5l1a", "2015 Studios", 23_592_000, "available", ["#5b5f63", "#2e3236"], 1, "Objective", "The single-player V2 level, reworked for online objective play."],
  ["Zombie Bridge", "dm/zombie_bridge", "Mod Party", 10_066_000, "available", ["#4d5a3d", "#262b1f"], 2, "Zombies", null],
  ["Cambodia Docks", "dm/cambodia_docks", "=[v]=Ranger", 6_291_000, "available", ["#6f8f8a", "#2f3c38"], 1, "Deathmatch", null],
  ["Stalingrad Winter", "obj/obj_stalingrad_w", "Kriegsmarine", 19_293_000, "available", ["#dfe3e6", "#8b8f8f"], 4, "Objective", null],
  ["Bridge Assault", "dm/bridge_assault", "Sniper Joe", 10_171_000, "installed", ["#9aa8b0", "#55603f"], 2, "Team-Match", null],
  ["Destroyed Village Night", "obj/obj_village_n", "Nightshade", 12_582_000, "present", ["#1f2a3a", "#141a22"], 1, "Objective", null],
  ["Remagen Crossing", "obj/obj_remagen", "Ardennes Mapping", 27_263_000, "available", ["#8a7a5a", "#45402e"], 0, "Objective", null],
  ["Desert Fox", "dm/desertfox", "Rommel", 8_388_000, "available", ["#d0b27a", "#8a6d3c"], 2, "Deathmatch", null],
  ["Hedgerow Hell", "dm/hedgerow", "Normandy 44", 15_728_000, "unavailable", ["#5a7046", "#2f3b24"], 1, "Team-Match", null],
  ["Monte Cassino", "obj/obj_cassino", "Polski Team", 31_457_000, "available", ["#b8b0a0", "#6a6050"], 3, "Objective", null],
];


export const CATALOGUE = MAPS.map(([title, mapName, author, size, state, colours, images, modes, description], index) => ({
  id: 4300 + index,
  kind: "map",
  title,
  map_name: mapName,
  map_key: mapName,
  author,
  description,
  theme: index % 3 === 0 ? "Normandy" : null,
  modes,
  size_class: null,
  added: 1_700_000_000 - index * 4_000_000,
  rating: null,
  downloads: 1840 - index * 120,
  image_count: images,
  page_url: `https://www.moh-db.com/maps/${9100 + index}-${slug(title)}`,
  mod_type: null,
  version: null,
  requires: null,
  install_notes: null,
  archive_name: null,
  file: state === "unavailable" ? null : { filename: `${mapName.split("/").pop()}.pk3`, size },
  state,
  colours,
}));

// [title, author, type, version, file, size, state, colours, images, notes, requires, description]
// A `null` file is a mod that ships as an archive Reveille will not unpack, so it shows its notes.
const MOD_ROWS = [
  ["Allies American Flag Waving Avatar", "Dizzle813", "Avatar", "v1.0", "zzzzzz-AlliesFlagWaving_v1.pk3", 2_789, "available", ["#3b4f7a", "#9b2f2f"], 1, null, null, "Replaces the stock Allies avatar with a waving American flag."],
  ["Freeze Tag", "Elgan", "Gametype", "v2.5", "zzz_freezetag.pk3", 3_250_000, "installed", ["#9fc6d8", "#3d5866"], 2, null, "A server running Freeze Tag.", "Frozen players thaw when a teammate stands next to them."],
  ["Realism Pack", "Brutal Mods", "Weapon", "v3", null, 42_991_000, "unavailable", ["#6a5534", "#2f2618"], 2, "Unzip into your MOHAA folder, then copy the realism folder's .pk3 files into main.\nKeep a backup of your config first.", "Allied Assault 1.11", "Heavier recoil, longer reloads and no crosshair."],
  ["MOHAA for Windows 8 Patch", "Doughboy", "Patches and Cracks", "v1.00a", null, 51_200, "unavailable", ["#2c3a4a", "#121820"], 0, "Copy opengl32.dll next to MOHAA.exe, not into main.", null, "Runs the original game on Windows 8 and later."],
  ["Winter Skins Pack", "Kriegsmarine", "Player Skins", "v1.2", "zzz_winter_skins.pk3", 8_400_000, "available", ["#e6e9ec", "#7d858c"], 3, null, null, "Snow camouflage for both teams."],
  ["HUD Compass", "Nightshade", "HUDs", null, "zzz_hud_compass.pk3", 120_000, "present", ["#40463c", "#1c1f1a"], 1, null, null, "A compass at the top of the screen."],
];

export const MODS = MOD_ROWS.map(([title, author, type, version, file, size, state, colours, images, notes, requires, description], index) => ({
  id: 39700 + index,
  kind: "mod",
  title,
  map_name: null,
  map_key: null,
  author,
  description,
  theme: null,
  modes: null,
  size_class: null,
  added: 1_780_000_000 - index * 9_000_000,
  rating: null,
  downloads: 900 - index * 110,
  image_count: images,
  page_url: `https://www.moh-db.com/mods/${43000 + index}-${slug(title)}`,
  mod_type: type,
  version,
  requires,
  install_notes: notes,
  archive_name: file ? null : `${slug(title)}.zip`,
  file: file ? { filename: file, size } : null,
  state,
  colours,
}));

function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const svg = ([top, bottom], index) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${bottom}"/>` +
      `<path d="M0 0H320V${70 + index * 14}L0 ${100 - index * 10}Z" fill="${top}"/>` +
      `<ellipse cx="${90 + index * 50}" cy="140" rx="60" ry="16" fill="rgba(0,0,0,0.18)"/></svg>`,
  )}`;

const plain = ({ colours, ...item }) => structuredClone(item);

export function cataloguePage(kind = "map") {
  const entries = kind === "mod" ? MODS : CATALOGUE;
  return {
    entries: entries.map(plain),
    total: kind === "mod" ? 1569 : 2529,
    page: 0,
    has_more: true,
  };
}

/** What `catalogue_played_now` gives: an entry per custom map with a directory, as Rust skips the rest. */
export function playedNow(maps) {
  const wanted = new Set(maps.filter((name) => name.includes("/")).map((name) => name.toLowerCase()));
  return CATALOGUE.filter((item) => wanted.has(item.map_key)).map(plain);
}

export function installedPayload() {
  const items = [
    { id: 4306, kind: "map", title: "Bridge Assault", filename: "bridge_assault.pk3", size: 10_171_000, installed_at: 1_791_400_000, changed: false },
    // Server files a join fetched carry no moh-db id or page.
    { id: 0, kind: "map", title: "Custom pack", filename: "zz_custompack.pk3", size: 6_420_000, installed_at: 1_791_350_000, changed: false },
    { id: 39701, kind: "mod", title: "Freeze Tag", filename: "zzz_freezetag.pk3", size: 3_250_000, installed_at: 1_791_300_000, changed: false },
    { id: 4290, kind: "map", title: "Remagen Bridge Beta", filename: "remagen_beta.pk3", size: 18_874_000, installed_at: 1_789_000_000, changed: true },
  ].map((item) => ({
    ...item,
    page_url: item.id === 0 ? null : item.kind === "mod" ? `https://www.moh-db.com/mods/${item.id}` : `https://www.moh-db.com/maps/${item.id}`,
  }));
  return { items, total_size: items.reduce((sum, item) => sum + item.size, 0) };
}

export function catalogueScreenshot(id, index) {
  const item = [...CATALOGUE, ...MODS].find((entry) => entry.id === id);
  return item ? svg(item.colours, index) : null;
}
