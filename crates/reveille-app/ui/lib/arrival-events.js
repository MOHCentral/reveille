// SPDX-License-Identifier: GPL-3.0-only

const KEY = "reveille.arrival-events";
const LIMIT = 50;
const GAMES = new Set(["allied_assault", "spearhead", "breakthrough"]);
const recent = new Map();

export function arrivalEvents() {
  try {
    const entries = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) =>
      entry && typeof entry.id === "string" && GAMES.has(entry.game) &&
      typeof entry.address === "string" && typeof entry.hostname === "string" &&
      Number.isInteger(entry.queryPort) && entry.queryPort > 0 && entry.queryPort <= 65535 &&
      Number.isInteger(entry.count) && entry.count > 0 &&
      Number.isFinite(entry.at) && typeof entry.read === "boolean"
    ).slice(0, LIMIT);
  } catch {
    return [];
  }
}

export function unreadArrivalCount() {
  return arrivalEvents().filter((entry) => !entry.read).length;
}

/** `game|address` -> when players last arrived there, read once for a whole list. */
export function lastArrivals() {
  const latest = new Map();
  for (const entry of arrivalEvents()) {
    const id = `${entry.game}|${entry.address}`;
    if ((latest.get(id) ?? -Infinity) < entry.at) latest.set(id, entry.at);
  }
  return latest;
}

export function arrivalById(id) {
  return recent.get(id) ?? arrivalEvents().find((entry) => entry.id === id) ?? null;
}

export function recordArrival(server, count, at = Date.now(), detail = null) {
  const event = {
    id: crypto.randomUUID(),
    game: server.game,
    address: server.address,
    queryPort: server.queryPort,
    hostname: server.hostname,
    count,
    // The round they arrived for: map, mode and ping, already worded.
    detail: typeof detail === "string" && detail ? detail : null,
    at,
    read: false,
  };
  if (!GAMES.has(event.game) || !Number.isInteger(count) || count < 1) return null;
  recent.set(event.id, event);
  if (recent.size > LIMIT) recent.delete(recent.keys().next().value);
  try {
    localStorage.setItem(KEY, JSON.stringify([event, ...arrivalEvents()].slice(0, LIMIT)));
  } catch {
    // A notification remains actionable during this run even if storage is unavailable.
  }
  return event;
}

export function markArrivalsRead() {
  try {
    localStorage.setItem(KEY, JSON.stringify(arrivalEvents().map((entry) => ({ ...entry, read: true }))));
  } catch {
    // The feed remains readable when preferences cannot be saved.
  }
}
