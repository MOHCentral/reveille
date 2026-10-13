// SPDX-License-Identifier: GPL-3.0-only

pub mod openmohaa;
pub mod reborn;

use reveille_core::engine::EngineChoice;
use reveille_core::install;
use reveille_core::platform::reborn as reborn_package;
use reveille_platform as platform;
use serde::Serialize;
use tauri::Manager;
use tokio::sync::{MutexGuard, TryLockError};

/// Only one engine archive may target an installation at a time.
#[derive(Default)]
pub struct InstallGate(tokio::sync::Mutex<()>);

impl InstallGate {
    /// Each engine refuses a busy gate in its own words, so the error carries no message.
    pub fn try_enter(&self) -> Result<MutexGuard<'_, ()>, TryLockError> {
        self.0.try_lock()
    }
}

/// Why an engine step stopped, classified once beside the errors it names rather than by matching
/// message text.
///
/// The interface has to say what actually happened — a release that published no digest is not
/// a corrupted download, and neither is a release that has no build for this machine. Reading
/// that distinction out of a formatted error string in JavaScript is how the two got merged.
/// `detail` carries the original message for diagnosis; the shell chooses its own wording from
/// `kind`. Telemetry sends only the kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EngineFailureKind {
    /// The download host could not be reached or refused the request.
    Unreachable,
    /// The release exists but publishes nothing for this machine.
    NoAssetForHost,
    /// The release metadata is unusable — no digest, an ambiguous asset, no dev identity.
    /// Nothing was downloaded, so retrying changes nothing.
    ReleaseMetadata,
    /// Bytes arrived but did not match the published size or digest.
    CorruptDownload,
    /// The archive itself was rejected before any file was written.
    ArchiveRejected,
    /// The player pressed Stop.
    Cancelled,
    /// Writing into the game folder failed; existing files were restored.
    Filesystem,
    /// A failure outside the release pipeline, carried through with its own message rather than
    /// dressed up as one of the causes above.
    Internal,
}

#[derive(Clone, Serialize)]
pub struct DownloadProgress {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Serialize)]
pub struct EngineOverview {
    capabilities: platform::HostCapabilities,
    inventory: platform::engine::EngineInventory,
    resolved: Option<EngineChoice>,
    selection_error: Option<String>,
    reborn: RebornSummary,
}

#[derive(Clone, Serialize)]
pub struct RebornSummary {
    version: &'static str,
    filename: String,
    size: u64,
    sha256: &'static str,
    supported: bool,
}

#[tauri::command]
pub fn engine_overview(
    path: String,
    saved_engine: Option<EngineChoice>,
) -> Result<EngineOverview, String> {
    let installation = install::identify(path).map_err(|error| error.to_string())?;
    let package = reborn_package::package(reborn_package::RebornProductSet::from_products(
        &installation.products,
    ));
    let capabilities = platform::HostCapabilities::current();
    let resolved =
        platform::engine::resolve_choice(&installation.root, saved_engine, &capabilities);
    let (resolved, selection_error) = match resolved {
        Ok(choice) => (Some(choice), None),
        Err(error) => (None, Some(error.to_string())),
    };
    Ok(EngineOverview {
        capabilities: capabilities.clone(),
        inventory: platform::engine::inventory(&installation.root),
        resolved,
        selection_error,
        reborn: RebornSummary {
            version: package.version,
            filename: package.filename,
            size: package.size,
            sha256: package.sha256,
            supported: capabilities.supports(EngineChoice::Reborn),
        },
    })
}

#[tauri::command]
pub fn select_engine(path: String, engine: EngineChoice) -> Result<EngineOverview, String> {
    let installation = install::identify(path).map_err(|error| error.to_string())?;
    let capabilities = platform::HostCapabilities::current();
    if engine == EngineChoice::Openmohaa {
        platform::engine::resolve_choice(&installation.root, Some(engine), &capabilities)
            .map_err(|error| error.to_string())?;
    } else {
        platform::engine::activate(
            &installation.root,
            engine,
            platform::engine::retail_activity(),
            &capabilities,
        )
        .map_err(|error| error.to_string())?;
    }
    engine_overview(
        installation.root.to_string_lossy().into_owned(),
        Some(engine),
    )
}

pub fn register(app: &mut tauri::App) {
    app.manage(InstallGate::default());
    openmohaa::register(app);
    reborn::register(app);
}

#[cfg(test)]
mod tests {
    use super::DownloadProgress;

    /// Both engine install events carry this payload, and the setup view reads its two fields by
    /// name, so its shape is part of the frozen IPC contract.
    #[test]
    fn engine_download_progress_keeps_its_wire_shape() {
        assert_eq!(
            serde_json::to_value(DownloadProgress {
                received: 512,
                total: Some(2048),
            })
            .expect("serialized progress"),
            serde_json::json!({ "received": 512, "total": 2048 })
        );
        assert_eq!(
            serde_json::to_value(DownloadProgress {
                received: 0,
                total: None,
            })
            .expect("serialized progress"),
            serde_json::json!({ "received": 0, "total": null })
        );
    }
}
