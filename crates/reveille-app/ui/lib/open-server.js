// SPDX-License-Identifier: GPL-3.0-only

// The shell's `openServer` intent: bring one server to the front from outside the list, as an
// alert's Show and Join do. Kernel code, so the steps it takes from features are handed in.

import { el } from "./dom.js";
import { closeDialog, openDialog } from "./dialog.js";
import { occupancy } from "./format.js";
import { closePopover } from "./popover.js";
import { GAME_LABELS } from "./catalog.js";
import { playableGames } from "./session.js";
import { state } from "./store.js";

/** Why an alert's server action must wait, shared with the notification list's controls. */
export function openServerUnavailableReason(game) {
  if (state.joining) return "Wait for the current join to finish";
  if (state.browse.running && (!state.browse.background || state.game !== game)) {
    return "Wait for the server list refresh to finish";
  }
  return null;
}

/**
 * `resume()` retries a request that had to wait for a sweep or a join to end; the shell calls it on
 * every render.
 */
export function openServerWorkflow({ selectGame, browseFinished, check, reveal, select, activate, focus }) {
  let pendingOpen = null;
  let opening = false;

  /**
   * Show an existing row immediately, then switch games if needed and ask the server again.
   * A background refresh can continue alongside the check and join. A second request made while
   * one is under way replaces it.
   */
  function openServer({ game, address, queryPort, hostname, join = false }) {
    pendingOpen = { game, address, queryPort, hostname, join };
    closeDialog();
    closePopover();
    // A refresh behind the list keeps its rows usable while the new readings arrive.
    if (
      !openServerUnavailableReason(game) && state.install && playableGames(state.install).includes(game) &&
      state.game === game &&
      state.servers.some((row) => row.address === address)
    ) {
      reveal(address);
      select(address);
    }
    void focus().catch(() => {});
    void openPending();
  }

  async function openPending() {
    if (opening || !pendingOpen || openServerUnavailableReason(pendingOpen.game)) return;
    opening = true;
    const pending = pendingOpen;
    const { game, address, queryPort, hostname } = pending;
    pendingOpen = null;
    try {
      if (!state.install || !playableGames(state.install).includes(game)) {
        openDialog("Server unavailable", el("p", null,
          `${hostname} (${address}) requires ${GAME_LABELS[game]}.`));
        return;
      }
      if (state.game !== game) await selectGame(game);
      if (state.browse.running && openServerUnavailableReason(game)) await browseFinished();
      if (state.game !== game || state.joining) {
        pendingOpen = pending;
        return;
      }
      const checked = await check({ address, queryPort });
      if (pendingOpen) return;
      if (checked?.address === address && state.game === game) {
        reveal(address);
        select(address);
        if (pending.join && occupancy(checked.server).clients === 0) {
          openDialog("No players right now", el("p", null,
            `${hostname} has no players right now. It is selected in the list if you still want to join.`));
        } else if (pending.join) {
          // Join goes through the same path as a double-click, so a server that needs downloads
          // stops on its priced button rather than fetching anything.
          activate(address);
        }
      } else {
        openDialog("Server unavailable", el("p", null,
          `${hostname} (${address}) is no longer answering.`));
      }
    } finally {
      opening = false;
      if (pendingOpen) queueMicrotask(() => void openPending());
    }
  }

  function resume() {
    if (pendingOpen && !opening && !openServerUnavailableReason(pendingOpen.game)) {
      queueMicrotask(() => void openPending());
    }
  }

  return { openServer, resume };
}
