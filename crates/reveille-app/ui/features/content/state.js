// SPDX-License-Identifier: GPL-3.0-only

// The keys Maps & mods owns, and the one choice it remembers between runs.

import { registerPreferences } from "../../lib/preferences.js";

export const LAYOUTS = ["cards", "list"];
export const SORTS = ["popular", "newest", "name"];

registerPreferences(
  // Cards by default: a screenshot is how most players recognise a map.
  { contentLayout: "cards" },
  { contentLayout: (value) => LAYOUTS.includes(value) },
);

export function initial() {
  return {
    content: {
      query: "",
      sort: "popular",
      /** Entries loaded so far, across every page asked for. */
      items: [],
      total: null,
      page: 0,
      hasMore: false,
      loading: false,
      /** Why the last page could not be loaded, or null. */
      error: null,
      /** Which session, search and order `items` answer, so a change asks again. */
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
    },
  };
}
