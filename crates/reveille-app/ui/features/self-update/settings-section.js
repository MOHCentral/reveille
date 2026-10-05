// SPDX-License-Identifier: GPL-3.0-only

// The About section of Settings: the running version and where updates stand.

import { el } from "../../lib/dom.js";
import { state } from "../../lib/store.js";
import { section } from "../settings/index.js";

/**
 * `version` is the running build, when known. The callbacks open the update dialog, check for an
 * update now and open a bug report.
 */
export function aboutSettingsSection({ version, onUpdate, onCheckUpdate, onReportBug }) {
  return ({ redraw }) =>
    section(
      "About",
      el("p", { className: "settings__value" }, version ? `Reveille ${version}` : "Reveille"),
      updateLine(onUpdate, onCheckUpdate, redraw),
      el("p", { className: "settings__hint" }, "Free software under the GNU General Public License, version 3."),
      el("button", { type: "button", className: "btn btn--sm btn--utility", onclick: onReportBug }, "Report a bug"),
    );
}

/** Where updates stand: an offer to install, a check in progress, or a button to look now. */
let updateCheck = "idle";

function updateLine(onUpdate, onCheckUpdate, redraw) {
  const offer = state.selfUpdate.offer;
  if (offer) {
    return el(
      "div",
      { className: "settings__row" },
      el("span", null, `Version ${offer.version} is available.`),
      el("button", { type: "button", className: "btn btn--sm btn--primary", onclick: onUpdate }, "Update"),
    );
  }
  const note = {
    idle: null,
    checking: "Checking…",
    current: "This is the latest version.",
    failed: "Reveille could not check for updates.",
  }[updateCheck];
  return el(
    "div",
    { className: "settings__row" },
    note && el("span", { className: "quiet" }, note),
    el(
      "button",
      {
        type: "button",
        className: "btn btn--sm",
        "aria-disabled": updateCheck === "checking" ? "true" : null,
        dataset: { focusKey: "settings-update-check" },
        onclick: async () => {
          if (updateCheck === "checking") return;
          updateCheck = "checking";
          redraw();
          try {
            updateCheck = (await onCheckUpdate()) ? "idle" : "current";
          } catch {
            updateCheck = "failed";
          }
          redraw();
        },
      },
      "Check for updates",
    ),
  );
}
