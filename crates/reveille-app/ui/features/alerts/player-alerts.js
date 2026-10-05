// SPDX-License-Identifier: GPL-3.0-only

import { GAMES as CATALOG_GAMES } from "../../lib/catalog.js";
import { registerSavedScope, state } from "../../lib/store.js";

const KEY = "reveille.player-alerts";
const GAMES = new Set(CATALOG_GAMES);

/** The player counts a watch can wait for. 1 is "anyone at all", which is what every watch meant before. */
export const THRESHOLDS = [1, 2, 4, 8, 12];

export const alertId = (entry) => `${entry.game}|${entry.address}`;

export function playerAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved
      .filter(
        (entry) =>
          entry &&
          GAMES.has(entry.game) &&
          typeof entry.address === "string" &&
          /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(entry.address) &&
          Number.isInteger(entry.queryPort) &&
          entry.queryPort > 0 &&
          entry.queryPort <= 65535,
      )
      .map((entry) => ({ ...entry, threshold: THRESHOLDS.includes(entry.threshold) ? entry.threshold : 1 }));
  } catch {
    return [];
  }
}

/** The servers watched in the game this session is browsing, shaped like saved entries. */
export function watchedEntries() {
  return playerAlerts()
    .filter((entry) => entry.game === state.game)
    .map((entry) => ({
      address: entry.address,
      queryPort: entry.queryPort,
      hostname: entry.hostname ?? "",
      threshold: entry.threshold,
    }));
}

registerSavedScope("watching", watchedEntries);

/** What the monitor last read for a watched address in this game, or null before its first probe. */
export function watchReading(address) {
  return state.watchReadings.get(alertId({ game: state.game, address })) ?? null;
}

export function hasPlayerAlert(game, address) {
  return playerAlerts().some((entry) => entry.game === game && entry.address === address);
}

/** The watch on one server in one game, or null. */
export function playerAlert(game, address) {
  return playerAlerts().find((entry) => entry.game === game && entry.address === address) ?? null;
}

export function addPlayerAlert(row, game, threshold = 1) {
  const entry = {
    game,
    address: row.address,
    queryPort: Number(row.server?.endpoint?.query_port),
    hostname: row.server?.hostname || row.address,
    threshold: THRESHOLDS.includes(threshold) ? threshold : 1,
  };
  if (
    !GAMES.has(game) ||
    !Number.isInteger(entry.queryPort) ||
    entry.queryPort < 1 ||
    entry.queryPort > 65535
  ) {
    return false;
  }
  return save([...playerAlerts().filter((saved) => alertId(saved) !== alertId(entry)), entry]);
}

export function setAlertThreshold(game, address, threshold) {
  if (!THRESHOLDS.includes(threshold)) return false;
  return save(
    playerAlerts().map((entry) =>
      entry.game === game && entry.address === address ? { ...entry, threshold } : entry,
    ),
  );
}

export function removePlayerAlert(game, address) {
  save(playerAlerts().filter((entry) => entry.game !== game || entry.address !== address));
}

function save(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Browsing and joining still work when preferences cannot be saved.
    return false;
  }
}
