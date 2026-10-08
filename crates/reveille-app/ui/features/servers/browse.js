// SPDX-License-Identifier: GPL-3.0-only

// Sweeping the master list for this session's game, in front of the list on screen or behind it.

import { clockTime } from "../../lib/format.js";
import { generations, listIsForCurrentSession, session } from "../../lib/session.js";
import { state, subscribe, update } from "../../lib/store.js";
import { browseFailure, browseServers, cancelBrowse } from "./api.js";
import { adoptBackgroundSweep, countsByAddress } from "./reducers.js";

/**
 * The sweep's controls.
 *
 * `onReselect(address)` runs when a sweep behind the list changed the selected server's map or
 * readiness, so the pane works out its sources again.
 */
export function browse({ onReselect }) {
  function progressed(progress) {
    update((next) => {
      next.browse.registered = progress.registered;
      next.browse.inspected = progress.inspected;
      next.browse.probed = progress.probed;
      next.browse.answered = progress.answered;
      next.browse.nonResults = progress.non_results;
      // Streamed rows are pre-deduplication; the payload that arrives when the
      // sweep ends replaces this list with the authoritative one.
      if (progress.row && !next.browse.background) next.servers = [...next.servers, progress.row];
    });
  }

  async function refreshBehind() {
    generations.check.next();
    const swept = session();
    update((next) => {
      next.browse = {
        ...next.browse,
        running: true,
        stopping: false,
        background: true,
        registered: 0,
        inspected: 0,
        probed: 0,
        answered: 0,
        nonResults: 0,
        cancelled: false,
        error: null,
      };
    });

    try {
      const payload = await browseServers(swept, progressed);
      let reselect = false;
      update((next) => {
        reselect = adoptBackgroundSweep(next, payload, clockTime(), new Date().toISOString());
        next.browse.background = false;
      });
      if (reselect && state.selected) onReselect(state.selected);
    } catch (error) {
      update((next) => {
        next.browse.running = false;
        next.browse.background = false;
        next.browse.error = browseFailure(error);
        next.staleAt = next.browse.completedAt;
      });
    }
  }

  async function refresh() {
    if (state.browse.running) return;
    // Any check still in flight is about the list this sweep is replacing.
    generations.check.next();
    const swept = session();
    // What is on screen now, kept only so a sweep that fails outright has something honest to fall
    // back to. Blanking the table on a failed sweep left the centre of the window reading "Nothing
    // has been checked yet" under an error about the check that had just run. Only a list swept for
    // *this* session qualifies: rows from another game or another folder are not a stale answer to
    // this question, they are an answer to a different one.
    const previous = listIsForCurrentSession() ? state.servers : [];
    // A server that was in the last list but not in this one keeps no count to compare against.
    const previousCounts = countsByAddress(previous);
    const previousAt = state.browse.completedAt;
    const previousFinishedAt = state.browse.finishedAt;
    update((next) => {
      // Recorded before the first row arrives, because the streamed rows belong to this session
      // too, and a sweep that ends in an error still has to leave behind what it was asking.
      next.listSession = swept;
      next.browse = {
        running: true,
        stopping: false,
        background: false,
        registered: 0,
        inspected: 0,
        probed: 0,
        answered: 0,
        nonResults: 0,
        cancelled: false,
        error: null,
        completedAt: null,
        finishedAt: null,
      };
      next.servers = [];
      next.previousCounts = previousCounts;
      next.summary = null;
      next.nonResults = [];
      next.selected = null;
      next.preview = null;
      next.joinResult = null;
      // What a previous check found described a moment that has just been superseded.
      next.checks = new Map();
      next.checkedAt = new Map();
      next.autoCheckedAt = null;
      next.staleAt = null;
    });

    try {
      const payload = await browseServers(swept, progressed);
      update((next) => {
        next.servers = payload.servers;
        next.summary = payload.summary;
        next.nonResults = payload.non_results;
        next.browse.running = false;
        next.browse.cancelled = payload.cancelled;
        next.browse.completedAt = clockTime();
        next.browse.finishedAt = new Date().toISOString();
      });
    } catch (error) {
      update((next) => {
        next.browse.running = false;
        next.browse.error = browseFailure(error);
        // Rows that streamed in before the failure are this sweep's own and stand on their own.
        // Only a sweep that produced nothing falls back, and what it falls back to is marked.
        if (!next.servers.length && previous.length) {
          next.servers = previous;
          next.staleAt = previousAt;
          next.browse.completedAt = previousAt;
          next.browse.finishedAt = previousFinishedAt;
        }
      });
    }
  }

  function stop() {
    update((next) => (next.browse.stopping = true));
    cancelBrowse().catch(() => {
      // The sweep ends on its own if the message does not land.
    });
  }

  function finished() {
    if (!state.browse.running) return Promise.resolve();
    return new Promise((resolve) => {
      const unsubscribe = subscribe(() => {
        if (state.browse.running) return;
        unsubscribe();
        resolve();
      });
    });
  }

  return { refresh, refreshBehind, stop, finished };
}
