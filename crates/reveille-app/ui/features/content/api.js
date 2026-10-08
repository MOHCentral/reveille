// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/catalogue/. Each that touches the game folder takes the
// `Session` from `lib/session.js`.

import { invoke, invokeWithChannel } from "../../lib/bridge.js";

/** @typedef {import("../../lib/session.js").Session} Session */

/** @typedef {"map" | "mod"} CatalogueKind */

/** @typedef {"popular" | "newest" | "name"} CatalogueSort */

/** @typedef {"deathmatch" | "objective" | "liberation"} MapMode */

/**
 * Whether a listed entry can be installed: `present` means the game already has it, as a file of
 * the same name or, for a map, the map itself, and Reveille did not put it there.
 *
 * @typedef {"installed" | "present" | "available" | "unavailable"} ItemState
 */

/**
 * One moh-db map or mod, as `CatalogueItem` in `src/catalogue/mod.rs` sends it. `map_key` is the
 * shared normalisation of `map_name`; `added` is in Unix seconds. `file` is the single `.pk3`
 * Reveille can install; `archive_name` names a download it will not, such as a mod's `.zip`.
 *
 * @typedef {object} CatalogueItem
 * @property {number} id
 * @property {CatalogueKind} kind
 * @property {string} title
 * @property {string | null} map_name
 * @property {string | null} map_key
 * @property {string | null} author
 * @property {string | null} description
 * @property {string | null} theme
 * @property {string | null} modes
 * @property {string | null} size_class
 * @property {number | null} added
 * @property {number | null} rating
 * @property {number} downloads
 * @property {number} image_count
 * @property {string} page_url
 * @property {string | null} mod_type
 * @property {string | null} version
 * @property {string | null} requires
 * @property {string | null} install_notes
 * @property {string | null} archive_name
 * @property {{ filename: string, size: number } | null} file
 * @property {ItemState} state
 */

/**
 * @typedef {object} CataloguePage
 * @property {CatalogueItem[]} entries
 * @property {number} total
 * @property {number} page
 * @property {boolean} has_more
 */

/**
 * @typedef {{ phase: "downloading", received: number, total: number } | { phase: "confirming" }} InstallStep
 */

/** @typedef {{ id: number, path: string, state: ItemState }} InstallOutcome */

/**
 * One package Reveille installed, as `InstalledEntry` sends it. `changed` means its size no longer
 * matches the record, so Remove will refuse it; `installed_at` is in Unix seconds.
 *
 * @typedef {object} InstalledEntry
 * @property {number} id
 * @property {CatalogueKind} kind
 * @property {string} title
 * @property {string} filename
 * @property {string | null} page_url
 * @property {number} size
 * @property {number} installed_at
 * @property {boolean} changed
 */

/** @typedef {{ items: InstalledEntry[], total_size: number }} InstalledPayload */

/** @typedef {{ id: number, state: ItemState }} RemovalOutcome */

/** The reason a cancelled install rejects with; `CANCELLED` in `src/catalogue/mod.rs`. */
export const CANCELLED = "cancelled";

/**
 * @param {Session} session
 * @param {CatalogueKind} kind
 * @param {string} search
 * @param {CatalogueSort} sort
 * @param {MapMode | null} mode
 * @param {number} page
 * @returns {Promise<CataloguePage>}
 */
export const browseCatalogue = (session, kind, search, sort, mode, page) =>
  invoke("browse_catalogue", { session, kind, search, sort, mode, page });

/**
 * moh-db's entry for each custom map in `maps`; `fresh` asks moh-db again rather than reusing what
 * this run already learned.
 *
 * @param {Session} session
 * @param {string[]} maps
 * @param {boolean} fresh
 * @returns {Promise<CatalogueItem[]>}
 */
export const cataloguePlayedNow = (session, maps, fresh) =>
  invoke("catalogue_played_now", { session, maps, fresh });

/**
 * A screenshot of a listed entry, as a `data:` URL.
 *
 * @param {number} id
 * @param {number} index
 * @returns {Promise<string>}
 */
export const catalogueImage = (id, index) => invoke("catalogue_image", { id, index });

/**
 * `onProgress` hears this install only, and nothing after it settles.
 *
 * @param {Session} session
 * @param {number} id
 * @param {(step: InstallStep) => void} onProgress
 * @returns {Promise<InstallOutcome>}
 */
export const installCatalogueItem = (session, id, onProgress) =>
  invokeWithChannel("install_catalogue_item", { session, id }, "onProgress", onProgress);

/**
 * @param {number} id
 * @returns {Promise<void>}
 */
export const cancelCatalogueInstall = (id) => invoke("cancel_catalogue_install", { id });

/**
 * @param {Session} session
 * @returns {Promise<InstalledPayload>}
 */
export const installedContent = (session) => invoke("installed_content", { session });

/**
 * Rejects, and deletes nothing, when the file is no longer the one Reveille wrote.
 *
 * @param {Session} session
 * @param {number} id
 * @returns {Promise<RemovalOutcome>}
 */
export const removeInstalledItem = (session, id) => invoke("remove_installed_item", { session, id });
