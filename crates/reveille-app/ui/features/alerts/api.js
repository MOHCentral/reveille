// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/alerts/, notice.rs, popup.rs and tray.rs.

import { clearAttention, focusWindow, invoke, listen, requestAttention } from "../../lib/bridge.js";

/**
 * One watched server's figures. `readWatchedServer` resolves null when it did not answer.
 *
 * @typedef {object} WatchReading
 * @property {number | null} clients
 * @property {number | null} bots
 * @property {string | null} map
 * @property {string | null} mode
 * @property {number} round_trip
 */

/**
 * What the pop-up window shows. `title` replaces the player count as the headline, for the test
 * alert that names no server. `chime` is set by Rust on the cards the pop-up receives, never by
 * the caller.
 *
 * @typedef {object} AlertCard
 * @property {string} eventId
 * @property {string} game
 * @property {string} address
 * @property {string} hostname
 * @property {number} count
 * @property {string | null} [title]
 * @property {string | null} [detail]
 * @property {boolean} [chime]
 */

/** @typedef {{ eventId: string, join: boolean }} PlayerAlertOpen */

/**
 * @param {{ address: string, queryPort: number, game: import("../../lib/catalog.js").GameId }} server
 * @returns {Promise<WatchReading | null>}
 */
export const readWatchedServer = ({ address, queryPort, game }) =>
  invoke("read_watched_server", { address, queryPort, game });

/** @returns {Promise<boolean | null>} Null when Reveille cannot tell. */
export const gameClientRunning = () => invoke("game_client_running");

/** @returns {Promise<void>} */
export const setTrayTooltip = (text) => invoke("set_tray_tooltip", { text });

export const onHiddenToTray = (handler) => listen("reveille://hidden-to-tray", handler);

/** @param {(open: PlayerAlertOpen) => void} handler */
export const onPlayerNotificationClick = (handler) =>
  listen("reveille://player-alert-open", handler);

export const focusReveille = focusWindow;

export const requestPlayerAlertAttention = requestAttention;

export const clearPlayerAlertAttention = clearAttention;

/**
 * @param {{ id: string, hostname: string, count: number, detail?: string | null }} event
 * @param {boolean} sound
 * @returns {Promise<void>}
 */
export const sendPlayerNotification = (event, sound) =>
  invoke("send_player_notification", {
    eventId: event.id,
    hostname: event.hostname,
    count: event.count,
    detail: event.detail ?? null,
    sound,
  });

/**
 * @param {{ title: string, body: string }} notice
 * @param {boolean} sound
 * @returns {Promise<void>}
 */
export const sendReveilleNotice = ({ title, body }, sound) =>
  invoke("send_reveille_notice", { title, body, sound });

export const openNotificationSettings = () => invoke("open_notification_settings");

/** @returns {Promise<boolean>} */
export const popupSupported = () => invoke("popup_supported");

/**
 * @param {AlertCard} card
 * @param {boolean} sound
 * @returns {Promise<boolean>} False where the desktop cannot draw a pop-up.
 */
export const showAlertPopup = (card, sound) => invoke("show_alert_popup", { card, sound });

export const onPopupSnooze = (handler) => listen("reveille://popup-snooze", handler);
export const onPopupMore = (handler) => listen("reveille://popup-more", handler);

/* The pop-up window's own side of the conversation. */

/** @param {(card: AlertCard) => void} handler */
export const onPopupCard = (handler) => listen("reveille://popup-card", handler);

/** @returns {Promise<AlertCard[]>} The cards queued before the pop-up listened. */
export const alertPopupReady = () => invoke("alert_popup_ready");

/**
 * @param {"open" | "join" | "snooze" | "more"} action
 * @param {string} eventId
 * @returns {Promise<void>}
 */
export const alertPopupAction = (action, eventId) =>
  invoke("alert_popup_action", { action, eventId });

/**
 * @param {number} height 0 hides the pop-up.
 * @returns {Promise<void>}
 */
export const fitAlertPopup = (height) => invoke("fit_alert_popup", { height });
