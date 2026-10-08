// SPDX-License-Identifier: GPL-3.0-only

// The keys Maps & mods owns, and the one choice it remembers between runs.

import { registerPreferences } from "../../lib/preferences.js";

export const LAYOUTS = ["cards", "list"];
export const TABS = ["maps", "mods", "installed"];
/** Orders moh-db sorts by. */
export const SORTS = ["popular", "newest", "name"];
/** Orders for Played now, sorted here over the few maps it lists; players first. */
export const PLAYED_SORTS = ["played", "popular", "newest", "name"];
/** moh-db's map name directories: `MapMode` in `reveille-core/src/content/catalogue.rs`. */
export const MODES = ["deathmatch", "objective", "liberation"];

registerPreferences(
  // Cards by default: a screenshot is how most players recognise a map.
  { contentLayout: "cards" },
  { contentLayout: (value) => LAYOUTS.includes(value) },
);

export function initial() {
  return {
    content: {
      /** Maps, Mods or Installed. */
      tab: "maps",
      query: "",
      sort: "popular",
      /** Only maps of this mode, or null for every mode. Maps only. */
      mode: null,
      /** Only the maps servers in the list run right now. Maps only. */
      playedNow: false,
      /** Entries loaded so far, across every page asked for. */
      items: [],
      total: null,
      /** What moh-db last said it holds in all, per listing, for the tab counts. */
      totals: { maps: null, mods: null },
      page: 0,
      hasMore: false,
      loading: false,
      /** Why the last page could not be loaded, or null. */
      error: null,
      /** Which session and question `items` answer, so a change asks again. */
      loadedFor: null,
      /** The selected entry's id. */
      selected: null,
      /** Installs in flight, by id: `{ received, total, confirming }`. */
      installs: new Map(),
      /** The last install of each id that failed, and why. */
      failures: new Map(),
      /** Screenshots by `id:index`: a `data:` URL, `"loading"`, or `"failed"`. */
      images: new Map(),
      /** Which screenshot the detail pane shows, by id. */
      shown: new Map(),
      /** What Reveille installed into this game, for the Installed tab and the status bar. */
      installed: {
        items: [],
        totalSize: 0,
        loading: false,
        error: null,
        /** Which session `items` answer; null asks again. */
        loadedFor: null,
        selected: null,
        /** Ids being removed. */
        removing: new Set(),
        /** Why the last removal of each id was refused. */
        failures: new Map(),
      },
    },
  };
}
