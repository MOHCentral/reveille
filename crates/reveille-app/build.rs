// SPDX-License-Identifier: GPL-3.0-only

use tauri_build::{AppManifest, Attributes};

/// Every command in `main.rs`'s `generate_handler!`. Once this list is non-empty Tauri denies any
/// app command no capability grants, including one registered there but missing here, so the two
/// lists change together; `permissions/*.toml` group these into the sets `capabilities/` grant.
const COMMANDS: &[&str] = &[
    // installation
    "detect_install",
    "identify_install",
    "pick_install_folder",
    "installation_storage",
    "pick_copy_destination",
    "copy_game_installation",
    "cancel_game_installation_copy",
    // engines
    "engine_overview",
    "select_engine",
    "install_reborn",
    "cancel_reborn_install",
    "openmohaa_status",
    "install_openmohaa",
    "cancel_openmohaa_install",
    // servers
    "browse_servers",
    "cancel_browse",
    "check_server",
    // join
    "preview_join",
    "install_server_files",
    "install_and_launch",
    // catalogue
    "browse_catalogue",
    "catalogue_image",
    "install_catalogue_item",
    "cancel_catalogue_install",
    // alerts, notifications and the main window's side of the pop-up
    "read_watched_server",
    "game_client_running",
    "send_player_notification",
    "send_reveille_notice",
    "open_notification_settings",
    "popup_supported",
    "show_alert_popup",
    // the pop-up window's own side
    "alert_popup_ready",
    "fit_alert_popup",
    "alert_popup_action",
    // shell
    "start_at_login",
    "set_start_at_login",
    "set_close_to_tray",
    "set_tray_tooltip",
    "app_log_files",
    // self-update
    "check_reveille_update",
    "install_reveille_update",
    "cancel_reveille_update",
    // telemetry
    "telemetry_status",
    "set_telemetry_shared",
    "track_event",
];

fn main() {
    println!("cargo:rerun-if-changed=icons");
    if let Err(error) = tauri_build::try_build(
        Attributes::new().app_manifest(AppManifest::new().commands(COMMANDS)),
    ) {
        // A build script reports failure by panicking; `tauri_build::build` does the same.
        panic!("{error:#}");
    }
}
