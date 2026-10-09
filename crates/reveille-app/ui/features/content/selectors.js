// SPDX-License-Identifier: GPL-3.0-only

// What Maps & mods derives from state: which servers run a map, the selection, the download share.

import { mapKey } from "../../lib/format.js";
import { state } from "../../lib/store.js";

const players = (row) => row.server.occupancy?.clients_reported ?? 0;

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

export function selectedItem() {
  const { items, selected } = state.content;
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

/** The question `items` answers: this session's folder, engine and game, the search and the order. */
export function queryKey(session, query, sort) {
  return JSON.stringify([session.path, session.engine, session.game, query.trim(), sort]);
}
