// SPDX-License-Identifier: GPL-3.0-only

// The Notifications section of Settings. Watched servers are managed in the Watching view, not
// here.

import { el } from "../../lib/dom.js";
import { preferences, setPreference } from "../../lib/preferences.js";
import { state, update } from "../../lib/store.js";
import { choice, section, START_AT_LOGIN_LABEL, toggle } from "../settings/index.js";
import { alertErrorLine } from "./bell.js";
import { THRESHOLDS } from "./player-alerts.js";
import { ALERT_STYLES, COOLDOWN_CHOICES } from "./preferences.js";

const ALERT_STYLE_LABELS = {
  popup: "Reveille pop-up (recommended)",
  system: "System notification",
};

/**
 * `popupSupported` is whether this desktop can draw the Reveille pop-up; `onTestAlert()` sends a
 * test alert in the chosen style. `startAtLogin` is whether Reveille starts at sign-in, null when
 * unknown; `onStartAtLogin(on)` changes it and resolves to the answer that holds.
 * `onCloseToTray(on)` tells the shell about the tray setting.
 */
export function alertsSettingsSection({
  popupSupported,
  startAtLogin,
  onCloseToTray,
  onStartAtLogin,
  onNotificationSettings,
  onTestAlert,
  onOpenWatching,
}) {
  let login = startAtLogin;
  return ({ change, redraw }) => {
    const prefs = preferences();
    const alertsOff = !prefs.alertsEnabled;
    return section(
      "Notifications",
      toggle("settings-alerts", "Notify me when players join a watched server", prefs.alertsEnabled, (on) =>
        change("alertsEnabled", on),
      ),
      state.alertError && alertErrorLine(onNotificationSettings),
      popupSupported &&
        choice(
          "settings-alert-style",
          "Show alerts as",
          ALERT_STYLES,
          prefs.alertStyle,
          (value) => ALERT_STYLE_LABELS[value],
          (value) => change("alertStyle", value),
          alertsOff,
          String,
        ),
      popupSupported &&
        prefs.alertStyle === "popup" &&
        el(
          "p",
          { className: "settings__hint" },
          "The pop-up shows even during Do Not Disturb or Focus, and over a game in windowed or " +
            "borderless mode. Turn on \"Don't notify while the game is running\" below to keep it out of your games.",
        ),
      el(
        "button",
        {
          type: "button",
          className: "btn btn--sm",
          disabled: alertsOff,
          dataset: { focusKey: "settings-test-alert" },
          onclick: async () => {
            try {
              await onTestAlert();
            } catch {
              update((next) => (next.alertError = "Reveille could not show a system notification."));
              redraw();
            }
          },
        },
        "Send test alert",
      ),
      choice(
        "settings-threshold",
        "New watches notify at",
        THRESHOLDS,
        prefs.defaultThreshold,
        (value) => (value === 1 ? "1 player" : `${value} players`),
        (value) => change("defaultThreshold", value),
        alertsOff,
      ),
      choice(
        "settings-cooldown",
        "Wait before alerting again for a server",
        COOLDOWN_CHOICES,
        prefs.cooldownMinutes,
        (value) => `${value} min`,
        (value) => change("cooldownMinutes", value),
        alertsOff,
      ),
      toggle(
        "settings-sound",
        "Play a sound with each alert",
        prefs.alertSound,
        (on) => change("alertSound", on),
        alertsOff,
      ),
      toggle(
        "settings-quiet",
        "Don't notify while the game is running",
        prefs.quietWhilePlaying,
        (on) => change("quietWhilePlaying", on),
        alertsOff,
      ),
      toggle(
        "settings-tray",
        "Keep watching when I close the window",
        prefs.closeToTray,
        async (on) => {
          setPreference("trayChosen", true);
          change("closeToTray", on);
          onCloseToTray(on);
          // Starting hidden at sign-in with no icon to bring the window back would be a trap.
          if (!on && login) {
            login = await onStartAtLogin(false);
            redraw();
          }
        },
      ),
      prefs.closeToTray &&
        el(
          "p",
          { className: "settings__hint" },
          "Closing the window leaves Reveille in the notification area. Right-click its icon to quit.",
        ),
      prefs.closeToTray &&
        login !== null &&
        toggle("settings-login", START_AT_LOGIN_LABEL, login === true, async (on) => {
          login = await onStartAtLogin(on);
          redraw();
        }),
      el(
        "button",
        { type: "button", className: "btn btn--sm", onclick: onOpenWatching },
        "Manage watched servers",
      ),
    );
  };
}
