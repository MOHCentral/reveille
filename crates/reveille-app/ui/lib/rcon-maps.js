// SPDX-License-Identifier: GPL-3.0-only

// The maps a player has typed into the console for one server, kept between runs.
//
// A stock 1.11 server will not list its maps over rcon, so the list the console offers is this
// computer's own maps plus whatever the player has already sent to this server. A name here is
// only ever a name the player chose: nothing a server printed is stored.

import { isSafeMapName } from "./rcon-session.js";

const KEY = "reveille.rcon.maps";
const VERSION = 1;
const PER_SERVER_LIMIT = 200;

function read() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return saved?.v === VERSION && saved.servers && typeof saved.servers === "object"
      ? saved.servers
      : {};
  } catch {
    return {};
  }
}

function write(servers) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: VERSION, servers }));
  } catch {
    // A launcher that cannot persist a convenience still works.
  }
}

/** The maps remembered for one server, as typed. */
export function rememberedMaps(address) {
  const names = read()[address];
  return Array.isArray(names) ? names.filter((name) => typeof name === "string" && isSafeMapName(name)) : [];
}

/** Remember a map for a server. A name that is not a plain map name is ignored. */
export function rememberMap(address, name) {
  if (!isSafeMapName(name)) return;
  const servers = read();
  const kept = rememberedMaps(address).filter((known) => known.toLowerCase() !== name.toLowerCase());
  servers[address] = [...kept, name].slice(-PER_SERVER_LIMIT);
  write(servers);
}

/** Drop a remembered map. */
export function forgetMap(address, name) {
  const servers = read();
  const kept = rememberedMaps(address).filter((known) => known.toLowerCase() !== name.toLowerCase());
  if (kept.length) servers[address] = kept;
  else delete servers[address];
  write(servers);
}

/** This computer's maps and the remembered ones, each name once, sorted without regard to case. */
export function mergeMaps(local, remembered) {
  const seen = new Map();
  for (const name of [...local, ...remembered]) {
    if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
