// SPDX-License-Identifier: GPL-3.0-only

// What Maps & mods derives from state: which servers run a map, what the list shows, the selection
// and the download share.

import { mapKey } from "../../lib/format.js";
import { state } from "../../lib/store.js";

const players = (row) => row.server.occupancy?.clients_reported ?? 0;

/** The directory each mode's maps live under, as `MapMode::prefix` spells it. */
export const MODE_PREFIXES = { deathmatch: "dm/", objective: "obj/", liberation: "lib/" };

/**
 * The servers in the current list running `item`'s map right now, busiest first.
 *
 * Matched with the same normalisation join uses, against rows already on screen, so knowing where
 * a map is played costs no request of its own.
 */
export function runningOn(item, servers = state.servers) {
  const key = item?.map_key ? mapKey(item.map_key) : null;
  if (!key) return [];
  return servers
    .filter((row) => mapKey(row.server.current_map) === key)
    .sort((a, b) => players(b) - players(a));
}

/** How many of those servers there are and how many players they hold between them. */
export function liveSummary(rows) {
  return { servers: rows.length, players: rows.reduce((sum, row) => sum + players(row), 0) };
}

/**
 * The maps servers in the list run right now, once each, the most players first: Played now asks
 * moh-db about the first few dozen, so the busiest are the ones kept.
 */
export function playedMaps(servers = state.servers) {
  const byKey = new Map();
  for (const row of servers) {
    const key = mapKey(row.server.current_map);
    if (!key) continue;
    const known = byKey.get(key) ?? { name: row.server.current_map.trim(), players: 0 };
    known.players += players(row);
    byKey.set(key, known);
  }
  return [...byKey.entries()]
    .sort(([keyA, a], [keyB, b]) => b.players - a.players || keyA.localeCompare(keyB))
    .map(([, map]) => map.name);
}

const ORDERS = {
  played: (servers) => (a, b) => liveSummary(runningOn(b, servers)).players - liveSummary(runningOn(a, servers)).players,
  popular: () => (a, b) => b.downloads - a.downloads,
  newest: () => (a, b) => (b.added ?? 0) - (a.added ?? 0),
  name: () => (a, b) => a.title.localeCompare(b.title),
};

/**
 * The entries the list draws. moh-db searches, filters and orders a browse itself; Played now is a
 * few dozen maps fetched by name, so its search, mode and order are applied here.
 */
export function visibleItems(content = state.content, servers = state.servers) {
  if (!content.playedNow || content.tab !== "maps") return content.items;
  const needle = content.query.trim().toLowerCase();
  const prefix = content.mode ? MODE_PREFIXES[content.mode] : null;
  const order = (ORDERS[content.sort] ?? ORDERS.played)(servers);
  const byDownloads = ORDERS.popular();
  return content.items
    .filter((item) => !needle || item.title.toLowerCase().includes(needle) || (item.map_key ?? "").includes(needle))
    .filter((item) => !prefix || (item.map_key ?? "").startsWith(prefix))
    .sort((a, b) => order(a, b) || byDownloads(a, b));
}

export function selectedItem() {
  const { items, selected } = state.content;
  return items.find((item) => item.id === selected) ?? null;
}

export function selectedInstalled() {
  const { items, selected } = state.content.installed;
  return items.find((item) => item.id === selected) ?? null;
}

/** Bytes received over bytes expected across every install in flight, or null when none is. */
export function installShare(installs = state.content.installs) {
  if (!installs.size) return null;
  let received = 0;
  let total = 0;
  for (const install of installs.values()) {
    received += install.received;
    total += install.total;
  }
  return total > 0 ? received / total : 0;
}

/**
 * The question `items` answers: this session's folder, engine and game, the tab, search, order and
 * mode, and for Played now the maps being played instead, since it searches and orders locally.
 */
export function queryKey(session, content, servers = state.servers) {
  const where = [session.path, session.engine, session.game, content.tab];
  if (content.tab === "maps" && content.playedNow) return JSON.stringify([...where, "played", playedMaps(servers)]);
  const mode = content.tab === "maps" ? content.mode : null;
  return JSON.stringify([...where, content.query.trim(), content.sort, mode]);
}

/** The session the Installed list answers. */
export function installedKey(session) {
  return JSON.stringify([session.path, session.engine, session.game]);
}
