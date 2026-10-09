// SPDX-License-Identifier: GPL-3.0-only

pub mod copy;

use reveille_core::install::{self, Installation};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;
use tracing::info;

use crate::telemetry::Telemetry;

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn detect_install(
    selected_path: Option<String>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<Option<Installation>, String> {
    let chosen = chosen_folder(selected_path);
    let automatic = chosen.is_none();
    let found = find_install(chosen);
    match &found {
        Ok(Some(installation)) => telemetry.track_install_detected(installation.playable.clone()),
        // Only the store search: a missing remembered folder is followed by one, and a rejected
        // pick is the player's own try, so counting either would double or mislabel a run.
        Ok(None) | Err(_) if automatic => telemetry.track_install_not_found(),
        Ok(None) | Err(_) => {}
    }
    found
}

/// Re-read a folder the player already chose. Unlike `detect_install` it sends no event: reopening
/// the change dialog is not a new detection.
#[tauri::command]
pub fn identify_install(path: String) -> Result<Installation, String> {
    install::identify(path).map_err(|error| error.to_string())
}

/// The folder to read instead of searching the store install locations, if any.
fn chosen_folder(selected_path: Option<String>) -> Option<String> {
    selected_path.filter(|path| !path.trim().is_empty())
}

fn find_install(chosen: Option<String>) -> Result<Option<Installation>, String> {
    if let Some(path) = chosen {
        return install::identify(path)
            .map(Some)
            .map_err(|error| error.to_string());
    }
    #[cfg(windows)]
    {
        let keys = reveille_core::platform::registry::read_live_hives()
            .map_err(|error| error.to_string())?;
        let mut roots = reveille_core::platform::registry::discover_ea_install_roots(&keys)
            .into_iter()
            .map(|candidate| candidate.root)
            .collect::<Vec<_>>();
        if let Some(root) = reveille_core::platform::registry::discover_gog_install_root(&keys) {
            roots.push(root);
        }
        for root in roots {
            if let Ok(installation) = install::identify(root) {
                return Ok(Some(installation));
            }
        }
    }
    Ok(None)
}

/// Open the platform folder picker. `None` means the player dismissed it.
#[tauri::command]
pub async fn pick_install_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    info!("opening install folder picker");
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Select your Allied Assault game folder")
        .pick_folder(move |folder| {
            // The receiver is only gone if the window closed while the dialog was open.
            drop(sender.send(folder));
        });
    let folder = receiver
        .await
        .map_err(|_| "the folder picker closed unexpectedly".to_owned())?;
    Ok(folder.map(|folder| folder.to_string()))
}

pub fn register(app: &mut tauri::App) {
    copy::register(app);
}
