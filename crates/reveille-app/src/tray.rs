// SPDX-License-Identifier: GPL-3.0-only

//! Close-to-tray, so watched servers keep being polled with the window closed.
//!
//! The monitor lives in the webview, so "closed" means hidden: the window and its timers stay
//! alive and only the notification-area icon remains on screen.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter as _, Manager as _, Runtime, Window, WindowEvent};

const OPEN_ID: &str = "tray-open";
const HIDDEN_EVENT: &str = "reveille://hidden-to-tray";
const QUIT_ID: &str = "tray-quit";

#[derive(Default)]
pub struct TrayState {
    close_to_tray: AtomicBool,
    icon: Mutex<Option<TrayIcon>>,
}

/// Turn close-to-tray on or off. The icon is built the first time it is needed and only hidden
/// afterwards, so a player who never opts in never sees one.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri passes the app handle to commands only by value"
)]
pub fn set_close_to_tray(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<TrayState>();
    state.close_to_tray.store(enabled, Ordering::SeqCst);
    let mut icon = state
        .icon
        .lock()
        .map_err(|_| "Reveille's tray state is unavailable".to_owned())?;
    match (icon.as_ref(), enabled) {
        (Some(existing), _) => existing
            .set_visible(enabled)
            .map_err(|error| error.to_string()),
        (None, true) => {
            *icon = Some(build(&app).map_err(|error| error.to_string())?);
            Ok(())
        }
        (None, false) => Ok(()),
    }
}

/// Hide instead of closing while close-to-tray is on.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if !window
        .state::<TrayState>()
        .close_to_tray
        .load(Ordering::SeqCst)
    {
        return;
    }
    api.prevent_close();
    let _ = window.hide();
    // The page decides whether this is the first time and the player should be told.
    let _ = window.emit(HIDDEN_EVENT, ());
}

/// What hovering the tray icon says: how many servers are watched and how many alerts are unread.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri passes the app handle to commands only by value"
)]
pub fn set_tray_tooltip(app: AppHandle, text: String) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 128 {
        return Err("Invalid tray tooltip".into());
    }
    let state = app.state::<TrayState>();
    let icon = state
        .icon
        .lock()
        .map_err(|_| "Reveille's tray state is unavailable".to_owned())?;
    match icon.as_ref() {
        Some(existing) => existing
            .set_tooltip(Some(text))
            .map_err(|error| error.to_string()),
        None => Ok(()),
    }
}

/// Start with only the tray icon on screen, for a launch at sign-in.
pub fn start_hidden(app: &AppHandle) {
    if set_close_to_tray(app.clone(), true).is_err() {
        // Without an icon a hidden window could not be brought back.
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Bring the main window back, from the tray or from a second launch.
pub fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let open = MenuItem::with_id(app, OPEN_ID, "Open Reveille", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Reveille", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Reveille is watching your servers")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_ID => show_main(app),
            QUIT_ID => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)
}
