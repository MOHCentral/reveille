// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/servers/. Each takes the `Session` from `lib/session.js`.

import { errorText, invoke, invokeWithChannel } from "../../lib/bridge.js";

/** @typedef {import("../../lib/session.js").Session} Session */
/** @typedef {import("../../lib/catalog.js").GameId} GameId */

/**
 * `Server` from `reveille-core/src/discovery/model.rs`, as the server published it. Every number is
 * a plain count, port or millisecond value.
 *
 * @typedef {object} Server
 * @property {{ address: string, query_port: number }} endpoint
 * @property {number} game_port
 * @property {string} hostname
 * @property {string | null} game_name
 * @property {string | null} game_version
 * @property {string | null} version
 * @property {string | null} protocol
 * @property {string | null} current_map
 * @property {string | null} game_type In the server's own spelling; a mod may publish anything.
 * @property {string[]} rotation
 * @property {number | null} allow_download A bitmask, not a boolean.
 * @property {number | null} map_checksum
 * @property {string | null} pr_downloads
 * @property {number | null} minimum_ping
 * @property {number | null} maximum_ping
 * @property {number | null} join_window
 * @property {number | null} reserved_slots
 * @property {{ clients_reported: number | null, bots_reported: number | null }} occupancy
 * @property {number | null} client_capacity
 * @property {{ name: string, ping: number | null, kills: number | null, deaths: number | null }[]} players
 * @property {string | null} pure
 * @property {number} status_round_trip
 */

/**
 * `CompatibilityAssessment` from `reveille-core/src/join.rs`. `preflight` is null exactly when the
 * server published neither a rotation nor a current map.
 *
 * @typedef {object} CompatibilityAssessment
 * @property {{ state: "compatible" | "needs_maps" | "no_source" | "cant_tell", count?: number, shopping_list?: object | null }} state
 * @property {{ verdict: { verdict: "compatible" | "problems_found", absent?: number, checksum_mismatches?: number }, maps: { map: string, status: object }[] } | null} preflight
 * @property {{ readiness: "playable" | "missing" | "unknown" }} current_map
 */

/**
 * One row of the server list. `address` is `ip:port` of the game port.
 *
 * @typedef {object} BrowserServer
 * @property {string} address
 * @property {Server} server
 * @property {CompatibilityAssessment} compatibility
 */

/**
 * Registrations that produced no row, grouped by where and why they stopped.
 *
 * @typedef {object} NonResultGroup
 * @property {"game_spy_status" | "host_port" | "get_status" | "endpoint_deduplication"} stage
 * @property {"timeout" | "network" | "malformed" | "missing_host_port" | "duplicate_endpoint"} reason
 * @property {string | null} detail
 * @property {number} count
 */

/**
 * @typedef {object} BrowserPayload
 * @property {BrowserServer[]} servers
 * @property {object} summary `BrowseSummary` from `reveille-core/src/discovery/model.rs`.
 * @property {NonResultGroup[]} non_results
 * @property {boolean} cancelled
 */

/**
 * At most one of the three fields is set.
 *
 * @typedef {object} CheckResult
 * @property {BrowserServer | null} row
 * @property {NonResultGroup | null} non_result
 * @property {GameId | null} other_game The server answered, but for another of the three games.
 */

/**
 * Running counts streamed over `browse_servers`'s `onProgress` channel. `row` is the server that
 * just answered.
 *
 * @typedef {object} BrowseProgress
 * @property {number} registered
 * @property {number} inspected
 * @property {number} probed
 * @property {number} answered
 * @property {number} non_results
 * @property {BrowserServer | null} row
 */

/**
 * @typedef {"no_network" | "master_unreachable" | "master_unreadable" | "game_unavailable"
 *   | "engine_unavailable" | "maps_unreadable" | "internal"} BrowseFailureKind
 */

/** @typedef {{ kind: BrowseFailureKind, detail: string }} BrowseFailure */

/**
 * `onProgress` hears this sweep only, and nothing after it settles.
 *
 * @param {Session} session
 * @param {(progress: BrowseProgress) => void} onProgress
 * @param {boolean} background Keep the current list and in-flight direct checks usable.
 * @returns {Promise<BrowserPayload>} Rejects with a `BrowseFailure`; read it with `browseFailure`.
 */
export const browseServers = (session, onProgress, background = false) =>
  invokeWithChannel("browse_servers", { session, background }, "onProgress", onProgress);

/** @returns {Promise<void>} */
export const cancelBrowse = () => invoke("cancel_browse");

/**
 * Probe one remembered server directly. Resolves either way: a server that did not answer comes
 * back as `{ row: null, non_result }`, and one that answered for another of the three games as
 * `{ row: null, other_game }`. Never a rejection.
 *
 * @param {Session} session
 * @param {string} address
 * @param {number} queryPort
 * @returns {Promise<CheckResult>}
 */
export const checkServer = (session, address, queryPort) =>
  invoke("check_server", { session, address, queryPort });

/**
 * `browse_servers` is the one command that rejects with a classified failure rather than a string.
 *
 * `{ kind, detail }`, where `kind` is decided in Rust beside the errors it names — the shell must
 * never read a cause out of a formatted message, which is how "no internet" and "the master sent
 * nonsense" ended up as the same unreadable line. Anything else that
 * reaches this is carried through as `internal` with its own message intact.
 *
 * @param {*} error
 * @returns {BrowseFailure}
 */
export function browseFailure(error) {
  if (error && typeof error === "object" && typeof error.kind === "string") {
    return { kind: error.kind, detail: errorText(error.detail ?? "") };
  }
  return { kind: "internal", detail: errorText(error) };
}
