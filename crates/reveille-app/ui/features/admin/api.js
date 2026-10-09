// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/admin/. The password goes to Rust once, in `addAdminServer`,
// and nothing here ever receives it back.

import { invoke } from "../../lib/bridge.js";

/** @typedef {"credential_manager" | "keychain" | "memory"} VaultKind */

/** @typedef {{ address: string, name: string }} AdminServer */

/** @typedef {{ servers: AdminServer[], vault: VaultKind }} AdminOverview */

/**
 * Why an admin command did nothing, as `AdminFailure` sends it. Branch on `reason`; show `message`.
 *
 * @typedef {"needs_password" | "bad_password" | "not_enabled" | "no_answer" | "invalid" | "unavailable" | "unknown_server"} FailureReason
 * @typedef {{ reason: FailureReason, message: string }} AdminFailure
 */

/** @typedef {{ slot: number, score: number, ping: number | null, name: string }} AdminPlayer */

/**
 * @typedef {object} AdminStatus
 * @property {string | null} name
 * @property {string | null} map
 * @property {string | null} game_type
 * @property {number | null} game_type_number
 * @property {number | null} capacity
 * @property {AdminPlayer[]} players
 * @property {string[]} rotation
 * @property {"original" | "open_mohaa"} engine
 * @property {boolean} can_message
 * @property {boolean} can_ban
 */

/**
 * One action, as `ActionRequest` in `src/admin/mod.rs` reads it. Rust checks every value.
 *
 * @typedef {{ kind: "kick" | "ban", slot: number }
 *   | { kind: "message", slot: number, text: string }
 *   | { kind: "say", text: string }
 *   | { kind: "change_map", map: string }
 *   | { kind: "restart_round" }
 *   | { kind: "set_rotation", maps: string[] }
 *   | { kind: "set_game_type", game_type: number }
 *   | { kind: "console", line: string }} AdminAction
 */

/** @returns {Promise<AdminOverview>} */
export const adminServers = () => invoke("admin_servers");

/**
 * Rejects with an `AdminFailure` unless the server answers to this password.
 *
 * @param {string} address
 * @param {string} password
 * @returns {Promise<AdminServer>}
 */
export const addAdminServer = (address, password) => invoke("add_admin_server", { address, password });

/**
 * @param {string} address
 * @returns {Promise<void>}
 */
export const removeAdminServer = (address) => invoke("remove_admin_server", { address });

/**
 * @param {string} address
 * @returns {Promise<AdminStatus>}
 */
export const adminStatus = (address) => invoke("admin_status", { address });

/**
 * What the server printed for `action`.
 *
 * @param {string} address
 * @param {AdminAction} action
 * @returns {Promise<string>}
 */
export const adminAction = (address, action) => invoke("admin_action", { address, action });
