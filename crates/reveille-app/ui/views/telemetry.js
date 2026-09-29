// SPDX-License-Identifier: GPL-3.0-only

// The one-time question about anonymous statistics, and the words Settings reuses for it. Nothing
// is sent until the player picks an answer; closing the dialog without one asks again next run.

import { closeDialog, openDialog } from "../lib/dialog.js";
import { el } from "../lib/dom.js";

export const TELEMETRY_LABEL = "Send anonymous usage statistics and crash reports";

export const TELEMETRY_SUMMARY =
  "Which steps of finding and joining a server worked, why a join failed, and where Reveille crashed. " +
  "Never your player name, game folder, server passwords, CD key or computer name.";

/** Ask once. `onChoose(shared)` saves the answer; `onLearnMore` opens the full list. */
export function openTelemetryPrompt({ onChoose, onLearnMore }) {
  const choose = (shared) => {
    closeDialog();
    onChoose(shared);
  };
  openDialog(
    "Help improve Reveille?",
    el("p", null, "Reveille can send anonymous statistics so we can see where new players get stuck."),
    el("p", { className: "quiet" }, TELEMETRY_SUMMARY),
    el("p", { className: "quiet" }, "You can change this at any time in Settings."),
    el(
      "div",
      { className: "settings__row" },
      el("button", { type: "button", className: "btn btn--sm btn--utility", onclick: onLearnMore }, "What is sent"),
      el("button", { type: "button", className: "btn btn--sm", onclick: () => choose(false) }, "Don't share"),
      el("button", { type: "button", className: "btn btn--sm btn--primary", onclick: () => choose(true) }, "Share"),
    ),
  );
}
