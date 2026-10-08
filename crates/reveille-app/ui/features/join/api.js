// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/join/. Each takes the `Session` from `lib/session.js`.

import { invoke, invokeWithChannel, listen } from "../../lib/bridge.js";

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

/**
 * One moh-db lookup, streamed over the channel of the call pricing the join.
 *
 * @typedef {{ address: string, index: number, of: number, map: string }} PreviewProgress
 */

/**
 * One map's step in an install, flattened with its phase.
 *
 * @typedef {{ map: string, filename: string, index: number, of: number }
 *   & ({ phase: "downloading", received: number, total: number | null }
 *     | { phase: "confirming" } | { phase: "installed" } | { phase: "failed", reason: string })} InstallProgress
 */

/**
 * `onProgress` hears this preview only, and nothing after it settles.
 *
 * @param {Session} session
 * @param {string} address
 * @param {(progress: PreviewProgress) => void} onProgress
 * @returns {Promise<JoinPreview>}
 */
export const previewJoin = (session, address, onProgress) =>
  invokeWithChannel("preview_join", { session, address }, "onProgress", onProgress);

/**
 * `onPreviewProgress` hears the preview this call builds once the server files are in place.
 *
 * @param {Session} session
 * @param {string} address
 * @param {(progress: PreviewProgress) => void} onPreviewProgress
 * @returns {Promise<ServerFilesResult>}
 */
export const installServerFiles = (session, address, onPreviewProgress) =>
  invokeWithChannel("install_server_files", { session, address }, "onPreviewProgress", onPreviewProgress);

/**
 * @param {Session} session
 * @param {string} address
 * @param {number[]} selectedCandidateIds
 * @param {boolean} acceptIncomplete
 * @returns {Promise<JoinResult>}
 */
export const installAndLaunch = (session, address, selectedCandidateIds, acceptIncomplete) =>
  invoke("install_and_launch", { session, address, selectedCandidateIds, acceptIncomplete });

/** @param {(progress: InstallProgress) => void} handler */
export const onInstallProgress = (handler) => listen("reveille://install", handler);
