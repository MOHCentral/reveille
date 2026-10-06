// SPDX-License-Identifier: GPL-3.0-only

// The keys the server list owns, and the toolbar choices that persist across runs.
//
// Other features read some of them (join reads `selected`, `servers` and `checks` for the pane;
// bug reports read `browse`), but only the server list's controllers and reducers write them.

import { state } from "../../lib/store.js";

const FILTERS_KEY = "reveille.filters";

export function initial() {
  return {
    /** Rows as they arrive during a sweep, then the authoritative post-dedup list. */
    servers: [],
    summary: null,
    nonResults: [],
    /** Sweep progress. `running` drives the toolbar; `probed`/`inspected` the meter. */
    browse: {
      running: false,
      /** Stop was pressed; probes already in flight are still draining. */
      stopping: false,
      /** Running behind the list on screen, which stays until the sweep finishes. */
      background: false,
      registered: 0,
      inspected: 0,
      probed: 0,
      answered: 0,
      nonResults: 0,
      cancelled: false,
      error: null,
      completedAt: null,
      // The same moment as a timestamp, for the toolbar's "2 min ago".
      finishedAt: null,
    },

    /**
     * Each server's player count in the list the current sweep replaced, keyed by address, so a row
     * can say whether it is filling up or emptying. Empty after a change of game, engine or folder.
     */
    previousCounts: new Map(),
    /** The selected row's address. */
    selected: null,
    /**
     * View state.
     *
     * `maxPing` gates on the one round trip this sweep measured, not on the in-game ping — see
     * `roundTrip` in lib/format.js. Null means no gate. `modes` holds the gametypes to keep, in the
     * spelling servers publish; empty keeps every mode. `ready` keeps only the servers that can be
     * joined now: no maps to download and a free slot.
     */
    filters: { query: "", maxPing: null, modes: [], ready: false },
    sort: { column: "clients", direction: "desc" },
    /**
     * Whether All shows its servers with no players, which otherwise sit folded under one counted
     * row. Most of the list is empty on a normal evening; folding them puts every populated server
     * on the first screen.
     */
    showEmpty: false,
    /** Whether the detail pane is hidden, giving the list the whole window. */
    detailCollapsed: false,
    /** Which population the table lists: every answering server, or the starred, watched or played ones. */
    scope: "all",
    /**
     * Whether a saved scope's absent block is open.
     *
     * Shut by default. What it hides is stated on the disclosure that hides it, so a player can see
     * that entries are folded away and how many — this is not a filter with an invisible
     * effect, which is what got the old "Hide unavailable maps" toggle removed.
     */
    showAbsent: false,
    /**
     * What a single-server check found, keyed by address. A remembered server absent from the
     * sweep has no entry until it is checked; then it is `checking`, and afterwards either it is
     * in `servers` or the recorded reason it did not answer sits here.
     */
    checks: new Map(),
    /**
     * When a single-server check last measured each address, as a clock time.
     *
     * Only the servers a check re-asked on their own are in here, one entry per re-check rather
     * than one per row. A row still carrying the sweep's own figures has no entry, and the pane
     * words it as the check it came from rather than as a measurement of that one server: probes
     * stream in across a whole sweep, so its finish time is not when any particular row answered.
     */
    checkedAt: new Map(),
    /** Sweep completion the favorites auto-check has already run for, so it runs once. */
    autoCheckedAt: null,

    /**
     * When the rows on screen were measured, once a sweep has failed on top of them.
     *
     * A sweep that cannot reach the master used to blank the table and leave the centre of the
     * window reading "Nothing has been checked yet" underneath an error in the corner — the two
     * contradicting each other, with no next action in either. The rows
     * from the last sweep that did work are kept instead, and this is the clock time that says what
     * they are: a past reading, not a current one.
     *
     * Null whenever the list on screen is this session's own answer.
     */
    staleAt: null,
  };
}

export function saveFilters() {
  try {
    localStorage.setItem(
      FILTERS_KEY,
      JSON.stringify({
        maxPing: state.filters.maxPing,
        modes: state.filters.modes,
        ready: state.filters.ready,
        sort: state.sort,
        scope: state.scope,
        showAbsent: state.showAbsent,
        showEmpty: state.showEmpty,
        detailCollapsed: state.detailCollapsed,
        query: "",
      }),
    );
  } catch {
    // Not worth surfacing.
  }
}

export function loadFilters() {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
    if (!saved) return;
    state.filters = {
      query: "",
      maxPing: PING_LIMITS.includes(saved.maxPing) ? saved.maxPing : null,
      modes: Array.isArray(saved.modes) ? saved.modes.filter((mode) => typeof mode === "string") : [],
      ready: saved.ready === true,
    };
    if (saved.sort?.column) state.sort = saved.sort;
    // `favourites` is the pre-rename scope value, mapped so a player who left the app on that
    // tab comes back to it rather than to All.
    const scope = saved.scope === "favourites" ? "favorites" : saved.scope;
    if (SCOPES.includes(scope)) state.scope = scope;
    state.showAbsent = !!saved.showAbsent;
    state.showEmpty = !!saved.showEmpty;
    state.detailCollapsed = !!saved.detailCollapsed;
  } catch {
    // Ignore a corrupt preference rather than refusing to start.
  }
}

export const SCOPES = ["all", "favorites", "watching", "history"];

/**
 * The round-trip ceilings the toolbar offers. Null is the default: no gate.
 *
 * A sort is not a filter. Sorting by players surfaces full servers on the other side of the
 * world; sorting by ping surfaces empty ones next door. Shipping the sort without the filter is a
 * documented failure across several modern browsers, and Doomseeker has had this since the 2000s.
 */
export const PING_LIMITS = [null, 80, 150, 250];
