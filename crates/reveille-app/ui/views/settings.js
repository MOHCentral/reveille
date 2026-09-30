// SPDX-License-Identifier: GPL-3.0-only

// The Settings panel, drawn in the shared dialog. Every control saves as it changes; there is no
// Apply button to forget. Watched servers are managed in the Watching view, not here.

import { $, el, preserveFocus } from "../lib/dom.js";
import { openDialog } from "../lib/dialog.js";
import { displayPath } from "../lib/format.js";
import { THRESHOLDS } from "../lib/player-alerts.js";
import {
  ALERT_STYLES,
  COOLDOWN_CHOICES,
  PING_FAIR_CHOICES,
  PING_GOOD_CHOICES,
  preferences,
  setPreference,
} from "../lib/preferences.js";
import { GAME_LABELS, state, update } from "../lib/store.js";

export const START_AT_LOGIN_LABEL = "Start Reveille in the background when I sign in";
const ALERT_STYLE_LABELS = {
  system: "System notification (recommended)",
  popup: "Reveille pop-up",
};
const TELEMETRY_LABEL = "Send anonymous usage statistics and crash reports";
const TELEMETRY_SUMMARY =
  "Which steps of finding and joining a server worked, why a join failed, and where Reveille crashed. " +
  "Never your player name, game folder, server passwords, CD key or computer name.";

/**
 * `engine` is the engine's display name; `version` the running build, when known. The callbacks
 * open Setup, the Watching view, the update dialog and a bug report, and tell the shell about the
 * tray setting. `startAtLogin` is whether Reveille starts at sign-in, null when unknown;
 * `onStartAtLogin(on)` changes it and resolves to the answer that holds. `telemetry` is the saved statistics choice; `onTelemetry(shared)` saves a new one
 * and resolves to the status that results. `popupSupported` is whether this desktop can draw the
 * Reveille pop-up; `onTestAlert()` sends a test alert in the chosen style.
 */
export function openSettings(options) {
  const {
    engine,
    version,
    telemetry,
    onChangeInstall,
    onOpenWatching,
    onUpdate,
    onCheckUpdate,
    onReportBug,
    onCloseToTray,
    onStartAtLogin,
    onNotificationSettings,
    onTelemetry,
    onTelemetryDetails,
    onTestAlert,
  } = options;
  const redraw = () => preserveFocus($("#info-dialog-body"), () => openSettings(options));
  const change = (name, value) => {
    setPreference(name, value);
    // Ping colours are drawn in the list, which repaints on a notify.
    update(() => {});
    redraw();
  };
  const prefs = preferences();
  const alertsOff = !prefs.alertsEnabled;

  openDialog(
    "Settings",
    section(
      "Notifications",
      toggle("settings-alerts", "Notify me when players join a watched server", prefs.alertsEnabled, (on) =>
        change("alertsEnabled", on),
      ),
      state.alertError && alertErrorLine(onNotificationSettings),
      options.popupSupported &&
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
      options.popupSupported &&
        prefs.alertStyle === "popup" &&
        el(
          "p",
          { className: "settings__hint" },
          "The pop-up has a Join button and shows even during Do Not Disturb or Focus. " +
            "Turn on \"Don't notify while the game is running\" below to keep it out of your games.",
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
          if (!on && options.startAtLogin) {
            options.startAtLogin = await onStartAtLogin(false);
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
        options.startAtLogin !== null &&
        toggle("settings-login", START_AT_LOGIN_LABEL, options.startAtLogin === true, async (on) => {
          options.startAtLogin = await onStartAtLogin(on);
          redraw();
        }),
      el(
        "button",
        { type: "button", className: "btn btn--sm", onclick: onOpenWatching },
        "Manage watched servers",
      ),
    ),
    section(
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
    ),
    section(
      "Game and engine",
      el(
        "p",
        { className: "settings__value" },
        `${GAME_LABELS[state.game] ?? state.game} · ${engine}`,
      ),
      el("p", { className: "settings__hint data" }, displayPath(state.install?.root ?? "")),
      el(
        "button",
        { type: "button", className: "btn btn--sm", onclick: onChangeInstall },
        "Change folder or engine…",
      ),
    ),
    telemetry?.available &&
      section(
        "Privacy",
        toggle("settings-telemetry", TELEMETRY_LABEL, telemetry.shared === true, async (on) => {
          // Kept on `options` so a later redraw from any other control shows the saved answer.
          options.telemetry = await onTelemetry(on).catch(() => telemetry);
          redraw();
        }),
        el("p", { className: "settings__hint" }, TELEMETRY_SUMMARY),
        el(
          "button",
          { type: "button", className: "btn btn--sm btn--utility", onclick: onTelemetryDetails },
          "What is sent",
        ),
      ),
    section(
      "About",
      el("p", { className: "settings__value" }, version ? `Reveille ${version}` : "Reveille"),
      updateLine(onUpdate, onCheckUpdate, redraw),
      el("p", { className: "settings__hint" }, "Free software under the GNU General Public License, version 3."),
      el("button", { type: "button", className: "btn btn--sm btn--utility", onclick: onReportBug }, "Report a bug"),
    ),
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

function section(title, ...children) {
  return el("section", { className: "settings__section" }, el("h3", { className: "label" }, title), ...children);
}

/** The notification failure, with the way to fix it where the system has a page for it. */
export function alertErrorLine(onNotificationSettings) {
  return el(
    "p",
    { className: "error", role: "alert" },
    `${state.alertError} `,
    el(
      "button",
      { type: "button", className: "btn btn--sm btn--utility", onclick: onNotificationSettings },
      "Open notification settings",
    ),
  );
}

export function toggle(id, label, on, onChange, disabled = false) {
  return el(
    "label",
    { className: "settings__toggle", for: id },
    el("input", {
      id,
      type: "checkbox",
      checked: on,
      disabled,
      dataset: { focusKey: id },
      onchange: (event) => onChange(event.target.checked),
    }),
    el("span", null, label),
  );
}

function choice(id, label, values, current, text, onChange, disabled = false, parse = Number) {
  return el(
    "label",
    { className: "settings__choice", for: id },
    el("span", null, label),
    el(
      "select",
      {
        id,
        disabled,
        dataset: { focusKey: id },
        onchange: (event) => onChange(parse(event.target.value)),
      },
      values.map((value) =>
        el("option", { value: String(value), selected: value === current }, text(value)),
      ),
    ),
  );
}
