// SPDX-License-Identifier: GPL-3.0-only

use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reveille_core::engine::EngineChoice;
use reveille_core::install;
use reveille_core::platform::reborn::{
    self, DownloadProgress as RebornDownloadProgress, RebornClient, RebornError,
};
use reveille_platform as platform;
use serde::Serialize;
use tauri::{Emitter, Manager};

use super::{DownloadProgress, EngineFailureKind, InstallGate};
use crate::telemetry::{EngineInstallOutcome, Event, Telemetry};

pub const EVENT: &str = "reveille://reborn-install";

/// Cancellation for the pinned Reborn archive transfer.
#[derive(Default)]
pub struct RebornCancel(AtomicBool);

#[derive(Serialize)]
pub struct RebornInstallResult {
    engine: EngineChoice,
    inventory: platform::engine::EngineInventory,
}

#[tauri::command]
pub async fn install_reborn(
    path: String,
    app: tauri::AppHandle,
    gate: tauri::State<'_, InstallGate>,
    cancel: tauri::State<'_, RebornCancel>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<RebornInstallResult, String> {
    let engine = EngineChoice::Reborn;
    telemetry.track(&Event::EngineInstallStarted { engine });
    let result = install(&path, &app, &gate, &cancel).await;
    telemetry.track(&match &result {
        Ok(_) => Event::EngineInstallCompleted {
            engine,
            outcome: EngineInstallOutcome::Installed,
        },
        Err((reason, _)) => Event::EngineInstallFailed {
            engine,
            reason: *reason,
        },
    });
    result.map_err(|(_, message)| message)
}

async fn install(
    path: &str,
    app: &tauri::AppHandle,
    gate: &InstallGate,
    cancel: &RebornCancel,
) -> Result<RebornInstallResult, (EngineFailureKind, String)> {
    let internal = |error: &dyn ToString| (EngineFailureKind::Internal, error.to_string());
    let capabilities = platform::HostCapabilities::current();
    capabilities
        .require(EngineChoice::Reborn)
        .map_err(|error| (EngineFailureKind::NoAssetForHost, error.to_string()))?;
    let _guard = gate
        .try_enter()
        .map_err(|_| internal(&"another engine install is already running"))?;
    cancel.0.store(false, Ordering::Release);
    let installation = install::identify(path).map_err(|error| internal(&error))?;
    let package = reborn::package(reborn::RebornProductSet::from_products(
        &installation.products,
    ));
    let client = RebornClient::new(Duration::from_secs(120)).map_err(|error| classified(&error))?;
    let bytes = client
        .download_reporting(&package, |RebornDownloadProgress { received, total }| {
            drop(app.emit(EVENT, DownloadProgress { received, total }));
            if cancel.0.load(Ordering::Acquire) {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        })
        .await
        .map_err(|error| classified(&error))?;
    let executables =
        reborn::inspect_package(&package, &bytes).map_err(|error| classified(&error))?;
    platform::engine::install_reborn(
        &installation.root,
        &package,
        &executables,
        platform::engine::retail_activity(),
        &capabilities,
    )
    .map_err(|error| (EngineFailureKind::Filesystem, error.to_string()))?;
    Ok(RebornInstallResult {
        engine: EngineChoice::Reborn,
        inventory: platform::engine::inventory(&installation.root),
    })
}

fn classified(error: &RebornError) -> (EngineFailureKind, String) {
    (failure_kind(error), error.to_string())
}

fn failure_kind(error: &RebornError) -> EngineFailureKind {
    match error {
        RebornError::Client(_) | RebornError::Network(_) | RebornError::HttpStatus(_) => {
            EngineFailureKind::Unreachable
        }
        RebornError::Cancelled => EngineFailureKind::Cancelled,
        RebornError::TooLarge(_)
        | RebornError::SizeMismatch { .. }
        | RebornError::DigestMismatch { .. } => EngineFailureKind::CorruptDownload,
        RebornError::InvalidZip(_)
        | RebornError::ArchiveIo(_)
        | RebornError::UnsafeEntry(_)
        | RebornError::UnexpectedEntry(_)
        | RebornError::DuplicateEntry(_)
        | RebornError::MissingExecutable(_) => EngineFailureKind::ArchiveRejected,
    }
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri managed state parameter"
)]
pub fn cancel_reborn_install(cancel: tauri::State<'_, RebornCancel>) {
    cancel.0.store(true, Ordering::Release);
}

pub fn register(app: &mut tauri::App) {
    app.manage(RebornCancel::default());
}

#[cfg(test)]
mod tests {
    use reveille_core::platform::reborn::RebornError;

    use super::{EngineFailureKind, failure_kind};

    #[test]
    fn a_stopped_or_damaged_reborn_download_is_told_apart_from_an_unreachable_host() {
        assert_eq!(
            failure_kind(&RebornError::HttpStatus(503)),
            EngineFailureKind::Unreachable
        );
        assert_eq!(
            failure_kind(&RebornError::Cancelled),
            EngineFailureKind::Cancelled
        );
        assert_eq!(
            failure_kind(&RebornError::SizeMismatch {
                expected: 1,
                actual: 2
            }),
            EngineFailureKind::CorruptDownload
        );
        assert_eq!(
            failure_kind(&RebornError::MissingExecutable("MOHAA.exe".to_owned())),
            EngineFailureKind::ArchiveRejected
        );
    }
}
