// SPDX-License-Identifier: GPL-3.0-only

// The Settings panel, drawn in the shared dialog. Every control saves as it changes; there is no
// Apply button to forget. Watched servers are managed in the Watching view, not here.

import { $, el, preserveFocus } from "../lib/dom.js";
import { openDialog } from "../lib/dialog.js";
import { displayPath } from "../lib/format.js";
import { THRESHOLDS } from "../lib/player-alerts.js";
import {
  COOLDOWN_CHOICES,
  PING_FAIR_CHOICES,
  PING_GOOD_CHOICES,
  preferences,
  setPreference,
} from "../lib/preferences.js";
import { GAME_LABELS, state, update } from "../lib/store.js";

/**
 * `engine` is the engine's display name; `version` the running build, when known. The callbacks
 * open Setup, the Watching view, the update dialog and a bug report, and tell the shell about the
 * tray setting.
 */
export function openSettings(options) {
  const { engine, version, onChangeInstall, onOpenWatching, onUpdate, onCheckUpdate, onReportBug, onCloseToTray } =
    options;
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
      state.alertError && el("p", { className: "error", role: "alert" }, state.alertError),
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
        (on) => {
          change("closeToTray", on);
          onCloseToTray(on);
        },
      ),
      prefs.closeToTray &&
        el(
          "p",
          { className: "settings__hint" },
          "Closing the window leaves Reveille in the notification area. Right-click its icon to quit.",
        ),
      el(
        "p",
        { className: "settings__hint" },
        "Bots are never counted. Alerts that arrive while you play still appear under the bell.",
      ),
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

function toggle(id, label, on, onChange, disabled = false) {
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

function choice(id, label, values, current, text, onChange, disabled = false) {
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
        onchange: (event) => onChange(Number(event.target.value)),
      },
      values.map((value) =>
        el("option", { value: String(value), selected: value === current }, text(value)),
      ),
    ),
  );
}
