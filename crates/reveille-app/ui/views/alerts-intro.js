// SPDX-License-Identifier: GPL-3.0-only

// Shown once, when the first server is watched: what an alert is, a way to see one now, and the
// two settings that decide whether alerts can still arrive once the window is closed.

import { $, el, preserveFocus } from "../lib/dom.js";
import { closeDialog, openDialog } from "../lib/dialog.js";
import { preferences, setPreference } from "../lib/preferences.js";
import { START_AT_LOGIN_LABEL, toggle } from "./settings.js";

/**
 * `startAtLogin` is the sign-in state, null when unknown. `onTest()` sends a test alert and
 * rejects with the reason it could not; `onCloseToTray(on)` and `onStartAtLogin(on)` work as in
 * Settings; `onNotificationSettings()` opens the system page.
 */
export function openAlertsIntro(options) {
  const { onTest, onCloseToTray, onStartAtLogin, onNotificationSettings } = options;
  const redraw = () => preserveFocus($("#info-dialog-body"), () => openAlertsIntro(options));
  const prefs = preferences();
  const test = options.test ?? "idle";

  openDialog(
    "Player alerts",
    el(
      "p",
      null,
      "While Reveille is running, it checks the servers you watch every minute and notifies you " +
        "when players join. " +
        "Every alert also stays under the bell.",
    ),
    el(
      "div",
      { className: "settings__row" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn--sm",
          dataset: { focusKey: "intro-test" },
          onclick: async () => {
            try {
              await onTest();
              options.test = "sent";
            } catch {
              options.test = "failed";
            }
            redraw();
          },
        },
        "Send test alert",
      ),
      test === "sent" && el("span", { className: "quiet" }, "Sent. If you don't see it, check your system's notification settings."),
    ),
    test === "failed" &&
      el(
        "p",
        { className: "error", role: "alert" },
        "Reveille could not show a notification. Notifications may be turned off for it. ",
        el(
          "button",
          { type: "button", className: "btn btn--sm btn--utility", onclick: onNotificationSettings },
          "Open notification settings",
        ),
      ),
    toggle("intro-tray", "Keep watching when I close the window", prefs.closeToTray, async (on) => {
      setPreference("trayChosen", true);
      setPreference("closeToTray", on);
      onCloseToTray(on);
      if (!on && options.startAtLogin) options.startAtLogin = await onStartAtLogin(false);
      redraw();
    }),
    prefs.closeToTray &&
      options.startAtLogin !== null &&
      toggle("intro-login", START_AT_LOGIN_LABEL, options.startAtLogin === true, async (on) => {
        options.startAtLogin = await onStartAtLogin(on);
        redraw();
      }),
    el(
      "div",
      { className: "settings__row" },
      el("button", { type: "button", className: "btn btn--sm btn--primary", onclick: closeDialog }, "Done"),
    ),
  );
}
