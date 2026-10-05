// SPDX-License-Identifier: GPL-3.0-only

pub mod openmohaa;

use reveille_core::engine::EngineChoice;
use reveille_core::install;
use reveille_core::platform::reborn;
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
    let package = reborn::package(reborn::RebornProductSet::from_products(
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
