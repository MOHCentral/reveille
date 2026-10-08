// SPDX-License-Identifier: GPL-3.0-only

//! Which window may invoke which app command, read from the ACL Tauri compiles into the binary.

use tauri::ipc::Origin;

const MAIN: &str = "main";
const POPUP: &str = crate::popup::LABEL;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Granted {
    Both,
}

use Granted::Both;

/// Every command in `main.rs`'s `generate_handler!` and who may call it.
const MATRIX: &[(&str, Granted)] = &[
    ("detect_install", Both),
    ("identify_install", Both),
    ("pick_install_folder", Both),
    ("installation_storage", Both),
    ("pick_copy_destination", Both),
    ("copy_game_installation", Both),
    ("cancel_game_installation_copy", Both),
    ("engine_overview", Both),
    ("select_engine", Both),
    ("install_reborn", Both),
    ("cancel_reborn_install", Both),
    ("openmohaa_status", Both),
    ("install_openmohaa", Both),
    ("cancel_openmohaa_install", Both),
    ("browse_servers", Both),
    ("cancel_browse", Both),
    ("check_server", Both),
    ("preview_join", Both),
    ("install_server_files", Both),
    ("install_and_launch", Both),
    ("read_watched_server", Both),
    ("game_client_running", Both),
    ("send_player_notification", Both),
    ("send_reveille_notice", Both),
    ("open_notification_settings", Both),
    ("popup_supported", Both),
    ("show_alert_popup", Both),
    ("alert_popup_ready", Both),
    ("fit_alert_popup", Both),
    ("alert_popup_action", Both),
    ("start_at_login", Both),
    ("set_start_at_login", Both),
    ("set_close_to_tray", Both),
    ("set_tray_tooltip", Both),
    ("app_log_files", Both),
    ("check_reveille_update", Both),
    ("install_reveille_update", Both),
    ("cancel_reveille_update", Both),
    ("telemetry_status", Both),
    ("set_telemetry_shared", Both),
    ("track_event", Both),
];

#[test]
fn each_window_reaches_exactly_the_commands_granted_to_it() {
    let mut context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let authority = context.runtime_authority_mut();
    let allowed = |command: &str, window: &str| {
        authority
            .resolve_access(command, window, window, &Origin::Local)
            .is_some()
    };
    for &(command, granted) in MATRIX {
        assert_eq!(
            allowed(command, MAIN),
            granted == Both,
            "{MAIN} × {command}"
        );
        assert_eq!(
            allowed(command, POPUP),
            granted == Both,
            "{POPUP} × {command}"
        );
    }
    assert!(!allowed("browse_servers", "unknown-window"));
}
