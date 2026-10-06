// SPDX-License-Identifier: GPL-3.0-only

// What the player reads about watched servers and the alerts they raised.

import { gameType, mapName, plural, timeAgo } from "../../lib/format.js";

/** A toast's second line: the round players arrived for, from what the monitor read. */
export function alertDetail(reading) {
  if (!reading) return null;
  const parts = [
    reading.map ? mapName(reading.map) : null,
    reading.mode ? gameType({ game_type: reading.mode }).text : null,
    Number.isInteger(reading.round_trip) ? `${reading.round_trip} ms` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * What the watch monitor last saw on one server, for the Watching view. `lastAlertAt` comes from
 * the stored arrivals rather than the monitor, so it survives a restart.
 */
export function watchLine(reading, lastAlertAt, threshold = 1) {
  const parts = [];
  if (!reading) parts.push("Not checked yet");
  else {
    const checked = timeAgo(reading.checkedAt);
    const seen =
      reading.count === null || reading.count === undefined
        ? "No answer"
        : reading.count === 0
          ? "No players"
          : plural(reading.count, "player");
    parts.push(checked ? `${seen} ${checked}` : seen);
  }
  const alerted = timeAgo(lastAlertAt);
  if (alerted) parts.push(`alerted ${alerted}`);
  if (threshold > 1) parts.push(`notify at ${threshold}+`);
  return parts.join(" · ");
}
