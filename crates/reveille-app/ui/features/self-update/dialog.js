// SPDX-License-Identifier: GPL-3.0-only

// The update dialog: the offer, the download's progress and the three actions.

import { el } from "../../lib/dom.js";
import { offerText, progressShare, progressText } from "./format.js";

/** Build the dialog. `render(selfUpdate)` repaints it from `state.selfUpdate`. */
export function selfUpdateDialog({ onLater, onInstall, onStop }) {
  const copy = el("p", { id: "reveille-update-copy" });
  const fill = el("span", { id: "reveille-update-meter-fill", className: "meter__fill" });
  const meter = el("div", { id: "reveille-update-meter", className: "meter meter--indeterminate" }, fill);
  const status = el("span", { id: "reveille-update-status", className: "quiet data" });
  const progressBox = el(
    "div",
    { id: "reveille-update-progress", className: "stack--tight hidden", role: "status", "aria-live": "polite" },
    meter,
    status,
  );
  const error = el("p", { id: "reveille-update-error", className: "error hidden", role: "alert" });
  const stop = el(
    "button",
    { type: "button", className: "btn btn--ghost hidden", id: "reveille-update-stop", onclick: onStop },
    "Stop download",
  );
  const later = el("button", { type: "button", className: "btn", id: "reveille-update-later", onclick: onLater }, "Later");
  const install = el(
    "button",
    { type: "button", className: "btn btn--primary", id: "reveille-update-install", onclick: onInstall },
    "Update and restart",
  );
  const dialog = el(
    "dialog",
    {
      id: "reveille-update-dialog",
      "aria-labelledby": "reveille-update-title",
      "aria-describedby": "reveille-update-copy",
    },
    el(
      "div",
      { className: "dialog__head" },
      el("h2", { className: "display heading-sm", id: "reveille-update-title" }, "Update Reveille"),
    ),
    el(
      "div",
      { className: "dialog__body" },
      copy,
      el("p", { className: "quiet" }, "Reveille checks the update before installing it. The app will close and reopen."),
      progressBox,
      error,
    ),
    el("div", { className: "dialog__foot" }, stop, later, install),
  );

  function render({ offer, progress, running, stopping, error: message }) {
    if (!offer) return;
    copy.textContent = offerText(offer);
    install.disabled = running;
    later.disabled = running;
    stop.classList.toggle("hidden", !(running && progress?.phase === "downloading"));
    stop.disabled = stopping;
    stop.textContent = stopping ? "Stopping…" : "Stop download";

    progressBox.classList.toggle("hidden", !progress);
    const share = progressShare(progress);
    meter.classList.toggle("meter--indeterminate", share === null);
    fill.style.width = share === null ? "" : `${share}%`;
    status.textContent = progressText(progress);
    error.textContent = message ?? "";
    error.classList.toggle("hidden", !message);
  }

  return { dialog, render };
}
