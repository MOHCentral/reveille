// SPDX-License-Identifier: GPL-3.0-only

//! The Reveille pop-up: an opt-in alert style drawn in a small window of its own, in the corner of
//! the screen the pointer is on, with Join right on it.
//!
//! The window never takes focus, so a pop-up arriving mid-sentence does not swallow keystrokes.
//! It is created on the first alert and kept hidden between batches. Where a window cannot place
//! itself or stay on top — Wayland — the caller falls back to a system notification.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter as _, LogicalSize, Manager as _, PhysicalPosition, Runtime, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

use crate::{notice, tray};

const LABEL: &str = "alert-popup";
pub const CARD_EVENT: &str = "reveille://popup-card";
pub const SNOOZE_EVENT: &str = "reveille://popup-snooze";
pub const MORE_EVENT: &str = "reveille://popup-more";
const WIDTH: f64 = 360.0;
const MARGIN: f64 = 16.0;

#[derive(Default)]
pub struct PopupState {
    ready: AtomicBool,
    /// Whether the batch now on screen has played its sound. The window only shows once the page
    /// has measured its cards, so visibility cannot tell a new batch from one being drawn.
    sounded: AtomicBool,
    pending: Mutex<Vec<Card>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    event_id: String,
    game: String,
    address: String,
    hostname: String,
    count: u32,
    /// Replaces the player count as the headline: the test alert names no server.
    title: Option<String>,
    detail: Option<String>,
    /// Set here, never by the caller: whether the page plays Reveille's chime with this card.
    #[serde(default, skip_deserializing)]
    chime: bool,
}

/// Whether this desktop lets a window choose its place and stay above others.
#[tauri::command]
pub fn popup_supported() -> bool {
    #[cfg(target_os = "linux")]
    {
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE").is_ok_and(|kind| kind == "wayland");
        let forced_x11 = std::env::var("GDK_BACKEND").is_ok_and(|backend| backend == "x11");
        !wayland || forced_x11
    }
    #[cfg(not(target_os = "linux"))]
    true
}

/// Show one alert as a pop-up. Resolves to false when this desktop cannot, so the caller sends a
/// system notification instead.
///
/// Async because building a window from a synchronous command deadlocks the event loop on
/// Windows (docs.rs/tauri `WebviewWindowBuilder::new`).
#[tauri::command]
pub async fn show_alert_popup(app: AppHandle, mut card: Card, sound: bool) -> Result<bool, String> {
    if card.event_id.is_empty()
        || card.event_id.len() > 64
        || card.hostname.len() > 256
        || card.address.len() > 64
        || card.game.len() > 32
        || card.count == 0
        || card.title.as_ref().is_some_and(|title| title.len() > 256)
        || card
            .detail
            .as_ref()
            .is_some_and(|detail| detail.len() > 256)
    {
        return Err("Invalid pop-up".into());
    }
    if !popup_supported() {
        return Ok(false);
    }
    let window = match app.get_webview_window(LABEL) {
        Some(window) => window,
        None => build(&app).map_err(|error| {
            tracing::warn!(%error, "could not create the alert pop-up window");
            error.to_string()
        })?,
    };
    tracing::debug!(event_id = %card.event_id, sound, "showing an alert pop-up");
    let state = app.state::<PopupState>();
    // One sound per batch: a card joining pop-ups already on screen stays quiet.
    card.chime = sound && !state.sounded.swap(true, Ordering::SeqCst);
    // `ready` is read under the queue's lock, so a card cannot be queued after the page drained it.
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "Reveille's pop-up state is unavailable".to_owned())?;
    if state.ready.load(Ordering::SeqCst) {
        drop(pending);
        window
            .emit_to(LABEL, CARD_EVENT, card)
            .map_err(|error| error.to_string())?;
    } else {
        pending.push(card);
    }
    Ok(true)
}

/// The pop-up page has loaded: hand it whatever arrived before it could listen.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri passes the app handle to commands only by value"
)]
pub fn alert_popup_ready(app: AppHandle) -> Result<Vec<Card>, String> {
    let state = app.state::<PopupState>();
    let mut pending = state
        .pending
        .lock()
        .map_err(|_| "Reveille's pop-up state is unavailable".to_owned())?;
    state.ready.store(true, Ordering::SeqCst);
    Ok(std::mem::take(&mut *pending))
}

/// Fit the window to its cards and place it in the corner of the screen the pointer is on, or
/// hide it when no card is left.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri passes the app handle to commands only by value"
)]
pub fn fit_alert_popup(app: AppHandle, height: f64) -> Result<(), String> {
    let Some(window) = app.get_webview_window(LABEL) else {
        return Ok(());
    };
    if !height.is_finite() || height <= 0.0 {
        app.state::<PopupState>()
            .sounded
            .store(false, Ordering::SeqCst);
        return window.hide().map_err(|error| error.to_string());
    }
    let height = height.min(720.0);
    window
        .set_size(LogicalSize::new(WIDTH, height))
        .map_err(|error| error.to_string())?;
    place(&app, &window, height).map_err(|error| error.to_string())?;
    if !window.is_visible().unwrap_or(false) {
        window.show().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// A button on a card. Open and Join go to the main window, as a click on a notification does;
/// "+N more" opens the bell there.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri passes the app handle to commands only by value"
)]
pub fn alert_popup_action(app: AppHandle, action: String, event_id: String) -> Result<(), String> {
    match action.as_str() {
        "open" => notice::opened(&app, event_id, false),
        "join" => notice::opened(&app, event_id, true),
        "snooze" => {
            let _ = app.emit_to("main", SNOOZE_EVENT, ());
        }
        "more" => {
            tray::show_main(&app);
            let _ = app.emit_to("main", MORE_EVENT, ());
        }
        _ => return Err("Unknown pop-up action".into()),
    }
    Ok(())
}

/// Close the pop-up window with the main one, so the app can exit.
pub fn close<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(LABEL) {
        let _ = window.destroy();
    }
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("popup.html".into()))
        .title("Reveille alert")
        .inner_size(WIDTH, 120.0)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .focusable(false)
        .shadow(true)
        .visible(false)
        .build()
}

/// Bottom right, clear of the taskbar; top right on macOS, where notifications live.
fn place(app: &AppHandle, window: &WebviewWindow, height: f64) -> tauri::Result<()> {
    let monitor = match app.cursor_position() {
        Ok(cursor) => app.monitor_from_point(cursor.x, cursor.y)?,
        Err(_) => None,
    };
    let Some(monitor) = monitor.or(app.primary_monitor()?) else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width = to_physical(WIDTH, scale);
    let margin = to_physical(MARGIN, scale);
    let x = area.position.x + physical_extent(area.size.width) - width - margin;
    let y = if cfg!(target_os = "macos") {
        area.position.y + margin
    } else {
        area.position.y + physical_extent(area.size.height) - to_physical(height, scale) - margin
    };
    window.set_position(PhysicalPosition::new(x, y))
}

#[expect(
    clippy::cast_possible_truncation,
    reason = "window sizes are a few hundred pixels, far inside i32"
)]
fn to_physical(logical: f64, scale: f64) -> i32 {
    (logical * scale).round() as i32
}

fn physical_extent(extent: u32) -> i32 {
    i32::try_from(extent).unwrap_or(i32::MAX)
}
