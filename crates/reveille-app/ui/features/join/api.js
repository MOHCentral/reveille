// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/join/. Each takes the `Session` from `lib/session.js`.

import { invoke, listen } from "../../lib/bridge.js";

/** @typedef {import("../../lib/session.js").Session} Session */
/** @typedef {import("../../lib/catalog.js").GameId} GameId */
/** @typedef {import("../../lib/catalog.js").EngineId} EngineId */
/** @typedef {import("../servers/index.js").Server} Server */
/** @typedef {import("../servers/index.js").CompatibilityAssessment} CompatibilityAssessment */

/**
 * The server's own package manifest, fetched during preview and installed only by
 * `installServerFiles`. `md5` is the digest's sixteen bytes.
 *
 * @typedef {object} PakRadarPreview
 * @property {string} url
 * @property {{ alias: string, md5: number[], url: string }[]} entries
 * @property {number} pending
 * @property {string | null} non_result
 */

/**
 * @typedef {object} JoinPreview
 * @property {string} address
 * @property {Server} server
 * @property {CompatibilityAssessment} assessment
 * @property {PakRadarPreview | null} pakradar
 * @property {object | null} catalogue `CatalogueResolutionPass` from `reveille-core/src/content/mohdb.rs`.
 * @property {EngineId} engine
 * @property {GameId} game
 */

/** @typedef {{ map: string, reason: string }} InstallFailure */

/**
 * @typedef {object} ServerFilesResult
 * @property {JoinPreview} preview Taken again after the packages were installed.
 * @property {InstallFailure[]} failures
 */

/**
 * @typedef {object} JoinResult
 * @property {CompatibilityAssessment} assessment
 * @property {string[]} installed
 * @property {string[]} install_directories
 * @property {InstallFailure[]} failures
 * @property {string | null} game_directory
 * @property {boolean} used_home_fallback
 * @property {EngineId} engine
 * @property {GameId} game
 * @property {{ launch: "launched", process_id: number } | { launch: "refused", reason: string }} outcome
 */

/** @typedef {{ address: string, index: number, of: number, map: string }} PreviewProgress */

/**
 * One map's step in an install, flattened with its phase.
 *
 * @typedef {{ map: string, filename: string, index: number, of: number }
 *   & ({ phase: "downloading", received: number, total: number | null }
 *     | { phase: "confirming" } | { phase: "installed" } | { phase: "failed", reason: string })} InstallProgress
 */

/**
 * @param {Session} session
 * @param {string} address
 * @returns {Promise<JoinPreview>}
 */
export const previewJoin = (session, address) => invoke("preview_join", { session, address });

/**
 * @param {Session} session
 * @param {string} address
 * @returns {Promise<ServerFilesResult>}
 */
export const installServerFiles = (session, address) =>
  invoke("install_server_files", { session, address });

/**
 * @param {Session} session
 * @param {string} address
 * @param {number[]} selectedCandidateIds
 * @param {boolean} acceptIncomplete
 * @returns {Promise<JoinResult>}
 */
export const installAndLaunch = (session, address, selectedCandidateIds, acceptIncomplete) =>
  invoke("install_and_launch", { session, address, selectedCandidateIds, acceptIncomplete });

/** @param {(progress: PreviewProgress) => void} handler */
export const onPreviewProgress = (handler) => listen("reveille://preview", handler);
/** @param {(progress: InstallProgress) => void} handler */
export const onInstallProgress = (handler) => listen("reveille://install", handler);
