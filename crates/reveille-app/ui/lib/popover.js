// SPDX-License-Identifier: GPL-3.0-only

// A panel that hangs under the control that opened it: the alert bell's arrivals, a watch's rule.
//
// Not modal, unlike the dialog: Tab moves through it and out of it, and leaving it closes it. It
// closes on Escape, on a click elsewhere and when the window loses focus, and gives focus back to
// its control when it held it.

import { el, fill } from "./dom.js";

let open = null;

/** Open `nodes` under `anchor`, replacing any popover already open. Returns the panel. */
export function openPopover(anchor, label, ...nodes) {
  closePopover();
  const panel = el("div", { className: "popover", role: "dialog", "aria-label": label, tabIndex: -1 });
  fill(panel, ...nodes);
  document.body.append(panel);
  place(panel, anchor);
  anchor.setAttribute("aria-expanded", "true");
  (panel.querySelector("button:not([disabled]), select, input") ?? panel).focus();

  const onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closePopover({ restoreFocus: true });
  };
  const onAway = (event) => {
    if (!panel.contains(event.target) && !anchor.contains(event.target)) closePopover();
  };
  const onFocusOut = (event) => {
    if (event.relatedTarget && !panel.contains(event.relatedTarget)) closePopover();
  };
  const onResize = () => closePopover();

  panel.addEventListener("keydown", onKey);
  panel.addEventListener("focusout", onFocusOut);
  document.addEventListener("pointerdown", onAway, true);
  window.addEventListener("blur", onResize);
  window.addEventListener("resize", onResize);

  open = {
    panel,
    anchor,
    teardown: () => {
      panel.removeEventListener("keydown", onKey);
      panel.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onAway, true);
      window.removeEventListener("blur", onResize);
      window.removeEventListener("resize", onResize);
    },
  };
  return panel;
}

export function closePopover({ restoreFocus = false } = {}) {
  if (!open) return;
  const { panel, anchor, teardown } = open;
  open = null;
  teardown();
  anchor.setAttribute("aria-expanded", "false");
  const returning = restoreFocus || panel.contains(document.activeElement);
  panel.remove();
  if (returning) anchor.focus?.();
}

/** Whether a popover is open, and which control it belongs to. */
export function popoverAnchor() {
  return open?.anchor ?? null;
}

/** Under the anchor, right edges aligned, kept inside the window. */
function place(panel, anchor) {
  const margin = 8;
  const box = anchor.getBoundingClientRect();
  const width = panel.offsetWidth;
  const height = panel.offsetHeight;
  const left = Math.max(margin, Math.min(box.right - width, window.innerWidth - width - margin));
  const below = box.bottom + 4;
  const top = below + height > window.innerHeight - margin ? Math.max(margin, box.top - height - 4) : below;
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}
