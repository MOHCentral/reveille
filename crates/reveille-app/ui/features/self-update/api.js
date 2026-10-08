// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/self_update.rs.

import { invoke, listen } from "../../lib/bridge.js";

/** @typedef {{ version: string, current_version: string }} UpdateOffer */

/**
 * @typedef {{ phase: "downloading", received: number, total: number | null }
 *   | { phase: "verifying" } | { phase: "installing" } | { phase: "cancelled" }} SelfUpdateProgress
 */

/** @returns {Promise<UpdateOffer | null>} */
export const checkReveilleUpdate = () => invoke("check_reveille_update");
/** @returns {Promise<void>} The app exits on Windows. */
export const installReveilleUpdate = () => invoke("install_reveille_update");
/** @returns {Promise<void>} */
export const cancelReveilleUpdate = () => invoke("cancel_reveille_update");

/** @param {(progress: SelfUpdateProgress) => void} handler */
export const onSelfUpdateProgress = (handler) => listen("reveille://self-update", handler);
