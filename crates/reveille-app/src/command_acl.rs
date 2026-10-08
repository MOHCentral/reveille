// SPDX-License-Identifier: GPL-3.0-only

//! Which window may invoke which app command, read from the ACL Tauri compiles into the binary.

use tauri::ipc::Origin;

const MAIN: &str = "main";
const POPUP: &str = crate::popup::LABEL;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Granted {
    Main,
    Popup,
}

use Granted::{Main, Popup};

/// Every command in `main.rs`'s `generate_handler!` and who may call it.
const MATRIX: &[(&str, Granted)] = &[
    ("detect_install", Main),
    ("identify_install", Main),
    ("pick_install_folder", Main),
    ("installation_storage", Main),
    ("pick_copy_destination", Main),
    ("copy_game_installation", Main),
    ("cancel_game_installation_copy", Main),
    ("engine_overview", Main),
    ("select_engine", Main),
    ("install_reborn", Main),
    ("cancel_reborn_install", Main),
    ("openmohaa_status", Main),
    ("install_openmohaa", Main),
    ("cancel_openmohaa_install", Main),
    ("browse_servers", Main),
    ("cancel_browse", Main),
    ("check_server", Main),
    ("preview_join", Main),
    ("install_server_files", Main),
    ("install_and_launch", Main),
    ("browse_catalogue", Main),
    ("catalogue_image", Main),
    ("install_catalogue_item", Main),
    ("cancel_catalogue_install", Main),
    ("read_watched_server", Main),
    ("game_client_running", Main),
    ("send_player_notification", Main),
    ("send_reveille_notice", Main),
    ("open_notification_settings", Main),
    ("popup_supported", Main),
    ("show_alert_popup", Main),
    ("alert_popup_ready", Popup),
    ("fit_alert_popup", Popup),
    ("alert_popup_action", Popup),
    ("start_at_login", Main),
    ("set_start_at_login", Main),
    ("set_close_to_tray", Main),
    ("set_tray_tooltip", Main),
    ("app_log_files", Main),
    ("check_reveille_update", Main),
    ("install_reveille_update", Main),
    ("cancel_reveille_update", Main),
    ("telemetry_status", Main),
    ("set_telemetry_shared", Main),
    ("track_event", Main),
];

#[test]
fn each_window_reaches_exactly_the_commands_granted_to_it() {
    let mut context = crate::context();
    let authority = context.runtime_authority_mut();
    let allowed = |command: &str, window: &str| {
        authority
            .resolve_access(command, window, window, &Origin::Local)
            .is_some()
    };
    for &(command, granted) in MATRIX {
        assert_eq!(
            allowed(command, MAIN),
            granted == Main,
            "{MAIN} × {command}"
        );
        assert_eq!(
            allowed(command, POPUP),
            granted == Popup,
            "{POPUP} × {command}"
        );
    }
    assert!(!allowed("browse_servers", "unknown-window"));
}
