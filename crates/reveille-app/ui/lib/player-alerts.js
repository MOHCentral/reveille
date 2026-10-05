// SPDX-License-Identifier: GPL-3.0-only

import { GAMES as CATALOG_GAMES } from "./catalog.js";
import { registerSavedScope, state } from "./store.js";

const KEY = "reveille.player-alerts";
const INTERVAL_MS = 60_000;
const COOLDOWN_MS = 15 * 60_000;
const MISSES_BRIDGED = 2;
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

/**
 * An alert is the count crossing up to the watch's threshold, so a server hovering above it does
 * not repeat. A server that briefly stops answering keeps its last count, because UDP loss is
 * routine and a lost reply between "empty" and "full" must not hide the arrival; a longer
 * silence forgets it, since the server may have restarted with anyone on it.
 *
 * `toast` says whether the arrival may interrupt the player: the cooldown holds back the pop-up,
 * never the record of the arrival.
 */
export function nextReading(previous, count, now, cooldownMs = COOLDOWN_MS, threshold = 1) {
  const lastAlertAt = previous?.lastAlertAt ?? null;
  if (!Number.isInteger(count) || count < 0) {
    const misses = (previous?.misses ?? 0) + 1;
    const known = misses <= MISSES_BRIDGED ? (previous?.known ?? null) : null;
    return { state: { count: null, checkedAt: now, lastAlertAt, known, misses }, alert: false, toast: false };
  }
  const known = previous?.known;
  const alert = Number.isInteger(known) && known < threshold && count >= threshold;
  const toast = alert && now - (lastAlertAt ?? -Infinity) >= cooldownMs;
  return {
    state: { count, checkedAt: now, lastAlertAt: toast ? now : lastAlertAt, known: count, misses: 0 },
    alert,
    toast,
  };
}

/**
 * `onReading(id, reading)` hears every probe, answered or not, so the Watching view can show what
 * the monitor last saw without probing again.
 */
export function startPlayerAlertMonitor(
  probe,
  deliver,
  onReading = () => {},
  cooldownMs = () => COOLDOWN_MS,
) {
  const readings = new Map();
  let stopped = false;
  let running = false;
  let timer;

  async function read(entry) {
    try {
      return await probe(entry);
    } catch {
      // A failed check is unknown, never an empty server.
      return null;
    }
  }

  async function poll() {
    if (running || stopped) return;
    running = true;
    clearTimeout(timer);
    for (const entry of playerAlerts()) {
      if (stopped) break;
      const id = alertId(entry);
      let reading = await read(entry);
      // One immediate retry absorbs a single lost datagram before the check counts as a miss.
      if (!Number.isInteger(reading?.clients)) reading = await read(entry);
      const count = reading?.clients ?? null;
      if (!playerAlerts().some((saved) => alertId(saved) === id)) {
        readings.delete(id);
        continue;
      }
      const result = nextReading(readings.get(id), count, Date.now(), cooldownMs(), entry.threshold);
      readings.set(id, result.state);
      onReading(id, result.state);
      if (result.alert) {
        try {
          await deliver(entry, count, reading, { toast: result.toast });
        } catch {
          // Delivery must not stop monitoring the remaining servers.
        }
      }
    }
    running = false;
    if (!stopped) timer = setTimeout(poll, INTERVAL_MS);
  }

  void poll();
  return {
    forget(game, address) {
      readings.delete(alertId({ game, address }));
    },
    checkNow() {
      void poll();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
