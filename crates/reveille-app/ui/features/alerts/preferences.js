// SPDX-License-Identifier: GPL-3.0-only

// The alert settings, registered with the shared preferences store when this module loads.

import { registerPreferences } from "../../lib/preferences.js";
import { THRESHOLDS } from "./player-alerts.js";

export const COOLDOWN_CHOICES = [5, 15, 30, 60];
export const ALERT_STYLES = ["popup", "system"];

registerPreferences(
  {
    alertsEnabled: true,
    defaultThreshold: 1,
    cooldownMinutes: 15,
    quietWhilePlaying: false,
    alertSound: true,
    // Falls back to the system notification wherever the pop-up cannot be drawn.
    alertStyle: "popup",
    // Not a setting, but a one-time explanation that must not come back.
    alertsIntroShown: false,
  },
  {
    alertsEnabled: (value) => typeof value === "boolean",
    defaultThreshold: (value) => THRESHOLDS.includes(value),
    cooldownMinutes: (value) => COOLDOWN_CHOICES.includes(value),
    quietWhilePlaying: (value) => typeof value === "boolean",
    alertSound: (value) => typeof value === "boolean",
    alertStyle: (value) => ALERT_STYLES.includes(value),
    alertsIntroShown: (value) => typeof value === "boolean",
  },
);
