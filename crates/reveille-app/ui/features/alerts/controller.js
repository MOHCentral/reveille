// SPDX-License-Identifier: GPL-3.0-only

// Player alerts at run time: the monitor, delivering what it finds, watching and unwatching a
// server, and keeping Reveille in the notification area while anything is watched.

import { $, el } from "../../lib/dom.js";
import { openDialog } from "../../lib/dialog.js";
import { popoverAnchor } from "../../lib/popover.js";
import { preferences, setPreference } from "../../lib/preferences.js";
import { state, subscribe, update } from "../../lib/store.js";
import {
  clearPlayerAlertAttention,
  gameClientRunning,
  onHiddenToTray,
  onPlayerNotificationClick,
  onPopupMore,
  onPopupSnooze,
  openNotificationSettings,
  popupSupported,
  readWatchedServer,
  requestPlayerAlertAttention,
  sendPlayerNotification,
  sendReveilleNotice,
  setTrayTooltip,
  showAlertPopup,
} from "./api.js";
import { arrivalById, recordArrival, unreadArrivalCount } from "./arrival-events.js";
import { arrivalTarget, bell } from "./bell.js";
import { alertDetail } from "./format.js";
import { openAlertsIntro } from "./intro.js";
import { startPlayerAlertMonitor } from "./monitor.js";
import { addPlayerAlert, alertId, hasPlayerAlert, playerAlerts, removePlayerAlert } from "./player-alerts.js";
import { catchUpNotice, hiddenNotice, needsBackgroundWatching, trayTooltip } from "./reach.js";
import { setCloseToTray, startAtLogin } from "../settings/index.js";

// Snoozed from a pop-up: arrivals still reach the bell, without a pop-up or notification.
const SNOOZE_MS = 60 * 60_000;

const TEST_ALERT = {
  title: "Test alert from Reveille",
  body: "This is how an alert looks when players join a server you watch.",
};

/**
 * `onOpenWatching()` shows the Watching scope; `changeStartAtLogin(enabled)` resolves to whether
 * Reveille now starts at sign-in. Nothing starts until `start(intents)`.
 */
export function playerAlertsController({ onOpenWatching, changeStartAtLogin }) {
  let shownTooltip = null;
  let heldWhilePlaying = [];
  let gameWatch = null;
  let attentionRequested = false;
  let snoozedUntil = 0;
  let popupAvailable = Promise.resolve(false);
  let alertMonitor = null;

  const titlebarBell = bell({
    onOpenWatching,
    onNotificationSettings: openSystemNotificationSettings,
    onBadge: renderTrayTooltip,
  });

  function start(intents) {
    titlebarBell.mount(intents);
    subscribe(titlebarBell.renderArrivalBadge);
    window.addEventListener("focus", () => {
      attentionRequested = false;
      // Seen under the bell now, so the after-game summary would only repeat it.
      heldWhilePlaying = [];
      void clearPlayerAlertAttention().catch(() => {});
    });
    void onPlayerNotificationClick(({ eventId, join }) => {
      const event = arrivalById(eventId);
      if (event) intents.openServer({ ...arrivalTarget(event), join: join === true });
    });
    void onPopupSnooze(() => {
      snoozedUntil = Date.now() + SNOOZE_MS;
    });
    void onPopupMore(() => {
      if (popoverAnchor() !== $("#arrival-events-btn")) titlebarBell.toggleArrivals();
    });
    popupAvailable = popupSupported().catch(() => false);
    void onHiddenToTray(() => {
      if (preferences().trayNoticeShown) return;
      setPreference("trayNoticeShown", true);
      void sendReveilleNotice(hiddenNotice(playerAlerts().length), false).catch(() => {});
    });
    alertMonitor = startPlayerAlertMonitor(
      readWatchedServer,
      deliverArrival,
      (id, reading) => update((next) => next.watchReadings.set(id, reading)),
      () => preferences().cooldownMinutes * 60_000,
    );
  }

  async function deliverArrival(entry, count, reading, { toast = true } = {}) {
    if (!preferences().alertsEnabled) return;
    const event = recordArrival(entry, count, Date.now(), alertDetail(reading));
    titlebarBell.renderArrivalBadge();
    // Inside the cooldown the arrival still reaches the bell; only the interruption waits.
    if (!toast) return;
    if (snoozedUntil > Date.now()) return;
    // Kept under the bell, but no toast and no flashing taskbar over a game in progress.
    if (preferences().quietWhilePlaying && (await gameClientRunning().catch(() => null)) === true) {
      if (event) holdUntilGameCloses(event);
      return;
    }
    if (!document.hasFocus() && !attentionRequested) {
      attentionRequested = true;
      void requestPlayerAlertAttention().catch(() => { attentionRequested = false; });
    }
    try {
      if (event && !(await showPopup(popupCard(event)))) {
        await sendPlayerNotification(event, preferences().alertSound);
      }
      if (state.alertError) update((next) => (next.alertError = null));
    } catch {
      update((next) => (next.alertError = "Reveille could not show a system notification."));
    }
  }

  /**
   * Resolves to whether the alert went out as a Reveille pop-up. False when the player chose system
   * notifications or this desktop cannot draw one, so the caller sends a notification instead.
   */
  async function showPopup(card) {
    if (preferences().alertStyle !== "popup" || !(await popupAvailable)) return false;
    return showAlertPopup(card, preferences().alertSound).catch(() => false);
  }

  function popupCard(event) {
    return {
      eventId: event.id,
      game: event.game,
      address: event.address,
      hostname: event.hostname,
      count: event.count,
      title: null,
      detail: event.detail ?? null,
    };
  }

  /** Resolves to whether the test went out as a pop-up rather than a system notification. */
  async function sendTestAlert() {
    const card = {
      eventId: `test-${Date.now()}`,
      game: state.game ?? "",
      address: "",
      hostname: "",
      count: 1,
      title: TEST_ALERT.title,
      detail: TEST_ALERT.body,
    };
    if (await showPopup(card)) return true;
    await sendReveilleNotice(TEST_ALERT, preferences().alertSound);
    return false;
  }

  /** Arrivals a game kept quiet, summed up in one notice once it closes. */
  function holdUntilGameCloses(event) {
    heldWhilePlaying.push(event);
    gameWatch ??= setInterval(async () => {
      if ((await gameClientRunning().catch(() => null)) !== false) return;
      clearInterval(gameWatch);
      gameWatch = null;
      const notice = catchUpNotice(heldWhilePlaying);
      heldWhilePlaying = [];
      if (!notice || document.hasFocus()) return;
      try {
        await sendReveilleNotice(notice, preferences().alertSound);
      } catch {
        update((next) => (next.alertError = "Reveille could not show a system notification."));
      }
    }, 30_000);
  }

  function forgetWatch(game, address) {
    removePlayerAlert(game, address);
    alertMonitor.forget(game, address);
    update((next) => next.watchReadings.delete(alertId({ game, address })));
  }

  async function togglePlayerAlert(row) {
    const game = state.game;
    if (hasPlayerAlert(game, row.address)) {
      forgetWatch(game, row.address);
      return;
    }
    if (!addPlayerAlert(row, game, preferences().defaultThreshold)) {
      openDialog("Player alerts", el("p", null,
        "Reveille could not save this server's alert. Try again after restarting the app."));
      return;
    }
    keepWatchingInBackground();
    update(() => {});
    alertMonitor.checkNow();
    if (!preferences().alertsIntroShown) {
      setPreference("alertsIntroShown", true);
      openAlertsIntro({
        startAtLogin: await startAtLogin().catch(() => null),
        onTest: sendTestAlert,
        onCloseToTray: syncCloseToTray,
        onStartAtLogin: changeStartAtLogin,
        onNotificationSettings: openSystemNotificationSettings,
      });
    }
  }

  function keepWatchingInBackground() {
    if (!needsBackgroundWatching(preferences(), playerAlerts().length)) return;
    setPreference("closeToTray", true);
    syncCloseToTray(true);
  }

  function openSystemNotificationSettings() {
    openNotificationSettings().catch(() => {
      openDialog("Notification settings", el("p", null,
        "Open your system's notification settings and allow notifications for Reveille."));
    });
  }

  function syncCloseToTray(enabled) {
    // A new icon starts with the default text.
    shownTooltip = null;
    setCloseToTray(enabled).then(renderTrayTooltip, () => {
      openDialog("Keep watching", el("p", null,
        "Reveille could not add its notification-area icon, so closing the window still quits it."));
      setPreference("closeToTray", false);
    });
  }

  function renderTrayTooltip() {
    if (!preferences().closeToTray) return;
    const text = trayTooltip(playerAlerts().length, unreadArrivalCount());
    if (text === shownTooltip) return;
    shownTooltip = text;
    void setTrayTooltip(text).catch(() => (shownTooltip = null));
  }

  return {
    start,
    togglePlayerAlert,
    keepWatchingInBackground,
    syncCloseToTray,
    sendTestAlert,
    openSystemNotificationSettings,
    popupAvailable: () => popupAvailable,
  };
}
