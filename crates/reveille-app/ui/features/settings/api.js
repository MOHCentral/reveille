// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/main.rs and autostart.rs):
//   set_close_to_tray(enabled)                 -> void
//   start_at_login()                           -> boolean
//   set_start_at_login(enabled)                -> void
//   telemetry_status()                         -> { available, shared }
//   set_telemetry_shared(shared)               -> { available, shared }

import { invoke } from "../../lib/bridge.js";

export const setCloseToTray = (enabled) => invoke("set_close_to_tray", { enabled });

export const startAtLogin = () => invoke("start_at_login");

export const setStartAtLogin = (enabled) => invoke("set_start_at_login", { enabled });

export const telemetryStatus = () => invoke("telemetry_status");
export const setTelemetryShared = (shared) => invoke("set_telemetry_shared", { shared });

/** What Reveille sends when the player shares statistics, in the public source. */
export const TELEMETRY_DETAILS_URL = "https://github.com/MOHCentral/reveille/blob/main/README.md#telemetry";
