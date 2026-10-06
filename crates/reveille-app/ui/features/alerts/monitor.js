// SPDX-License-Identifier: GPL-3.0-only

// The watch monitor: probes every watched server in turn and decides which readings are arrivals.

import { alertId, playerAlerts } from "./player-alerts.js";

const INTERVAL_MS = 60_000;
const COOLDOWN_MS = 15 * 60_000;
const MISSES_BRIDGED = 2;

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
