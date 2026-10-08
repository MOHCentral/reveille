// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/tray.rs, autostart.rs and telemetry/commands.rs.

import { invoke } from "../../lib/bridge.js";

/**
 * @typedef {object} TelemetryStatus
 * @property {boolean} available Whether this build can send anything at all.
 * @property {boolean} shared
 */

/** @returns {Promise<void>} */
export const setCloseToTray = (enabled) => invoke("set_close_to_tray", { enabled });

/** @returns {Promise<boolean>} */
export const startAtLogin = () => invoke("start_at_login");

/** @returns {Promise<void>} */
export const setStartAtLogin = (enabled) => invoke("set_start_at_login", { enabled });

/** @returns {Promise<TelemetryStatus>} */
export const telemetryStatus = () => invoke("telemetry_status");
/** @returns {Promise<TelemetryStatus>} */
export const setTelemetryShared = (shared) => invoke("set_telemetry_shared", { shared });

/** What Reveille sends when the player shares statistics, in the public source. */
export const TELEMETRY_DETAILS_URL = "https://github.com/MOHCentral/reveille/blob/main/README.md#telemetry";
