// SPDX-License-Identifier: GPL-3.0-only

// The Server list section of Settings.

import { PING_FAIR_CHOICES, PING_GOOD_CHOICES, preferences } from "../../lib/preferences.js";
import { choice, section, toggle } from "../settings/index.js";

export function serverListSettingsSection() {
  return ({ change }) => {
    const prefs = preferences();
    return section(
      "Server list",
      toggle(
        "settings-refresh-focus",
        "Refresh a list older than 5 minutes when I come back to Reveille",
        prefs.refreshOnFocus,
        (on) => change("refreshOnFocus", on),
      ),
      choice(
        "settings-ping-good",
        "Ping is green below",
        PING_GOOD_CHOICES,
        prefs.pingGood,
        (value) => `${value} ms`,
        (value) => change("pingGood", value),
      ),
      choice(
        "settings-ping-fair",
        "and amber up to",
        PING_FAIR_CHOICES,
        prefs.pingFair,
        (value) => `${value} ms`,
        (value) => change("pingFair", value),
      ),
    );
  };
}
