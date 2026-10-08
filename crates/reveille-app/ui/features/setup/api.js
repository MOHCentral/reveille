// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/installation/ and engines/.

import { errorText, invoke, listen } from "../../lib/bridge.js";

export { errorText };

/** @typedef {import("../../lib/session.js").Installation} Installation */
/** @typedef {import("../../lib/catalog.js").EngineId} EngineId */
/** @typedef {"stable" | "preview"} ReleaseChannel */

/**
 * @typedef {object} EngineInventory
 * @property {boolean} original_installed
 * @property {boolean} openmohaa_installed
 * @property {boolean} reborn_installed
 * @property {boolean} reborn_current
 * @property {{ state: "absent" } | { state: "current" } | { state: "known_other", version: string } | { state: "unknown" }} reborn_build
 * @property {EngineId | null} selected
 */

/**
 * @typedef {object} EngineOverview
 * @property {{ platform: "windows" | "macos" | "unsupported", engines: EngineId[] }} capabilities
 *   The engines this host can run, in the order to offer them.
 * @property {EngineInventory} inventory
 * @property {EngineId | null} resolved
 * @property {string | null} selection_error
 * @property {{ version: string, filename: string, size: number, sha256: string, supported: boolean }} reborn
 */

/** @typedef {{ engine: EngineId, inventory: EngineInventory }} RebornInstallResult */

/**
 * The release on offer. `prerelease` is not implied by the channel: the preview channel serves the
 * stable release once it outranks the newest candidate.
 *
 * @typedef {object} OpenMohaaRelease
 * @property {number} offer_id
 * @property {ReleaseChannel} channel
 * @property {string} version
 * @property {boolean} prerelease
 * @property {string} asset_name
 * @property {number} size
 * @property {string} digest
 */

/**
 * @typedef {{ state: "absent" } | { state: "current" } | { state: "unknown" }
 *   | { state: "known_other", channel: ReleaseChannel, version: string,
 *       relation: "newer" | "older" | "same_version" | "incomparable" }} OpenMohaaInstalledBuild
 */

/**
 * @typedef {object} OpenMohaaActivity
 * @property {"confirmed_stopped" | "running" | "unknown"} state
 * @property {("game" | "dedicated_server" | "launcher")[]} running
 */

/**
 * @typedef {{ availability: "available", target: string, installed_build: OpenMohaaInstalledBuild,
 *     activity: OpenMohaaActivity, package: OpenMohaaRelease }
 *   | { availability: "unsupported", os: string, architecture: string }} OpenMohaaStatus
 */

/**
 * @typedef {object} OpenMohaaInstallResult
 * @property {OpenMohaaRelease} package
 * @property {{ outcome: "installed", files: number } | { outcome: "updated", files: number, replaced: number }
 *   | { outcome: "deferred", reason: "client_running" | "client_state_unknown" }} outcome
 * @property {OpenMohaaActivity} activity
 * @property {OpenMohaaInstalledBuild} installed_build
 */

/**
 * What the OpenMoHAA commands reject with, instead of a string.
 *
 * @typedef {{ kind: "unreachable" | "no_asset_for_host" | "release_metadata" | "corrupt_download"
 *   | "archive_rejected" | "cancelled" | "filesystem" | "internal", detail: string }} OpenMohaaFailure
 */

/**
 * @typedef {{ status: "writable" }
 *   | { status: "protected", folders: string[], source_bytes: number, suggested_destination: string | null }} InstallationStorageStatus
 */

/**
 * @typedef {{ outcome: "copied", installation: Installation, source_bytes: number, source_files: number }
 *   | { outcome: "cancelled" }} InstallationCopyResult
 */

/** @typedef {{ copied_bytes: number, total_bytes: number, copied_files: number, total_files: number }} InstallationCopyProgress */

/** @typedef {{ received: number, total: number | null }} DownloadProgress */

/**
 * @param {string | null} [selectedPath]
 * @returns {Promise<Installation | null>}
 */
export const detectInstall = (selectedPath = null) => invoke("detect_install", { selectedPath });
/**
 * @param {string} path
 * @returns {Promise<Installation>} Rejects when the folder no longer reads.
 */
export const identifyInstall = (path) => invoke("identify_install", { path });

/**
 * @param {string} path
 * @param {EngineId | null} [savedEngine]
 * @returns {Promise<EngineOverview>}
 */
export const engineOverview = (path, savedEngine = null) =>
  invoke("engine_overview", { path, savedEngine });
/**
 * @param {string} path
 * @param {EngineId} engine
 * @returns {Promise<EngineOverview>}
 */
export const selectEngine = (path, engine) => invoke("select_engine", { path, engine });
/**
 * @param {string} path
 * @returns {Promise<RebornInstallResult>}
 */
export const installReborn = (path) => invoke("install_reborn", { path });
/** @returns {Promise<void>} */
export const cancelRebornInstall = () => invoke("cancel_reborn_install");

/**
 * @param {string} path
 * @param {ReleaseChannel} channel
 * @returns {Promise<OpenMohaaStatus>} Rejects with an `OpenMohaaFailure`.
 */
export const openMohaaStatus = (path, channel) =>
  invoke("openmohaa_status", { path, channel });

/**
 * @param {string} path
 * @param {number} offerId The `offer_id` of the release `openMohaaStatus` offered.
 * @returns {Promise<OpenMohaaInstallResult>} Rejects with an `OpenMohaaFailure`.
 */
export const installOpenMohaa = (path, offerId) =>
  invoke("install_openmohaa", { path, offerId });

/** @returns {Promise<void>} */
export const cancelOpenMohaaInstall = () => invoke("cancel_openmohaa_install");

/**
 * @param {string} path
 * @returns {Promise<InstallationStorageStatus>}
 */
export const installationStorage = (path) => invoke("installation_storage", { path });
/**
 * @param {string} sourcePath
 * @returns {Promise<string | null>} A new folder beneath the parent the player chose, or null when
 *   they closed the picker.
 */
export const pickCopyDestination = (sourcePath) =>
  invoke("pick_copy_destination", { sourcePath });
/**
 * @param {string} sourcePath
 * @param {string} destinationPath
 * @returns {Promise<InstallationCopyResult>}
 */
export const copyGameInstallation = (sourcePath, destinationPath) =>
  invoke("copy_game_installation", { sourcePath, destinationPath });
/** @returns {Promise<void>} */
export const cancelGameInstallationCopy = () => invoke("cancel_game_installation_copy");

/** @returns {Promise<string | null>} Null when the player closed the picker. */
export const pickInstallFolder = () => invoke("pick_install_folder");

/** @param {(progress: DownloadProgress) => void} handler */
export const onOpenMohaaInstallProgress = (handler) =>
  listen("reveille://openmohaa-install", handler);
/** @param {(progress: DownloadProgress) => void} handler */
export const onRebornInstallProgress = (handler) => listen("reveille://reborn-install", handler);
/** @param {(progress: InstallationCopyProgress) => void} handler */
export const onInstallationCopyProgress = (handler) =>
  listen("reveille://installation-copy", handler);
