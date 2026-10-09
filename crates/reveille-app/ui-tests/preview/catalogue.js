// SPDX-License-Identifier: GPL-3.0-only

// A deterministic moh-db page for the preview, shaped like `browse_catalogue`'s payload. Several
// maps are ones the preview's servers run, so "On servers now" has something to match.

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

const svg = ([top, bottom], index) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${bottom}"/>` +
      `<path d="M0 0H320V${70 + index * 14}L0 ${100 - index * 10}Z" fill="${top}"/>` +
      `<ellipse cx="${90 + index * 50}" cy="140" rx="60" ry="16" fill="rgba(0,0,0,0.18)"/></svg>`,
  )}`;

export const CATALOGUE = MAPS.map(([title, mapName, author, size, state, colours, images, modes, description], index) => ({
  id: 4300 + index,
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
  page_url: `https://www.moh-db.com/maps/${4300 + index}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  file: state === "unavailable" ? null : { filename: `${mapName.split("/").pop()}.pk3`, size },
  state,
  colours,
}));

export function cataloguePage() {
  return {
    entries: CATALOGUE.map(({ colours, ...item }) => structuredClone(item)),
    total: 1240,
    page: 0,
    has_more: true,
  };
}

export function catalogueScreenshot(id, index) {
  const item = CATALOGUE.find((entry) => entry.id === id);
  return item ? svg(item.colours, index) : null;
}
