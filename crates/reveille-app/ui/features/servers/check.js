// SPDX-License-Identifier: GPL-3.0-only

// Asking one server, or a handful of remembered ones, again without sweeping the master list.

import { favorites } from "../../lib/bookmarks.js";
import { generations, session } from "../../lib/session.js";
import { errorText } from "../../lib/shell.js";
import { state, update } from "../../lib/store.js";
import { checkServer } from "./api.js";
import { applyCheckNonResult, applyCheckedRow } from "./reducers.js";
import { canRecheck, droppedIdentity } from "./selectors.js";

/**
 * Return `check`, `recheck` and `autoCheckFavorites`, which the shell subscribes to the store.
 *
 * `onReselect(address)` runs when a check changed the selected server's join question, so the pane
 * works out its sources again.
 */
export function checks({ onReselect }) {
  /**
   * Ask one server directly, without a master list.
   *
   * Two players want this, for opposite reasons. A favorite is often not in the sweep — the master
   * never registered it, or it did not answer in time — and until it is in the list it cannot be
   * selected or joined, so this is what makes a bookmark useful in the case that matters most. And
   * a server that *is* in the list was measured once, when the sweep ran: its map, its client count
   * and its round trip all age from that moment, and this is how one row is brought up to date
   * without spending a couple of hundred probes on the other two hundred.
   *
   * Takes one entry or a list of them, and probes sequentially: these are third-party servers and
   * there is no reason to burst at them.
   */
  async function check(subject) {
    const entries = Array.isArray(subject) ? subject : [subject];
    const generation = generations.check.current();
    let checked = null;

    for (const entry of entries) {
      if (!generations.check.isCurrent(generation)) return;
      // The row this check is about to replace, kept so `resettle` below can compare, and the
      // identity to fall back on if the check replaces it with nothing (`droppedIdentity`, in
      // reducers.js where it can be tested).
      const before = state.servers.find((row) => row.address === entry.address) ?? null;
      const dropped = droppedIdentity(entry);
      update((next) => next.checks.set(entry.address, { status: "checking", dropped }));

      let result;
      try {
        result = await checkServer(session(), entry.address, entry.queryPort);
      } catch (error) {
        if (!generations.check.isCurrent(generation)) return;
        update((next) =>
          next.checks.set(entry.address, { status: "failed", error: errorText(error), dropped }),
        );
        continue;
      }
      if (!generations.check.isCurrent(generation)) return;
      update((next) => {
        if (result.row) applyCheckedRow(next, entry, result, dropped, new Date().toISOString());
        else applyCheckNonResult(next, entry, result, dropped);
      });
      checked = result.row;
      if (entry.address === state.selected) resettle(before, result.row);
    }
    return checked;
  }

  /**
   * The selected server, asked again on its own.
   *
   * Not offered while a sweep is running: that is already re-asking every server in the list, and
   * this row is about to be replaced by it. Nor while a join is running, where the pane belongs to
   * that command and a check coming back empty would take the row out from under it.
   */
  function recheck(row) {
    if (!canRecheck(row.address)) return;
    check({ address: row.address, queryPort: Number(row.server.endpoint.query_port) });
  }

  /**
   * Keep the detail pane honest after a check has replaced the row beneath it.
   *
   * The catalogue lookup behind the pane is an answer about one running map, one rotation and one
   * reading of what is on disk. When the check found all of that unchanged it is still that
   * answer, and the player's source choices stand — discarding them because a client count moved
   * would cost them work for nothing. When any of it moved, or the server stopped answering, it is
   * an answer to a question no longer being asked, and it goes.
   *
   * A server that moved is **not** followed. The selection stays where the player put it and the
   * pane says where the answer came from, for the same reason a bookmark is not repointed: the two
   * addresses share a query port, which is not proof they are the same server. Following would
   * also select a row that, in Favorites or History, is not in the table at all.
   */
  function resettle(before, after) {
    if (!after || after.address !== before?.address) {
      generations.preview.next();
      update((next) => {
        next.preview = null;
        next.previewProgress = null;
        next.previewError = null;
        next.choices = new Map();
      });
      return;
    }
    if (!sameJoinQuestion(before, after)) onReselect(after.address);
  }

  /**
   * Whether two readings of one server pose the same join question.
   *
   * Not only the same map and rotation: `check_server` re-reads the installed maps, so a map put on
   * disk by other means between the two readings changes the answer without changing anything the
   * server published. The row's own verdict and the published checksum are what carry that, and a
   * preview kept across a change in either would price an old shopping list against a new row.
   */
  function sameJoinQuestion(before, after) {
    if (!before) return false;
    return (
      before.server.current_map === after.server.current_map &&
      before.server.map_checksum === after.server.map_checksum &&
      before.server.pr_downloads === after.server.pr_downloads &&
      before.compatibility.state.state === after.compatibility.state.state &&
      before.compatibility.current_map?.readiness === after.compatibility.current_map?.readiness &&
      before.server.rotation.length === after.server.rotation.length &&
      before.server.rotation.every((map, index) => map === after.server.rotation[index])
    );
  }

  /**
   * Check the favorites this sweep did not return, once per sweep, while they are on screen.
   *
   * Without it, opening the absent block after a refresh shows a list of servers with no data and a
   * row of buttons to press. Once per sweep, and only for the ones actually missing, keeps it to a
   * handful of requests against a sweep that just sent a couple of hundred.
   *
   * It waits for the block to be open. Collapsed, these probes would answer a question nobody asked
   * and write their answers where nobody can read them — and on a multi-game folder most of them go
   * to servers that were saved under another game and can only ever say the same thing. Opening the
   * block notifies, so the check runs then instead.
   */
  function autoCheckFavorites() {
    if (state.scope !== "favorites" || !state.showAbsent) return;
    if (state.browse.running || !state.browse.completedAt) return;
    if (state.autoCheckedAt === state.browse.completedAt) return;
    const present = new Set(state.servers.map((row) => row.address));
    const absent = favorites().filter((entry) => !present.has(entry.address));
    state.autoCheckedAt = state.browse.completedAt;
    if (absent.length) check(absent);
  }

  return { check, recheck, autoCheckFavorites };
}
