// SPDX-License-Identifier: GPL-3.0-only

// The titlebar bell: its unread badge and the popover of recent arrivals.

import { $, el } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { closePopover, openPopover, popoverAnchor } from "../../lib/popover.js";
import { plural, timeAgo } from "../../lib/format.js";
import { GAME_LABELS } from "../../lib/catalog.js";
import { playableGames } from "../../lib/session.js";
import { state, update } from "../../lib/store.js";
import { arrivalEvents, clearArrivals, markArrivalsRead, unreadArrivalCount } from "./arrival-events.js";
import { isStale } from "./reach.js";

/** The notification failure, with the way to fix it where the system has a page for it. */
export function alertErrorLine(onNotificationSettings) {
  return el(
    "p",
    { className: "error", role: "alert" },
    `${state.alertError} `,
    el(
      "button",
      { type: "button", className: "btn btn--sm btn--utility", onclick: onNotificationSettings },
      "Open notification settings",
    ),
  );
}

/** The server an arrival happened on, in the shape `openServer` takes. */
export function arrivalTarget(event) {
  return { game: event.game, address: event.address, queryPort: event.queryPort, hostname: event.hostname };
}

/**
 * `onBadge()` hears every repaint of the unread count. Nothing is drawn or listened to until
 * `mount(intents)`.
 */
export function bell({ onOpenWatching, onNotificationSettings, onBadge }) {
  let intents = null;

  function mount(table) {
    intents = table;
    $("#arrival-events-btn").prepend(icon("bell"));
    $("#arrival-events-btn").addEventListener("click", toggleArrivals);
  }

  function renderArrivalBadge() {
    const count = unreadArrivalCount();
    const badge = $("#arrival-unread");
    badge.classList.toggle("hidden", count === 0);
    badge.textContent = count > 0 ? String(count) : "";
    $("#arrival-events-btn").setAttribute("aria-label",
      count ? `Player alerts, ${count} unread` : "Player alerts");
    onBadge();
  }

  /**
   * The bell's popover: the latest arrivals, newest first, each with Show and Join. Opening it marks
   * them read, but the ones that were unread keep their edge until it closes.
   */
  function toggleArrivals() {
    const anchor = $("#arrival-events-btn");
    if (popoverAnchor() === anchor) {
      closePopover();
      return;
    }
    const events = arrivalEvents().slice(0, 12);
    markArrivalsRead();
    renderArrivalBadge();
    openPopover(anchor, "Player alerts",
      el("div", { className: "popover__head" },
        el("h2", { className: "popover__title" }, "Player alerts"),
        state.alertError && alertErrorLine(onNotificationSettings),
      ),
      events.length === 0
        ? el("p", { className: "popover__empty" },
            "No alerts yet. Turn on a server's bell and Reveille tells you here when players join it.")
        : el("div", null, events.map(arrivalEntry)),
      el("div", { className: "popover__foot" },
        el("button", {
          type: "button",
          className: "btn btn--sm btn--utility",
          onclick: () => {
            closePopover();
            onOpenWatching();
          },
        }, "Open Watching"),
        events.length > 0 && el("button", {
          type: "button",
          className: "btn btn--sm btn--utility",
          onclick: () => {
            clearArrivals();
            renderArrivalBadge();
            update(() => {});
            closePopover();
            toggleArrivals();
          },
        }, "Clear all"),
      ),
    );
  }

  function arrivalEntry(event) {
    const where = playableGames(state.install).length > 1 ? `${GAME_LABELS[event.game]} · ` : "";
    const classes = ["arrival", !event.read && "arrival--unread", isStale(event) && "arrival--stale"];
    return el("div", { className: classes.filter(Boolean).join(" ") },
      el("span", { className: "arrival__title", title: event.hostname },
        el("strong", null, plural(event.count, "player")), ` on ${event.hostname}`),
      el("span", { className: "arrival__meta" },
        [where + (timeAgo(new Date(event.at).toISOString()) ?? ""), event.detail].filter(Boolean).join(" · ")),
      el("span", { className: "arrival__actions" },
        el("button", {
          type: "button",
          className: "btn btn--sm",
          onclick: () => intents.openServer(arrivalTarget(event)),
        }, "Show"),
        el("button", {
          type: "button",
          className: "btn btn--sm btn--primary",
          onclick: () => intents.openServer({ ...arrivalTarget(event), join: true }),
        }, "Join"),
      ),
    );
  }

  return { mount, renderArrivalBadge, toggleArrivals };
}
