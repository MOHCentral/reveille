// SPDX-License-Identifier: GPL-3.0-only

//! System notifications: player alerts, and Reveille's own notices such as the test alert.
//!
//! A player alert carries its arrival's id, so clicking it — or its Join button, where the platform
//! draws one — opens that server rather than only bringing the window back.

use serde::Serialize;
use tauri::{AppHandle, Emitter as _};

use crate::tray;

const PLAYER_ALERT_OPEN_EVENT: &str = "reveille://player-alert-open";
const JOIN_ACTION: &str = "join";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerAlertOpen {
    event_id: String,
    join: bool,
}

struct Notice {
    title: String,
    body: String,
    sound: bool,
    alert: Option<String>,
}

#[tauri::command]
pub async fn send_player_notification(
    app: AppHandle,
    event_id: String,
    hostname: String,
    count: u32,
    detail: Option<String>,
    sound: bool,
) -> Result<(), String> {
    let detail = detail.filter(|detail| !detail.trim().is_empty());
    if event_id.len() > 64
        || event_id.is_empty()
        || count == 0
        || hostname.len() > 256
        || detail.as_ref().is_some_and(|detail| detail.len() > 256)
    {
        return Err("Invalid player alert".into());
    }
    let title = format!(
        "{count} {} on {hostname}",
        if count == 1 { "player" } else { "players" }
    );
    let body = detail.unwrap_or_else(|| "A server you follow is no longer empty.".into());
    show(
        app,
        Notice {
            title,
            body,
            sound,
            alert: Some(event_id),
        },
    )
    .await
}

/// A notice that is not about one arrival: the test alert, the first close to the tray, a
/// catch-up summary. Clicking it only brings the window back.
#[tauri::command]
pub async fn send_reveille_notice(
    app: AppHandle,
    title: String,
    body: String,
    sound: bool,
) -> Result<(), String> {
    if title.trim().is_empty() || title.len() > 256 || body.len() > 512 {
        return Err("Invalid notice".into());
    }
    show(
        app,
        Notice {
            title,
            body,
            sound,
            alert: None,
        },
    )
    .await
}

/// Open the system page where notifications are allowed or blocked for Reveille, where the
/// platform has one to link to.
#[tauri::command]
pub fn open_notification_settings() -> Result<(), String> {
    #[cfg(windows)]
    let target = "ms-settings:notifications";
    #[cfg(target_os = "macos")]
    let target = "x-apple.systempreferences:com.apple.preference.notifications";
    #[cfg(not(any(windows, target_os = "macos")))]
    return Err("This system has no single notification settings page to open".into());
    #[cfg(any(windows, target_os = "macos"))]
    tauri_plugin_opener::open_url(target, None::<&str>).map_err(|error| error.to_string())
}

pub fn opened(app: &AppHandle, event_id: String, join: bool) {
    tray::show_main(app);
    let _ = app.emit(PLAYER_ALERT_OPEN_EVENT, PlayerAlertOpen { event_id, join });
}

#[cfg(windows)]
async fn show(app: AppHandle, notice: Notice) -> Result<(), String> {
    use tauri_winrt_notification::{Sound, Toast};

    tokio::task::spawn_blocking(move || {
        let mut toast = Toast::new(&app_user_model_id(&app))
            .title(&notice.title)
            .text1(&notice.body)
            // Without a sound the toast is silent. "IM" is Windows' own chat-message sound, so it
            // follows the player's sound scheme, volume and Do Not Disturb.
            .sound(notice.sound.then_some(Sound::IM));
        let handle = app.clone();
        toast = match notice.alert {
            Some(event_id) => toast
                .add_button("Join", JOIN_ACTION)
                .on_activated(move |action| {
                    opened(
                        &handle,
                        event_id.clone(),
                        action.as_deref() == Some(JOIN_ACTION),
                    );
                    Ok(())
                }),
            None => toast.on_activated(move |_| {
                tray::show_main(&handle);
                Ok(())
            }),
        };
        toast.show().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The identity Windows files the toast under. The installer registers the app's identifier on
/// its shortcut; a build run straight from `target` has no shortcut, so it borrows PowerShell's,
/// as the notification plugin does.
#[cfg(windows)]
fn app_user_model_id(app: &AppHandle) -> String {
    let unpackaged = std::env::current_exe().is_ok_and(|exe| {
        exe.parent().is_some_and(|dir| {
            dir.ends_with(std::path::Path::new("target").join("debug"))
                || dir.ends_with(std::path::Path::new("target").join("release"))
        })
    });
    if unpackaged {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_owned()
    } else {
        app.config().identifier.clone()
    }
}

#[cfg(not(windows))]
async fn show(app: AppHandle, notice: Notice) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut notification = notify_rust::Notification::new();
        notification
            .summary(&notice.title)
            .body(&notice.body)
            .auto_icon();
        if notice.sound {
            notification.sound_name(if cfg!(target_os = "macos") {
                "default"
            } else {
                "message-new-instant"
            });
        }
        if notice.alert.is_some() && cfg!(not(target_os = "macos")) {
            notification
                .action("default", "Open")
                .action(JOIN_ACTION, "Join");
        }
        #[cfg(target_os = "macos")]
        {
            let _ = notify_rust::set_application(if tauri::is_dev() {
                "com.apple.Terminal"
            } else {
                &app.config().identifier
            });
        }
        let handle = notification.show().map_err(|error| error.to_string())?;
        std::thread::spawn(move || {
            let _ = handle.wait_for_response(|response: &notify_rust::NotificationResponse| {
                let join = match response {
                    notify_rust::NotificationResponse::Default => false,
                    notify_rust::NotificationResponse::Action(action) if action == "default" => {
                        false
                    }
                    notify_rust::NotificationResponse::Action(action) if action == JOIN_ACTION => {
                        true
                    }
                    _ => return,
                };
                match notice.alert.clone() {
                    Some(event_id) => opened(&app, event_id, join),
                    None => tray::show_main(&app),
                }
            });
        });
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}
