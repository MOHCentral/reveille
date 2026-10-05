// SPDX-License-Identifier: GPL-3.0-only

// The strings more than one feature derives from pipeline data. A feature's own wording lives in
// its `features/<name>/format.js`.
//
// The player count comes from `numplayers` (`SV_NumClients()`), which excludes bots.
// Bots are reported separately. A connection may still be downloading or idle,
// and capacity minus players does not reliably give the number of free slots.

import { preferences } from "./preferences.js";

/** Bytes as a short human size. Sub-MB values keep a decimal so 0.4 MB is not "0 MB". */
export function bytes(value) {
  if (value === null || value === undefined) return "—";
  const size = Number(value);
  if (!Number.isFinite(size)) return "—";
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1000) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1000) return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** "1 map" / "3 maps". */
export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Strip the Windows extended-length prefix so paths read the way people write them. */
export function displayPath(value) {
  return String(value ?? "").replace(/^\\\\\?\\/, "");
}

/** The occupancy figures, kept separate. Returns nulls rather than guessing zero. */
export function occupancy(server) {
  const clients = server.occupancy?.clients_reported ?? null;
  const bots = server.occupancy?.bots_reported ?? null;
  return {
    clients,
    bots: bots && bots > 0 ? bots : null,
    capacity: server.client_capacity ?? null,
  };
}

/**
 * The players a server listed, most kills first. Kills and deaths come only from the GameSpy reply,
 * so a server that sent none keeps its own order rather than one Reveille made up.
 */
export function playerRoster(server) {
  const listed = Array.isArray(server.players) ? server.players : [];
  if (!listed.some((player) => Number.isInteger(player.kills))) return listed;
  const kills = (player) => (Number.isInteger(player.kills) ? player.kills : Number.MIN_SAFE_INTEGER);
  const deaths = (player) => (Number.isInteger(player.deaths) ? player.deaths : Number.MAX_SAFE_INTEGER);
  return [...listed].sort((a, b) => kills(b) - kills(a) || deaths(a) - deaths(b));
}

/** Said only when the names fall short of the count, which the server's reply buffer can cause. */
export function rosterShortfall(server, listed) {
  const clients = server.occupancy?.clients_reported ?? null;
  if (clients === null || listed >= clients) return null;
  return `The server listed ${listed} of its ${plural(clients, "player")}.`;
}

/** The line under a server's name saying who the search found there. The name leads so it survives truncation. */
export function playersFoundText(names) {
  if (names.length === 0) return null;
  if (names.length === 1) return `Playing: ${names[0]}`;
  return `Playing: ${names[0]} and ${names.length - 1} more`;
}

/** Share of capacity above which a server reads as nearly full. */
export const NEARLY_FULL = 0.85;

/**
 * How full a server is, for the occupancy bar and the row's activity styling.
 *
 * Players and bots are separate segments of one track, players first, clipped so the two never
 * overrun capacity. `activity` is what the row looks like at a glance: people on it, only bots,
 * or nobody.
 */
export function occupancyFill({ clients, bots, capacity }) {
  const players = clients ?? 0;
  const botCount = bots ?? 0;
  const activity = players > 0 ? "players" : botCount > 0 ? "bots" : "empty";
  if (!capacity || capacity < 1) {
    return { players: 0, bots: 0, full: false, nearlyFull: false, activity };
  }
  const playerShare = Math.min(1, players / capacity);
  const botShare = Math.min(1 - playerShare, botCount / capacity);
  return {
    players: playerShare,
    bots: botShare,
    full: players >= capacity,
    nearlyFull: players < capacity && playerShare >= NEARLY_FULL,
    activity,
  };
}

/** The occupancy cell's tooltip and accessible name, in words. */
export function occupancyText({ clients, bots, capacity }) {
  if (clients === null) return "Player count not published";
  const players = `${plural(clients, "player")}${capacity ? ` of ${capacity}` : ""}`;
  const full = capacity && clients >= capacity ? ", full" : "";
  return bots ? `${players}${full}, plus ${plural(bots, "bot")}` : `${players}${full}`;
}

/**
 * The Ping column: the round trip of this sweep's one status request.
 *
 * Deliberately not called the in-game ping. It is a single UDP sample taken
 * while fifteen other probes were in flight, so it says "this server is roughly
 * this far away", not "you will play at this latency". The tooltip carries that
 * distinction; the column header cannot.
 *
 * The server's own `sv_minPing`/`sv_maxPing` gate is a different number and is
 * never rendered here.
 */
/** The dot beside a ping: green below one bound, amber up to the other, both set in Settings. */
export function roundTrip(server) {
  const value = server.status_round_trip;
  if (value === null || value === undefined) return { text: "—", title: null };
  const millis = Number(value);
  if (!Number.isFinite(millis)) return { text: "—", title: null };
  const { pingGood, pingFair } = preferences();
  return {
    text: `${millis} ms`,
    band: millis < pingGood ? "good" : millis <= pingFair ? "fair" : "poor",
    title:
      "Time for one status request to this server and back, measured once during this check. Not the in-game ping.",
  };
}

/**
 * The Mode column: the gametype the server publishes, as it spelled it.
 *
 * `g_gametypestring` is an ordinary server cvar. The stock engine sets it to one of seven
 * labels, but a mod may put anything there, so the value is shown verbatim rather than mapped
 * onto a fixed set or shortened to FFA/OBJ/TDM: an abbreviation Reveille invented would be a
 * claim about a server it cannot check, and an unrecognised mode would have nowhere to go.
 * A server that publishes none says so with the same em dash every other unpublished figure uses.
 */
export function gameType(server) {
  const name = String(server.game_type ?? "").trim();
  if (name === "") {
    return { text: "—", title: "This server did not publish a gametype." };
  }
  return { text: name, title: name };
}

/**
 * The full build string, for the detail pane where it has room to wrap.
 * Servers report things like "Medal of Honor Allied Assault 1.11 win-x86 Mar 5 2002".
 */
export function engineLabel(server) {
  return server.version || server.game_version || fallbackVersion(server);
}

/**
 * The tabular version, for the list. `gamever` is already short and comparable —
 * "1.11", "1.12+0.83.0" — whereas `version` is a sentence and truncates to
 * "Medal of Honor Allied" in every row, which distinguishes nothing.
 */
export function shortVersion(server) {
  return server.game_version || fallbackVersion(server);
}

function fallbackVersion(server) {
  return server.protocol ? `protocol ${server.protocol}` : "—";
}

/**
 * The engine's map-name normalisation, reproduced exactly.
 *
 * `MapKey::new` in crates/reveille-core/src/mapindex.rs:
 * trim, backslashes to slashes, ASCII lowercase, strip a leading `maps/` and a
 * trailing `.bsp`, and **nothing else**. Both prefixed and bare names are
 * legitimate, so no prefix may be inserted.
 *
 * Used to line a server's `mapname` up with its rotation entry, which the server
 * may have spelled differently.
 */
export function mapKey(value) {
  const normalised = String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .toLowerCase();
  const withoutPrefix = normalised.startsWith("maps/") ? normalised.slice(5) : normalised;
  const key = withoutPrefix.endsWith(".bsp") ? withoutPrefix.slice(0, -4) : withoutPrefix;
  return key === "" ? null : key;
}

/** A rotation map name as the server spelled it, with an empty name made visible. */
export function mapName(value) {
  const name = String(value ?? "").trim();
  return name === "" ? "(unnamed)" : name;
}

/**
 * The wall clock, to the minute — how every "when was this measured" is written.
 *
 * Absolute, not relative. These labels are drawn once and are not redrawn on a timer, so a
 * "just now" left on screen goes quietly wrong as the minutes pass, which is the one thing a
 * freshness label may not do. A clock time stays true however long it sits there.
 */
export function clockTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * How long ago something happened, for the history line.
 *
 * Recent values are relative because that is how a player thinks about "did I play there
 * today"; anything older than a week becomes a date, because "43 days ago" is arithmetic the
 * reader has to undo. Returns null for a missing or unreadable timestamp rather than inventing
 * one.
 */
export function timeAgo(iso) {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const seconds = Math.max(0, (Date.now() - then.getTime()) / 1000);
  if (seconds < 90) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 7) return `${Math.round(days)}d ago`;
  return then.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The detail pane's history line: when this server was last played from Reveille, and how often. */
export function launchedLabel(entry) {
  if (!entry?.launches) return null;
  const when = timeAgo(entry.lastLaunchedAt);
  const times = entry.launches > 1 ? ` · ${entry.launches}×` : "";
  return when ? `Played ${when}${times}` : `Played ${entry.launches}×`;
}

/** The History view's Played column: how long ago, and how often once it is more than once. */
export function playedLabel(entry) {
  if (!entry?.launches) return null;
  const when = timeAgo(entry.lastLaunchedAt);
  const times = entry.launches > 1 ? ` ×${entry.launches}` : "";
  return when ? `${when}${times}` : `×${entry.launches}`;
}

/**
 * What the live region says while a sweep runs.
 *
 * The sweep emits one event per probed endpoint, so a region restating "N of M done" fired
 * roughly two hundred announcements per sweep — not progress reporting but a denial of service
 * against the one output a blind player has. Progress is announced at
 * quarters instead: start, three milestones, then the summary. Five utterances rather than two
 * hundred.
 *
 * Deliberately carries no live counts. A running total inside the sentence would make the string
 * differ on every probe and defeat the whole point of the milestone.
 */
const SWEEP_MILESTONES = [
  "A quarter of the servers checked.",
  "Half of the servers checked.",
  "Three quarters of the servers checked.",
];

export function sweepProgressText({ probed, inspected }) {
  if (inspected <= 0) return "Getting the server list. Contacting the master server.";
  const quarter = Math.min(3, Math.floor((probed / inspected) * 4));
  return quarter === 0 ? `Checking ${inspected} servers.` : SWEEP_MILESTONES[quarter - 1];
}
