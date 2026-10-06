// SPDX-License-Identifier: GPL-3.0-only

// Updating Reveille itself. A background check may reveal an offer, but only the player's
// "Update and restart" installs it; the Rust side keeps the checked release in between.

import { errorText } from "../../lib/shell.js";
import { state, subscribe, update } from "../../lib/store.js";
import { cancelReveilleUpdate, checkReveilleUpdate, installReveilleUpdate, onSelfUpdateProgress } from "./api.js";
import { selfUpdateDialog } from "./dialog.js";

/** A newer signed Reveille release retained by the Rust updater, when one was found. */
export function initial() {
  return { selfUpdate: { offer: null, running: false, stopping: false, progress: null, error: null } };
}

/**
 * Mount the update dialog in `host` and listen for download progress.
 *
 * `onOffer()` runs when a background check finds a release. Returns `open()` for every control
 * that offers the update, `find()` for the launch check and `check()` for Settings' "Check now",
 * which resolves to the offer or null.
 */
export function selfUpdate({ host, onOffer }) {
  const view = selfUpdateDialog({ onLater: dismiss, onInstall: start, onStop: stop });
  host.append(view.dialog);
  view.dialog.addEventListener("cancel", (event) => {
    if (state.selfUpdate.running) event.preventDefault();
  });
  void onSelfUpdateProgress(receive);

  subscribe(() => view.render(state.selfUpdate));

  /** A failed background check is unrelated to the player's current task and stays non-blocking. */
  async function find() {
    try {
      const offer = await checkReveilleUpdate();
      if (!offer) return;
      update((next) => (next.selfUpdate.offer = offer));
      onOffer();
    } catch {
      // The next launch asks again. Setup and server browsing continue with no invented diagnosis.
    }
  }

  async function check() {
    const offer = await checkReveilleUpdate();
    if (offer) update((next) => (next.selfUpdate.offer = offer));
    return offer;
  }

  function open() {
    if (!state.selfUpdate.offer || state.joining) return;
    view.render(state.selfUpdate);
    view.dialog.showModal();
  }

  function dismiss() {
    if (!state.selfUpdate.running) view.dialog.close();
  }

  async function start() {
    if (state.selfUpdate.running || !state.selfUpdate.offer) return;
    update(({ selfUpdate }) => {
      selfUpdate.running = true;
      selfUpdate.stopping = false;
      selfUpdate.progress = { phase: "downloading", received: 0, total: null };
      selfUpdate.error = null;
    });
    try {
      await installReveilleUpdate();
    } catch (error) {
      update(({ selfUpdate }) => {
        const stopped = selfUpdate.stopping;
        selfUpdate.running = false;
        selfUpdate.stopping = false;
        if (stopped) selfUpdate.progress = { phase: "cancelled" };
        else if (selfUpdate.progress?.phase !== "cancelled") selfUpdate.error = errorText(error);
      });
    }
  }

  async function stop() {
    const progress = state.selfUpdate.progress;
    if (!state.selfUpdate.running || progress?.phase !== "downloading") return;
    update((next) => (next.selfUpdate.stopping = true));
    try {
      await cancelReveilleUpdate();
    } catch (error) {
      update(({ selfUpdate }) => {
        selfUpdate.stopping = false;
        selfUpdate.error = errorText(error);
      });
    }
  }

  function receive(progress) {
    update(({ selfUpdate }) => {
      selfUpdate.progress = progress;
      if (progress.phase === "cancelled") {
        selfUpdate.running = false;
        selfUpdate.stopping = false;
      }
    });
  }

  return { open, find, check };
}
