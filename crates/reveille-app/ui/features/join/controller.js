// SPDX-License-Identifier: GPL-3.0-only

// Selecting a server, pricing its join, fetching what it needs and starting the game.

import { recordLaunch } from "../../lib/bookmarks.js";
import { generations, session } from "../../lib/session.js";
import { errorText, trackEvent } from "../../lib/shell.js";
import { state, update } from "../../lib/store.js";
import { rememberReadyJoin, retainBackgroundRow, selectedRow } from "../servers/index.js";
import {
  installAndLaunch,
  installServerFiles,
  onInstallProgress,
  previewJoin,
} from "./api.js";
import { shoppingTotals } from "./view.js";

/**
 * How long a selection has to hold still before its catalogue lookup is sent.
 *
 * Selection follows focus in the grid, which is what makes the arrow keys useful — but it also
 * means holding Down through twenty rows used to fire twenty `preview_join` calls at moh-db, one
 * per row passed over. The pane still updates on every step; only the
 * third-party request waits. Long enough that scrolling costs nothing, short enough that a
 * deliberate selection does not feel delayed.
 */
export const PREVIEW_SETTLE_MS = 220;

/**
 * Listen for install progress and return the join pane's controls.
 *
 * `showPane()` opens a collapsed detail pane, and `focusJoin(address)` moves focus to its Join
 * button once it can take it: an activation that needs consent stops there. `onFilesChanged()` is
 * told once a fetch or join may have written to the game folder.
 */
export function joinController({ showPane, focusJoin, onFilesChanged = () => {} }) {
  let previewTimer = null;

  /** Preview progress for as long as `token` is the current selection. */
  const showPreviewProgress = (token) => (progress) => {
    if (!generations.preview.isCurrent(token)) return;
    update((next) => (next.previewProgress = progress));
  };

  onInstallProgress((progress) => {
    if (!state.installRun) return;
    update((next) => {
      const items = next.installRun.items;
      const key = progress.filename;
      const existing = items.get(key) ?? {
        map: progress.map,
        filename: progress.filename,
        received: 0,
        total: null,
      };
      items.set(key, {
        ...existing,
        filename: progress.filename,
        phase: progress.phase,
        received: progress.received ?? existing.received,
        total: progress.total ?? existing.total,
        reason: progress.reason ?? existing.reason,
      });
    });
  });

  function select(address) {
    const token = generations.preview.next();
    if (previewTimer !== null) {
      clearTimeout(previewTimer);
      previewTimer = null;
    }
    update((next) => {
      next.selected = address;
      next.preview = null;
      next.previewProgress = null;
      next.previewError = null;
      next.choices = new Map();
      next.installRun = null;
      next.joinResult = null;
      next.joinError = null;
    });

    const row = selectedRow();
    if (row) trackEvent({ event: "server_selected", ready: row.compatibility.state.state === "compatible" });
    // Nothing to resolve: the map list is already satisfied, or there is none.
    if (!row || row.compatibility.state.state === "compatible") return;

    // The meter goes up immediately even though the request has not been sent. It is honest about
    // what it says — this server's sources are being worked out — and a control that looked idle for
    // a fifth of a second and then started would read as a stutter.
    update((next) => (next.previewProgress = { index: -1, of: 0, map: "" }));
    previewTimer = setTimeout(() => {
      previewTimer = null;
      void resolvePreview(address, token);
    }, PREVIEW_SETTLE_MS);
  }

  /**
   * A double-click or Enter on a row. A server with nothing to fetch joins at once; anything else
   * stops on the priced Join button, so no download starts without its size on screen and a second
   * Enter is the consent.
   */
  function activate(address) {
    if (state.selected !== address) select(address);
    const row = selectedRow();
    if (!row) return;
    const ready = row.compatibility.state.state === "compatible";
    const idle = !state.joining && state.checks.get(address)?.status !== "checking";
    if (ready && idle) {
      void getAndJoin(row, false);
      return;
    }
    // The price and the consent live in the pane, so a hidden pane opens for them.
    if (state.detailCollapsed) showPane();
    focusJoin(address);
  }

  async function resolvePreview(address, token) {
    if (!generations.preview.isCurrent(token)) return;
    try {
      const preview = await previewJoin(session(), address, showPreviewProgress(token));
      if (!generations.preview.isCurrent(token)) return;
      update((next) => {
        next.preview = preview;
        next.previewProgress = null;
      });
    } catch (error) {
      if (!generations.preview.isCurrent(token)) return;
      update((next) => {
        next.previewProgress = null;
        next.previewError = errorText(error);
      });
    }
  }

  async function getServerFiles(row) {
    const token = generations.join.next();
    const selection = generations.preview.current();
    update((next) => {
      next.joinError = null;
      next.joinResult = null;
      next.joining = true;
      retainBackgroundRow(next, row.address);
      next.installRun = { items: new Map(), done: false };
    });

    try {
      const result = await installServerFiles(session(), row.address, showPreviewProgress(selection));
      onFilesChanged();
      if (!generations.join.isCurrent(token)) return;
      update((next) => {
        next.joining = false;
        next.installRun = null;
        next.preview = result.preview;
        next.previewProgress = null;
        next.choices = new Map();
        next.joinError = result.failures.length
          ? result.failures.map((failure) => `${failure.map}: ${failure.reason}`).join(" ")
          : null;
      });
    } catch (error) {
      if (!generations.join.isCurrent(token)) return;
      update((next) => {
        next.joining = false;
        next.installRun = null;
        next.joinError = errorText(error);
      });
    }
  }

  async function getAndJoin(row, acceptIncomplete) {
    const token = generations.join.next();
    const preview = state.preview?.address === row.address ? state.preview : null;
    const totals = preview
      ? shoppingTotals(preview)
      : { count: 0 };
    const selectedCandidateIds = [...state.choices.values()];

    update((next) => {
      next.joinError = null;
      next.joinResult = null;
      // `installRun` covers the downloads; `joining` covers the command. A compatible server has
      // nothing to fetch, so without this the pane would look idle while the game was being started,
      // and a check finishing in that window could drop the row the outcome renders against.
      next.joining = true;
      retainBackgroundRow(next, row.address);
      next.installRun = totals.count > 0 ? { items: new Map(), done: false } : null;
    });

    try {
      const result = await installAndLaunch(
        session(),
        row.address,
        selectedCandidateIds,
        acceptIncomplete,
      );
      // Only a launched outcome is remembered. A refusal means Reveille did not start the game,
      // so there is nothing that happened to record. The launch is recorded even
      // if the session moved on — it really did happen — but its result is not rendered into a
      // session it is no longer about.
      if (result.outcome?.launch === "launched") recordLaunch(row);
      if (result.installed?.length) onFilesChanged();
      if (!generations.join.isCurrent(token)) return;
      update((next) => {
        next.joining = false;
        next.installRun = null;
        next.joinResult = { ...result, address: row.address };
        rememberReadyJoin(next, row, result);
      });
    } catch (error) {
      if (!generations.join.isCurrent(token)) return;
      update((next) => {
        next.joining = false;
        next.installRun = null;
        next.joinError = errorText(error);
      });
    }
  }

  return { select, activate, getServerFiles, getAndJoin };
}
