// SPDX-License-Identifier: GPL-3.0-only

use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reveille_core::engine::EngineChoice;
use reveille_core::install;
use reveille_core::platform::reborn::{
    self, DownloadProgress as RebornDownloadProgress, RebornClient,
};
use reveille_platform as platform;
use serde::Serialize;
use tauri::{Emitter, Manager};

use super::{DownloadProgress, InstallGate};

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
) -> Result<RebornInstallResult, String> {
    let capabilities = platform::HostCapabilities::current();
    capabilities
        .require(EngineChoice::Reborn)
        .map_err(|error| error.to_string())?;
    let _guard = gate
        .try_enter()
        .map_err(|_| "another engine install is already running".to_owned())?;
    cancel.0.store(false, Ordering::Release);
    let installation = install::identify(path).map_err(|error| error.to_string())?;
    let package = reborn::package(reborn::RebornProductSet::from_products(
        &installation.products,
    ));
    let client = RebornClient::new(Duration::from_secs(120)).map_err(|error| error.to_string())?;
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
        .map_err(|error| error.to_string())?;
    let executables =
        reborn::inspect_package(&package, &bytes).map_err(|error| error.to_string())?;
    platform::engine::install_reborn(
        &installation.root,
        &package,
        &executables,
        platform::engine::retail_activity(),
        &capabilities,
    )
    .map_err(|error| error.to_string())?;
    Ok(RebornInstallResult {
        engine: EngineChoice::Reborn,
        inventory: platform::engine::inventory(&installation.root),
    })
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
