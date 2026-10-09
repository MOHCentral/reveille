// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/catalogue/. Each that touches the game folder takes the
// `Session` from `lib/session.js`.

import { invoke, invokeWithChannel } from "../../lib/bridge.js";

/** @typedef {import("../../lib/session.js").Session} Session */

/** @typedef {"popular" | "newest" | "name"} CatalogueSort */

/**
 * Whether a listed entry can be installed: `present` is a file of the same name already in the
 * game folder that Reveille did not put there.
 *
 * @typedef {"installed" | "present" | "available" | "unavailable"} ItemState
 */

/**
 * One moh-db map, as `CatalogueItem` in `src/catalogue/mod.rs` sends it. `map_key` is the shared
 * normalisation of `map_name`; `added` is in Unix seconds.
 *
 * @typedef {object} CatalogueItem
 * @property {number} id
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

/** The reason a cancelled install rejects with; `CANCELLED` in `src/catalogue/mod.rs`. */
export const CANCELLED = "cancelled";

/**
 * @param {Session} session
 * @param {string} search
 * @param {CatalogueSort} sort
 * @param {number} page
 * @returns {Promise<CataloguePage>}
 */
export const browseCatalogue = (session, search, sort, page) =>
  invoke("browse_catalogue", { session, search, sort, page });

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
