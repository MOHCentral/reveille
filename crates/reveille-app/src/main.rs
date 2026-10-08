// SPDX-License-Identifier: GPL-3.0-only

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The boundaries AGENTS.md states, made mechanical (issue #9). `cfg_attr(not(test), …)` rather
// than a bare `deny`: `cargo clippy --all-targets` compiles this crate twice, once plain and once
// with `cfg(test)`. The plain build still denies every production site, so nothing is weakened —
// but unit tests keep `unwrap`/`expect` with explicit messages, in one line here instead of an
// `#[allow]` on every `mod tests`. Integration tests are separate crates and are untouched.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::dbg_macro,
        clippy::todo,
        clippy::unimplemented,
        clippy::print_stdout,
        clippy::print_stderr,
    )
)]

//! Tauri shell. This layer owns presentation policy: it turns the pipeline's typed results into
//! payloads and progress events, and decides nothing the core has not already established.

mod alerts;
#[cfg(windows)]
mod app_icon;
mod autostart;
#[cfg(test)]
mod catalog_contract;
mod catalogue;
#[cfg(test)]
mod command_acl;
mod engines;
mod installation;
mod join;
mod logs;
mod notice;
mod popup;
mod self_update;
mod servers;
mod session;
mod telemetry;
mod tray;

use tauri::Manager;

fn main() {
    // The one exemption to the crate's `expect_used` deny, and the narrowest form of it: a
    // statement attribute on the last statement of an executable `main`, where a failed Tauri run
    // has no caller to return to and no window in which to report anything. AGENTS.md names this
    // boundary; this is it.
    //
    // `#[allow]`, not `#[expect]`. Under `cfg(test)` the lint is not enabled, so the expectation
    // would go unfulfilled and `unfulfilled_lint_expectations` — a warning, and `-D warnings` is
    // the gate — would fail the build.
    #[allow(
        clippy::expect_used,
        reason = "executable main boundary: a failed run has no caller to return to"
    )]
    tauri::Builder::default()
        // First, so a second launch hands over before any other plugin starts. Clicking a Windows
        // toast launches Reveille again, which is how a hidden window comes back.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == autostart::BACKGROUND_ARG) {
                tray::show_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(self_update::PUBLIC_KEY)
                .build(),
        )
        .setup(|app| {
            logs::init(app);
            app.manage(telemetry::commands::init_telemetry(app));
            app.manage(tray::TrayState::default());
            app.manage(popup::PopupState::default());
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(app_icon::window(window.scale_factor()?))?;
            }
            if autostart::in_background() {
                tray::start_hidden(app.handle());
            }
            installation::register(app);
            engines::register(app);
            servers::register(app);
            join::register(app);
            catalogue::register(app);
            self_update::register(app);
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            // installation
            installation::detect_install,
            installation::identify_install,
            installation::pick_install_folder,
            installation::copy::installation_storage,
            installation::copy::pick_copy_destination,
            installation::copy::copy_game_installation,
            installation::copy::cancel_game_installation_copy,
            // engines
            engines::engine_overview,
            engines::select_engine,
            engines::reborn::install_reborn,
            engines::reborn::cancel_reborn_install,
            engines::openmohaa::openmohaa_status,
            engines::openmohaa::install_openmohaa,
            engines::openmohaa::cancel_openmohaa_install,
            // servers
            servers::browse::browse_servers,
            servers::browse::cancel_browse,
            servers::check::check_server,
            // join
            join::preview_join,
            join::content::install_server_files,
            join::install_and_launch,
            // catalogue
            catalogue::browse_catalogue,
            catalogue::catalogue_image,
            catalogue::install_catalogue_item,
            catalogue::cancel_catalogue_install,
            // alerts
            alerts::read_watched_server,
            alerts::game_client_running,
            // notifications and the alert popup
            notice::send_player_notification,
            notice::send_reveille_notice,
            notice::open_notification_settings,
            popup::popup_supported,
            popup::show_alert_popup,
            popup::alert_popup_ready,
            popup::fit_alert_popup,
            popup::alert_popup_action,
            // shell
            autostart::start_at_login,
            autostart::set_start_at_login,
            tray::set_close_to_tray,
            tray::set_tray_tooltip,
            self_update::check_reveille_update,
            self_update::install_reveille_update,
            self_update::cancel_reveille_update,
            logs::app_log_files,
            telemetry::commands::telemetry_status,
            telemetry::commands::set_telemetry_shared,
            telemetry::commands::track_event
        ])
        .run(context())
        .expect("error while running Reveille");
}

/// The one expansion of `generate_context!`: on macOS each one defines the same Info.plist
/// symbol, so the ACL tests read their context from here too.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    /// Every event the shell emits. The frontend subscribes by name, so two slices sharing one
    /// would each receive the other's payloads.
    const EVENTS: [&str; 10] = [
        crate::installation::copy::EVENT,
        crate::engines::reborn::EVENT,
        crate::engines::openmohaa::EVENT,
        crate::join::content::EVENT,
        crate::notice::PLAYER_ALERT_OPEN_EVENT,
        crate::popup::CARD_EVENT,
        crate::popup::SNOOZE_EVENT,
        crate::popup::MORE_EVENT,
        crate::tray::HIDDEN_EVENT,
        crate::self_update::EVENT,
    ];

    #[test]
    fn every_event_name_is_unique_and_namespaced() {
        let mut seen = HashSet::new();
        for event in EVENTS {
            assert!(
                event.starts_with("reveille://"),
                "{event} is not namespaced"
            );
            assert!(seen.insert(event), "{event} is emitted by two slices");
        }
    }
}
