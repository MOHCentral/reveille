// SPDX-License-Identifier: GPL-3.0-only

// Loading moh-db's maps page by page, their screenshots, and installing one at a time.

import { errorText, openExternalUrl } from "../../lib/shell.js";
import { session } from "../../lib/session.js";
import { state, update } from "../../lib/store.js";
import {
  CANCELLED,
  browseCatalogue,
  cancelCatalogueInstall,
  catalogueImage,
  installCatalogueItem,
} from "./api.js";
import { queryKey } from "./selectors.js";

/** Screenshots fetched at once. Each is a request to moh-db, so a page of cards trickles in. */
const IMAGE_CONCURRENCY = 4;

export function contentController() {
  // Each load takes a ticket; an answer to an older ticket is dropped, so a search typed while a
  // page was loading never has its results overwritten by the page it replaced.
  let ticket = 0;
  const queue = [];
  let fetching = 0;

  async function load(append) {
    const asked = session();
    const { query, sort } = state.content;
    const key = queryKey(asked, query, sort);
    const page = append ? state.content.page + 1 : 0;
    const mine = ++ticket;
    update((next) => {
      next.content.loading = true;
      next.content.error = null;
      if (!append) {
        next.content.loadedFor = key;
        next.content.items = [];
        next.content.total = null;
        next.content.hasMore = false;
      }
    });
    try {
      const result = await browseCatalogue(asked, query, sort, page);
      if (mine !== ticket) return;
      update((next) => {
        const known = new Set(next.content.items.map((item) => item.id));
        next.content.items = [...next.content.items, ...result.entries.filter((item) => !known.has(item.id))];
        next.content.total = result.total;
        next.content.page = result.page;
        next.content.hasMore = result.has_more;
        next.content.loading = false;
        if (next.content.selected === null || !next.content.items.some((item) => item.id === next.content.selected)) {
          next.content.selected = next.content.items[0]?.id ?? null;
        }
      });
    } catch (error) {
      if (mine !== ticket) return;
      update((next) => {
        next.content.loading = false;
        next.content.error = errorText(error);
      });
    }
  }

  /** Load the first page unless what is on screen already answers this session, search and order. */
  function ensureLoaded() {
    const { query, sort, loadedFor } = state.content;
    if (loadedFor !== queryKey(session(), query, sort)) void load(false);
  }

  function search(query) {
    if (query === state.content.query) return;
    state.content.query = query;
    void load(false);
  }

  function setSort(sort) {
    if (sort === state.content.sort) return;
    state.content.sort = sort;
    void load(false);
  }

  function loadMore() {
    if (state.content.loading || !state.content.hasMore) return;
    void load(true);
  }

  function refresh() {
    void load(false);
  }

  function select(id) {
    if (state.content.selected === id) return;
    update((next) => (next.content.selected = id));
  }

  async function install(item) {
    if (!item?.file || item.state !== "available" || state.content.installs.has(item.id)) return;
    update((next) => {
      next.content.installs.set(item.id, { received: 0, total: item.file.size, confirming: false });
      next.content.failures.delete(item.id);
    });
    try {
      const outcome = await installCatalogueItem(session(), item.id, (step) =>
        update((next) => {
          const install = next.content.installs.get(item.id);
          if (!install) return;
          if (step.phase === "confirming") install.confirming = true;
          else {
            install.received = step.received;
            install.total = step.total || install.total;
          }
        }),
      );
      update((next) => {
        for (const known of next.content.items) if (known.id === outcome.id) known.state = outcome.state;
      });
    } catch (error) {
      const reason = errorText(error);
      if (reason !== CANCELLED) update((next) => next.content.failures.set(item.id, reason));
    } finally {
      update((next) => next.content.installs.delete(item.id));
    }
  }

  function cancel(item) {
    if (!state.content.installs.has(item.id)) return;
    void cancelCatalogueInstall(item.id).catch(() => {});
  }

  /**
   * Ask for screenshot `index` of `item` once. Called while painting, so it writes the pending mark
   * without notifying and notifies only when the image lands.
   */
  function requestImage(item, index = 0) {
    if (!item || index >= item.image_count) return;
    const key = `${item.id}:${index}`;
    if (state.content.images.has(key)) return;
    state.content.images.set(key, "loading");
    queue.push([item.id, index, key]);
    pump();
  }

  function pump() {
    while (fetching < IMAGE_CONCURRENCY && queue.length) {
      const [id, index, key] = queue.shift();
      fetching += 1;
      catalogueImage(id, index)
        .then((data) => update((next) => next.content.images.set(key, data)))
        .catch(() => update((next) => next.content.images.set(key, "failed")))
        .finally(() => {
          fetching -= 1;
          pump();
        });
    }
  }

  /** Step the detail pane's screenshot by `delta`, wrapping at either end. */
  function showImage(item, delta) {
    if (!item || item.image_count < 2) return;
    const current = state.content.shown.get(item.id) ?? 0;
    const index = (current + delta + item.image_count) % item.image_count;
    update((next) => next.content.shown.set(item.id, index));
  }

  function openLink(url) {
    void openExternalUrl(url).catch(() => {});
  }

  return { ensureLoaded, search, setSort, loadMore, refresh, select, install, cancel, requestImage, showImage, openLink };
}
