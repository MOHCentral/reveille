// SPDX-License-Identifier: GPL-3.0-only

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use reveille_core::install::{self, Installation};
use reveille_platform as platform;
use serde::Serialize;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tokio::sync::oneshot;

pub const EVENT: &str = "reveille://installation-copy";

#[derive(Default)]
pub struct CopyState {
    /// Only one game-folder copy may run at a time.
    operation: tokio::sync::Mutex<()>,
    /// Read between copied chunks; cancellation never exposes the final destination early.
    cancel: Arc<AtomicBool>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum InstallationStorageStatus {
    Writable,
    Protected {
        folders: Vec<PathBuf>,
        source_bytes: u64,
        suggested_destination: Option<PathBuf>,
    },
}

#[derive(Clone, Serialize)]
pub struct InstallationCopyProgress {
    copied_bytes: u64,
    total_bytes: u64,
    copied_files: u64,
    total_files: u64,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum InstallationCopyResult {
    Copied {
        installation: Installation,
        source_bytes: u64,
        source_files: u64,
    },
    Cancelled,
}

/// Probe setup-time write access and measure the source only when a writable copy may be needed.
#[tauri::command]
pub async fn installation_storage(path: String) -> Result<InstallationStorageStatus, String> {
    tokio::task::spawn_blocking(move || {
        let installation = install::identify(&path).map_err(|error| error.to_string())?;
        let probe = platform::installation_copy::probe_installation_write_access(&installation)
            .map_err(|error| error.to_string())?;
        if probe.is_writable() {
            return Ok(InstallationStorageStatus::Writable);
        }
        let plan = platform::installation_copy::measure_installation(&installation.root)
            .map_err(|error| error.to_string())?;
        Ok(InstallationStorageStatus::Protected {
            folders: probe.blocked,
            source_bytes: plan.bytes,
            suggested_destination: platform::installation_copy::suggested_destination(
                &installation.root,
            ),
        })
    })
    .await
    .map_err(|error| format!("the game-folder check did not finish: {error}"))?
}

/// Let the player choose a parent and derive a new, non-existing installation folder beneath it.
#[tauri::command]
pub async fn pick_copy_destination(
    source_path: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let source = PathBuf::from(source_path);
    let (sender, receiver) = oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose where to put the writable game copy")
        .pick_folder(move |folder| {
            drop(sender.send(folder));
        });
    let folder = receiver
        .await
        .map_err(|_| "the folder picker closed unexpectedly".to_owned())?;
    Ok(folder.map(|folder| {
        platform::installation_copy::destination_in_parent(&source, Path::new(&folder.to_string()))
            .to_string_lossy()
            .into_owned()
    }))
}

/// Copy a protected game folder to a user-owned destination and re-identify it before returning.
#[tauri::command]
pub async fn copy_game_installation(
    source_path: String,
    destination_path: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, CopyState>,
) -> Result<InstallationCopyResult, String> {
    let _guard = state
        .operation
        .try_lock()
        .map_err(|_| "a game-folder copy is already running".to_owned())?;
    state.cancel.store(false, Ordering::Release);
    let cancel = Arc::clone(&state.cancel);
    let source = PathBuf::from(source_path);
    let destination = PathBuf::from(destination_path);
    let copy_app = app.clone();
    tokio::task::spawn_blocking(move || {
        platform::installation_copy::copy_installation_reporting(
            &source,
            &destination,
            || cancel.load(Ordering::Acquire),
            |progress| {
                drop(copy_app.emit(
                    EVENT,
                    InstallationCopyProgress {
                        copied_bytes: progress.copied_bytes,
                        total_bytes: progress.total_bytes,
                        copied_files: progress.copied_files,
                        total_files: progress.total_files,
                    },
                ));
            },
        )
    })
    .await
    .map_err(|error| format!("the game-folder copy did not finish: {error}"))?
    .map_or_else(
        |error| {
            if matches!(
                error,
                platform::installation_copy::InstallationCopyError::Cancelled
            ) {
                Ok(InstallationCopyResult::Cancelled)
            } else {
                Err(error.to_string())
            }
        },
        |copied| {
            Ok(InstallationCopyResult::Copied {
                installation: copied.installation,
                source_bytes: copied.source_bytes,
                source_files: copied.source_files,
            })
        },
    )
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn cancel_game_installation_copy(state: tauri::State<'_, CopyState>) {
    state.cancel.store(true, Ordering::Release);
}

pub fn register(app: &mut tauri::App) {
    app.manage(CopyState::default());
}
