// SPDX-License-Identifier: GPL-3.0-only

use tauri::Manager;
use tracing::{info, warn};

use super::{Sink, Telemetry, TelemetryStatus, UiEvent};

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn telemetry_status(telemetry: tauri::State<'_, Telemetry>) -> TelemetryStatus {
    telemetry.status()
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn set_telemetry_shared(
    shared: bool,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<TelemetryStatus, String> {
    info!(shared, "telemetry choice changed");
    telemetry
        .set_shared(shared)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn track_event(event: UiEvent, telemetry: tauri::State<'_, Telemetry>) {
    telemetry.track_ui(event);
}

/// Load the telemetry choice and send this run's start. A build or machine without a usable
/// config directory gets telemetry that is unavailable rather than a failed start.
pub fn init_telemetry(app: &tauri::App) -> Telemetry {
    let version = app.package_info().version.to_string();
    let telemetry = match app.path().app_config_dir() {
        Ok(directory) => Telemetry::load(directory, version, Sink::from_build()),
        Err(error) => {
            warn!(%error, "could not resolve the app config directory; telemetry is off");
            Telemetry::unavailable(version)
        }
    };
    telemetry.install_panic_hook();
    telemetry.start();
    telemetry
}
