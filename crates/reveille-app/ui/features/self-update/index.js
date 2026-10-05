// SPDX-License-Identifier: GPL-3.0-only

// Updating Reveille itself. A background check may reveal an offer, but only the player's
// "Update and restart" installs it; the Rust side keeps the checked release in between.

import { errorText } from "../../lib/shell.js";
import { state, update } from "../../lib/store.js";
import { cancelReveilleUpdate, checkReveilleUpdate, installReveilleUpdate, onSelfUpdateProgress } from "./api.js";
import { selfUpdateDialog } from "./dialog.js";

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

  const render = () => view.render(state.selfUpdate);

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
    render();
    view.dialog.showModal();
  }

  function dismiss() {
    if (!state.selfUpdate.running) view.dialog.close();
  }

  async function start() {
    if (state.selfUpdate.running || !state.selfUpdate.offer) return;
    state.selfUpdate.running = true;
    state.selfUpdate.stopping = false;
    state.selfUpdate.progress = { phase: "downloading", received: 0, total: null };
    state.selfUpdate.error = null;
    render();
    try {
      await installReveilleUpdate();
    } catch (error) {
      const stopped = state.selfUpdate.stopping;
      state.selfUpdate.running = false;
      state.selfUpdate.stopping = false;
      if (stopped) state.selfUpdate.progress = { phase: "cancelled" };
      else if (state.selfUpdate.progress?.phase !== "cancelled") state.selfUpdate.error = errorText(error);
      render();
    }
  }

  async function stop() {
    const progress = state.selfUpdate.progress;
    if (!state.selfUpdate.running || progress?.phase !== "downloading") return;
    state.selfUpdate.stopping = true;
    render();
    try {
      await cancelReveilleUpdate();
    } catch (error) {
      state.selfUpdate.stopping = false;
      state.selfUpdate.error = errorText(error);
      render();
    }
  }

  function receive(progress) {
    state.selfUpdate.progress = progress;
    if (progress.phase === "cancelled") {
      state.selfUpdate.running = false;
      state.selfUpdate.stopping = false;
    }
    render();
  }

  return { open, find, check };
}
