// SPDX-License-Identifier: GPL-3.0-only

// What the server list derives from its state: the rows to draw, the counts beside them, and
// whether a row may be checked again. Reads only; the reducers beside it do the writing.

import { occupancy, occupancyFill } from "../../lib/format.js";
import { saved, state } from "../../lib/store.js";

const SORTERS = {
  name: (row) => row.server.hostname.toLowerCase(),
  clients: (row) => row.server.occupancy?.clients_reported ?? -1,
  map: (row) => (row.server.current_map ?? "").toLowerCase(),
  // A server that publishes no gametype sorts to the end of an ascending sort rather than to the
  // top with the empty string, where a run of blanks would hide the modes the player is scanning.
  mode: (row) => (row.server.game_type ?? "￿").toLowerCase(),
  // Every listed server answered, so a round trip always exists. The fallback sorts a server
  // that somehow lacks one to the far end rather than pretending it is instant.
  ping: (row) => row.server.status_round_trip ?? Number.MAX_SAFE_INTEGER,
  // The History scope's default. No column header owns this key, so no arrow is drawn — which is
  // right, because none of the columns is what the rows are ordered by.
  launched: (row, launches) => launches.get(row.address)?.lastLaunchedAt ?? "",
};

function serverFieldsMatch(row, query) {
  const fields = [
    row.server.hostname,
    row.address,
    row.server.current_map ?? "",
    row.server.game_type ?? "",
  ];
  return fields.some((field) => field.toLowerCase().includes(query));
}

function matchedPlayers(row, query) {
  const players = Array.isArray(row.server.players) ? row.server.players : [];
  return players.map((player) => player.name).filter((name) => name.toLowerCase().includes(query));
}

/**
 * The players on a live row whose names match the search, or an empty list.
 *
 * Named even when the server matched too: searching a clan tag lists the clan's own server by its
 * name, and this is the only place that says which members are on it.
 */
export function playersFound(row) {
  const query = state.filters.query.trim().toLowerCase();
  return query ? matchedPlayers(row, query) : [];
}

/**
 * Whether a live row survives the search box and the toolbar filters.
 *
 * The query matches player names too, so a player can find where a friend is playing.
 *
 * The query matches the **address** as well as the name. It matched only the name here while
 * `partitionScope` below matched both, so pasting an IP into All said "Nothing matches" with the
 * server on screen, and the same paste in Favorites found it.
 */
function matchesFilters(row) {
  const query = state.filters.query.trim().toLowerCase();
  if (query && !serverFieldsMatch(row, query) && matchedPlayers(row, query).length === 0) {
    return false;
  }
  const limit = state.filters.maxPing;
  // A server that published no round trip is not gated by a ceiling it cannot be measured
  // against: hiding it would be a claim about a figure that does not exist.
  const trip = row.server.status_round_trip;
  if (limit !== null && trip !== null && trip !== undefined && Number(trip) > limit) return false;
  const { modes } = state.filters;
  if (modes.length && !modes.includes(modeKey(row.server.game_type))) return false;
  if (state.filters.ready && !readyToJoin(row)) return false;
  return true;
}

/** Gametypes compared without case: servers spell the same mode differently. */
export function modeKey(gameType) {
  return (gameType ?? "").trim().toLowerCase();
}

/** Whether a live row can be joined at once: nothing to download and a slot free. */
export function readyToJoin(row) {
  if (row.compatibility?.state?.state !== "compatible") return false;
  return !occupancyFill(occupancy(row.server)).full;
}

/**
 * The modes the servers in this list publish, busiest first, for the Mode chip. A mode kept by the
 * filter stays listed after the servers running it are gone, so it can still be unticked.
 */
export function modeChoices() {
  const choices = new Map();
  for (const row of state.servers) {
    const key = modeKey(row.server.game_type);
    if (!key) continue;
    const choice = choices.get(key) ?? { key, label: row.server.game_type.trim(), count: 0 };
    choice.count += 1;
    choices.set(key, choice);
  }
  for (const key of state.filters.modes) {
    if (!choices.has(key)) choices.set(key, { key, label: key, count: 0 });
  }
  return [...choices.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Whether a toolbar filter other than the search box is set. */
export function chipFiltering() {
  const { maxPing, modes, ready } = state.filters;
  return maxPing !== null || modes.length > 0 || ready;
}

/** Whether any filter is narrowing the list right now. */
export function filtering() {
  return Boolean(state.filters.query.trim() || chipFiltering());
}

/** The rows the table should show, after search, filters and sort. */
export function visibleServers() {
  return sortRows(state.servers.filter(matchesFilters));
}

function sortRows(rows) {
  const key = SORTERS[state.sort.column] ?? SORTERS.clients;
  const launches =
    state.sort.column === "launched" ? new Map(saved("history").map((entry) => [entry.address, entry])) : null;
  const direction = state.sort.direction === "asc" ? 1 : -1;
  return rows.sort((left, right) => {
    const a = key(left, launches);
    const b = key(right, launches);
    if (a === b) {
      // Among equally busy servers the closer one is the better pick.
      if (state.sort.column === "clients") {
        const nearer = SORTERS.ping(left) - SORTERS.ping(right);
        if (nearer !== 0) return nearer;
      }
      return left.server.hostname.localeCompare(right.server.hostname);
    }
    return a > b ? direction : -direction;
  });
}

/** How old a list may get before the toolbar marks it and a return to the window refreshes it. */
export const STALE_AFTER_MS = 5 * 60_000;

/** Whether the list on screen finished longer ago than `STALE_AFTER_MS`. */
export function listIsStale(now = Date.now()) {
  const finished = Date.parse(state.browse.finishedAt ?? "");
  return Number.isFinite(finished) && now - finished > STALE_AFTER_MS;
}

/** "up" or "down" when a server's player count moved since the last measurement, else null. */
export function playerTrend(row) {
  const before = state.previousCounts.get(row.address);
  const now = row.server.occupancy?.clients_reported;
  if (!Number.isInteger(before) || !Number.isInteger(now) || before === now) return null;
  return { direction: now > before ? "up" : "down", before };
}

/** The entries a saved scope draws from: the starred, watched or launched ones. */
export function savedEntries() {
  if (state.scope === "favorites") return saved("favorites");
  if (state.scope === "watching") return saved("watching");
  return saved("history");
}

/**
 * Split a saved scope into what this check returned and what it did not, after the search box.
 *
 * One pass, read by everything that counts either half — the table, the status bar and the live
 * region — so the three cannot disagree about how many entries are in each.
 */
function partitionScope() {
  const remembered = savedEntries();
  const live = new Map(state.servers.map((row) => [row.address, row]));
  const query = state.filters.query.trim().toLowerCase();

  const rows = [];
  const absent = [];
  for (const entry of remembered) {
    const row = live.get(entry.address);
    if (row) {
      // The toolbar toggle is visible and pressed, so it applies here too. Quietly ignoring it
      // in this scope would make the control mean different things in different views.
      if (matchesFilters(row)) rows.push(row);
      continue;
    }
    // An absent entry has only a remembered name and an address to match on, and the toggle has
    // nothing to test: there are no figures.
    if (query && !entry.hostname.toLowerCase().includes(query) && !entry.address.includes(query)) {
      continue;
    }
    absent.push(entry);
  }
  return { rows, absent };
}

/** The remembered entries in this scope that the current check did not return. */
export function scopedAbsent() {
  if (state.scope === "all" || state.scope === "watching") return [];
  return partitionScope().absent;
}

/**
 * What the table lists for the current scope, tagged so the view does not have to work out
 * which kind of row it is holding.
 *
 * A remembered server the current sweep did not return is **not** dropped and **not** drawn with
 * the figures it had last time. It comes back as `absent`, carrying only its address and the name
 * it was starred under, and the view says so. Absent entries always follow the
 * live rows: there is nothing to sort them by.
 *
 * They are also **collapsed behind a disclosure that states how many there are**. Each of
 * the three games registers with the master separately, so a server starred while browsing another
 * one can never appear in this check and would otherwise sit in the list for ever, unanswerable —
 * often outnumbering the rows that did answer. The `disclosure` item is emitted whenever there is
 * anything behind it, open or shut, so the count is on screen either way: rows may be folded away,
 * never silently dropped.
 */
/** Whether a live row has anyone on it. Bots do not count: nobody plays with a bot by choice. */
export function hasPlayers(row) {
  return (row.server.occupancy?.clients_reported ?? 0) > 0;
}

/**
 * All, with the servers nobody is playing on folded under one counted row. A search unfolds
 * them, because a player looking for a server by name wants it whether or not it is busy.
 */
function allRows() {
  const rows = visibleServers();
  const live = (row) => ({ kind: "live", address: row.address, row });
  if (state.filters.query.trim()) return rows.map(live);
  const busy = rows.filter(hasPlayers);
  const empty = rows.filter((row) => !hasPlayers(row));
  if (!empty.length) return busy.map(live);
  const bots = empty.filter((row) => (row.server.occupancy?.bots_reported ?? 0) > 0).length;
  return [
    ...busy.map(live),
    { kind: "empty-fold", address: `empty:${empty.length}:${state.showEmpty}`, count: empty.length, bots },
    ...(state.showEmpty ? empty.map(live) : []),
  ];
}

/** How many servers the empty fold is hiding right now, for the status bar. */
export function foldedEmpty() {
  if (state.scope !== "all" || state.showEmpty || state.filters.query.trim()) return 0;
  return visibleServers().filter((row) => !hasPlayers(row)).length;
}

export function scopedRows() {
  if (state.scope === "all") return allRows();
  const { rows, absent } = partitionScope();
  const listed = sortRows(rows).map((row) => ({ kind: "live", address: row.address, row }));
  if (!absent.length) return listed;
  // Watched servers are few and are being probed anyway, so what the monitor saw is always shown.
  if (state.scope === "watching") {
    return [...listed, ...absent.map((entry) => ({ kind: "watched", address: entry.address, entry }))];
  }
  return [
    ...listed,
    // The count and the open state ride in `address` because that is what the view's row
    // signature hashes: without them, opening the block would not repaint the table.
    { kind: "disclosure", address: `${absent.length}:${state.showAbsent}`, count: absent.length },
    ...(state.showAbsent
      ? absent.map((entry) => ({ kind: "absent", address: entry.address, entry }))
      : []),
  ];
}

/**
 * Whether one server may be asked again right now.
 *
 * Not while a sweep is running — that is already re-asking every server in the list, this one
 * included. Not while a join is running — the pane belongs to that command, and a check that came
 * back empty would drop the row its progress is drawn against. And not while this address already
 * has a request in flight.
 *
 * One question, read by both the control and the handler behind it, so the two cannot drift into
 * disagreeing about when the control works.
 */
export function canRecheck(address) {
  if (state.browse.running || state.joining) return false;
  return state.checks.get(address)?.status !== "checking";
}

/**
 * What the list holds for an address before a check replaces it.
 *
 * The reading this check is about to replace, and the name to fall back on if it replaces it with
 * nothing. A server already dropped by an earlier check has no row left, so what that check
 * recorded is carried forward: losing it would leave the pane asking for this check unable to name
 * what it is about.
 */
export function droppedIdentity(entry) {
  const before = state.servers.find((row) => row.address === entry.address) ?? null;
  if (before) return { hostname: before.server.hostname, queryPort: entry.queryPort };
  return state.checks.get(entry.address)?.dropped ?? null;
}

export function selectedRow() {
  return state.servers.find((row) => row.address === state.selected) ?? null;
}
