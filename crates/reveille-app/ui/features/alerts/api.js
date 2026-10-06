// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/main.rs and popup.rs):
//   read_watched_server(address, queryPort, game) -> { clients, bots, map, mode, round_trip } | null
//   game_client_running()                      -> boolean | null
//   popup_supported()                          -> boolean
//   show_alert_popup(card, sound)              -> boolean; false where the desktop cannot draw one
//   alert_popup_ready()                        -> the cards queued before the pop-up listened
//   alert_popup_action(action, eventId)        -> void
//   fit_alert_popup(height)                    -> void; 0 hides the pop-up

import { clearAttention, focusWindow, invoke, listen, requestAttention } from "../../lib/bridge.js";

export const readWatchedServer = ({ address, queryPort, game }) =>
  invoke("read_watched_server", { address, queryPort, game });

export const gameClientRunning = () => invoke("game_client_running");

export const setTrayTooltip = (text) => invoke("set_tray_tooltip", { text });

export const onHiddenToTray = (handler) => listen("reveille://hidden-to-tray", handler);

export const onPlayerNotificationClick = (handler) =>
  listen("reveille://player-alert-open", handler);

export const focusReveille = focusWindow;

export const requestPlayerAlertAttention = requestAttention;

export const clearPlayerAlertAttention = clearAttention;

export const sendPlayerNotification = (event, sound) =>
  invoke("send_player_notification", {
    eventId: event.id,
    hostname: event.hostname,
    count: event.count,
    detail: event.detail ?? null,
    sound,
  });

export const sendReveilleNotice = ({ title, body }, sound) =>
  invoke("send_reveille_notice", { title, body, sound });

export const openNotificationSettings = () => invoke("open_notification_settings");

export const popupSupported = () => invoke("popup_supported");

/** `card` is `{ eventId, game, address, hostname, count, title, detail }`. */
export const showAlertPopup = (card, sound) => invoke("show_alert_popup", { card, sound });

export const onPopupSnooze = (handler) => listen("reveille://popup-snooze", handler);
export const onPopupMore = (handler) => listen("reveille://popup-more", handler);

/* The pop-up window's own side of the conversation. */

export const onPopupCard = (handler) => listen("reveille://popup-card", handler);

export const alertPopupReady = () => invoke("alert_popup_ready");

export const alertPopupAction = (action, eventId) =>
  invoke("alert_popup_action", { action, eventId });

export const fitAlertPopup = (height) => invoke("fit_alert_popup", { height });
