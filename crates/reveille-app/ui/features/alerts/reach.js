// SPDX-License-Identifier: GPL-3.0-only

// What keeps an alert able to reach the player: watching on after the window closes, the tray's
// summary, and the one notice that sums up what a game in progress held back.

import { plural } from "../../lib/format.js";

/**
 * Whether watching a server should also turn on close-to-tray. Only when the player has never
 * chosen either way: closing the window otherwise ends every watch without a word.
 */
export function needsBackgroundWatching(prefs, watchCount) {
  return watchCount > 0 && !prefs.closeToTray && !prefs.trayChosen;
}

export function trayTooltip(watchCount, unread) {
  if (watchCount === 0) return "Reveille";
  const watching = `Reveille is watching ${plural(watchCount, "server")}`;
  return unread > 0 ? `${watching} · ${plural(unread, "unread alert")}` : watching;
}

export function hiddenNotice(watchCount) {
  return {
    title: watchCount > 0 ? "Reveille is still watching" : "Reveille is still running",
    body:
      (watchCount > 0 ? `It will tell you when players join your ${plural(watchCount, "server")}. ` : "") +
      "Right-click its icon in the notification area to quit.",
  };
}

/** One notice for everything a running game held back, newest arrival per server. */
export function catchUpNotice(events) {
  const latest = new Map();
  for (const event of events) {
    const id = `${event.game}|${event.address}`;
    if ((latest.get(id)?.at ?? -Infinity) < event.at) latest.set(id, event);
  }
  const servers = [...latest.values()].sort((a, b) => b.at - a.at);
  if (servers.length === 0) return null;
  if (servers.length === 1) {
    const [only] = servers;
    return {
      title: "While you were playing",
      body: `${plural(only.count, "player")} joined ${only.hostname}.`,
    };
  }
  const named = servers.slice(0, 2).map((event) => event.hostname);
  const rest = servers.length - named.length;
  return {
    title: "While you were playing",
    body: `Players joined ${plural(servers.length, "server")}: ${named.join(", ")}${rest ? ` and ${rest} more` : ""}.`,
  };
}

const STALE_MS = 10 * 60_000;

/** An alert old enough that the server has probably changed since. */
export function isStale(event, now = Date.now()) {
  return now - event.at > STALE_MS;
}
