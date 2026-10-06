// SPDX-License-Identifier: GPL-3.0-only

// The Privacy section of Settings.

import { el } from "../../lib/dom.js";
import { section, toggle } from "./dialog.js";

const TELEMETRY_LABEL = "Send anonymous usage statistics and crash reports";
const TELEMETRY_SUMMARY =
  "Which steps of finding and joining a server worked, why a join failed, and where Reveille crashed. " +
  "Never your player name, game folder, server passwords, CD key or computer name.";

/**
 * `telemetry` is the saved statistics choice; `onTelemetry(shared)` saves a new one and resolves
 * to the status that results. The section is left out where statistics are not available.
 */
export function privacySettingsSection({ telemetry, onTelemetry, onTelemetryDetails }) {
  let current = telemetry;
  return ({ redraw }) =>
    current?.available &&
      section(
        "Privacy",
        toggle("settings-telemetry", TELEMETRY_LABEL, current.shared === true, async (on) => {
          // Kept outside the draw so a later redraw from any other control shows the saved answer.
          current = await onTelemetry(on).catch(() => current);
          redraw();
        }),
        el("p", { className: "settings__hint" }, TELEMETRY_SUMMARY),
        el(
          "button",
          { type: "button", className: "btn btn--sm btn--utility", onclick: onTelemetryDetails },
          "What is sent",
        ),
      );
}
