// SPDX-License-Identifier: GPL-3.0-only

// The Reveille pop-up window. Rust owns where it sits and when it is shown; this page owns the
// cards, and tells Rust how tall they are, or 0 to hide.

import { alertPopupAction, alertPopupReady, fitAlertPopup, onPopupCard } from "../api.js";
import { playChime } from "../chime.js";
import { $, el } from "../../../lib/dom.js";
import {
  addCard,
  cardTitle,
  expired,
  hiddenCount,
  removeCard,
  resume,
  revealed,
  SHOWN,
} from "./popup-stack.js";

const root = $("#popup");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const FADE_MS = 150;

let stack = [];
let pausedAt = null;
const nodes = new Map();
const leaving = new Set();

root.addEventListener("mouseenter", () => {
  pausedAt = Date.now();
});
root.addEventListener("mouseleave", () => {
  if (pausedAt === null) return;
  stack = resume(stack, Date.now() - pausedAt);
  pausedAt = null;
});
setInterval(() => {
  if (pausedAt !== null) return;
  for (const card of expired(stack, Date.now())) leave(card.eventId);
}, 250);

await onPopupCard(receive);
// Cards sent before the listener above existed were queued in Rust.
for (const card of await alertPopupReady().catch(() => [])) receive(card);

function receive(card) {
  if (card.chime) void playChime().catch(() => {});
  stack = addCard(stack, card, Date.now());
  render();
}

function leave(eventId) {
  if (leaving.has(eventId)) return;
  leaving.add(eventId);
  nodes.get(eventId)?.classList.add("popup-card--leaving");
  setTimeout(() => {
    leaving.delete(eventId);
    nodes.delete(eventId);
    const before = stack;
    stack = revealed(removeCard(stack, eventId), before, Date.now());
    render();
  }, reducedMotion.matches ? 0 : FADE_MS);
}

function act(action, eventId = "") {
  void alertPopupAction(action, eventId).catch(() => {});
}

function render() {
  for (const id of nodes.keys()) {
    if (!stack.some((card) => card.eventId === id)) nodes.delete(id);
  }
  const shown = stack.slice(0, SHOWN).map((card) => {
    if (!nodes.has(card.eventId)) nodes.set(card.eventId, cardNode(card));
    return nodes.get(card.eventId);
  });
  // The window hides under the pointer when its last card goes, so no mouseleave may follow.
  if (stack.length === 0) pausedAt = null;
  const more = hiddenCount(stack);
  root.replaceChildren(
    ...shown,
    ...(more > 0
      ? [el("button", {
          type: "button",
          className: "popup__more",
          onclick: () => {
            act("more");
            stack = [];
            render();
          },
        }, `+${more} more in Reveille`)]
      : []),
  );
  void fitAlertPopup(stack.length ? root.offsetHeight : 0).catch(() => {});
}

function cardNode(card) {
  // The test alert names no server, so there is nothing to join or snooze.
  const server = card.address !== "";
  return el("article", { className: "popup-card", role: "alert" },
    el("div", { className: "popup-card__head" },
      el("span", { className: "popup-card__brand" }, "Reveille"),
      el("button", {
        type: "button",
        className: "popup-card__dismiss",
        "aria-label": "Dismiss",
        title: "Dismiss",
        onclick: () => leave(card.eventId),
      }, "×"),
    ),
    el("button", {
      type: "button",
      className: "popup-card__body",
      title: server ? "Show this server in Reveille" : null,
      onclick: () => {
        act("open", card.eventId);
        leave(card.eventId);
      },
    },
      el("strong", { className: "popup-card__title" }, card.title ?? cardTitle(card)),
      card.detail && el("span", { className: "popup-card__detail" }, card.detail),
    ),
    server && el("div", { className: "popup-card__actions" },
      el("button", {
        type: "button",
        className: "btn btn--sm btn--primary",
        onclick: () => {
          act("join", card.eventId);
          leave(card.eventId);
        },
      }, "Join"),
      el("button", {
        type: "button",
        className: "btn btn--sm btn--utility",
        title: "No pop-up or notification for an hour. Alerts still appear under the bell.",
        onclick: () => {
          act("snooze");
          stack = [];
          render();
        },
      }, "Snooze 1 hour"),
    ),
  );
}
