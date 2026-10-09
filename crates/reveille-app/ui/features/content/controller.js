// SPDX-License-Identifier: GPL-3.0-only

// Loading moh-db's maps and mods page by page, the maps played now, their screenshots, installing
// one at a time, and removing what Reveille installed.

import { errorText, openExternalUrl } from "../../lib/shell.js";
import { session } from "../../lib/session.js";
import { state, update } from "../../lib/store.js";
import {
  CANCELLED,
  browseCatalogue,
  cancelCatalogueInstall,
  catalogueImage,
  cataloguePlayedNow,
  installCatalogueItem,
  installedContent,
  removeInstalledItem,
} from "./api.js";
import { fileKey, installedKey, playedMaps, queryKey } from "./selectors.js";
import { MODES, PLAYED_SORTS, SORTS, TABS } from "./state.js";

/** Screenshots fetched at once. Each is a request to moh-db, so a page of cards trickles in. */
const IMAGE_CONCURRENCY = 4;

const KINDS = { maps: "map", mods: "mod" };

export function contentController() {
  // Each load takes a ticket; an answer to an older ticket is dropped, so a search typed while a
  // page was loading never has its results overwritten by the page it replaced.
  let ticket = 0;
  let installedTicket = 0;
  const queue = [];
  let fetching = 0;

  async function load(append, fresh = false) {
    const asked = session();
    const content = state.content;
    const { tab, query, sort, mode } = content;
    if (tab === "installed") return loadInstalled();
    const playedNow = tab === "maps" && content.playedNow;
    const key = queryKey(asked, content);
    const page = append ? content.page + 1 : 0;
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
      const result = playedNow
        ? { entries: await cataloguePlayedNow(asked, playedMaps(), fresh), page: 0, has_more: false }
        : await browseCatalogue(asked, KINDS[tab], query, sort, tab === "maps" ? mode : null, page);
      // A total is the listing's size only for an unfiltered browse, and it stays true even when
      // the page itself arrived too late to show.
      if (!playedNow && !query.trim() && !(tab === "maps" && mode)) {
        update((next) => (next.content.totals[tab] = result.total));
      }
      if (mine !== ticket) return;
      update((next) => {
        const known = new Set(next.content.items.map((item) => item.id));
        next.content.items = [...next.content.items, ...result.entries.filter((item) => !known.has(item.id))];
        next.content.total = result.total ?? next.content.items.length;
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

  async function loadInstalled() {
    const asked = session();
    const mine = ++installedTicket;
    update((next) => {
      next.content.installed.loading = true;
      next.content.installed.error = null;
      next.content.installed.loadedFor = installedKey(asked);
    });
    try {
      const result = await installedContent(asked);
      if (mine !== installedTicket) return;
      update((next) => {
        const installed = next.content.installed;
        installed.items = result.items;
        installed.totalSize = result.total_size;
        installed.loading = false;
        if (!installed.items.some((item) => fileKey(item.filename) === installed.selected)) {
          installed.selected = installed.items[0] ? fileKey(installed.items[0].filename) : null;
        }
      });
    } catch (error) {
      if (mine !== installedTicket) return;
      update((next) => {
        next.content.installed.loading = false;
        next.content.installed.error = errorText(error);
      });
    }
  }

  /**
   * Load what the tab on screen shows unless it already answers this session and question. The
   * Installed list is read too, whatever the tab: the status bar and its tab count use it.
   *
   * Played now waits for a sweep to finish rather than asking again as each server arrives.
   */
  function ensureLoaded() {
    const asked = session();
    if (state.content.installed.loadedFor !== installedKey(asked) && !state.content.installed.loading) {
      void loadInstalled();
    }
    const { tab, playedNow, loadedFor } = state.content;
    if (tab === "installed") return;
    if (tab === "maps" && playedNow && state.browse?.running && loadedFor !== null) return;
    if (loadedFor !== queryKey(asked, state.content)) void load(false);
  }

  function setTab(tab) {
    if (!TABS.includes(tab) || tab === state.content.tab) return;
    update((next) => {
      next.content.tab = tab;
      next.content.loadedFor = null;
      next.content.items = [];
      next.content.selected = null;
      if (tab === "mods" && next.content.sort === "played") next.content.sort = "popular";
    });
    if (tab === "installed") void loadInstalled();
  }

  function search(query) {
    if (query === state.content.query) return;
    update((next) => (next.content.query = query));
    if (state.content.tab === "installed" || state.content.playedNow) return;
    void load(false);
  }

  function setSort(sort) {
    const allowed = state.content.playedNow && state.content.tab === "maps" ? PLAYED_SORTS : SORTS;
    if (!allowed.includes(sort) || sort === state.content.sort) return;
    update((next) => (next.content.sort = sort));
    if (!state.content.playedNow) void load(false);
  }

  function setMode(mode) {
    if ((mode !== null && !MODES.includes(mode)) || mode === state.content.mode) return;
    update((next) => (next.content.mode = mode));
    if (!state.content.playedNow) void load(false);
  }

  /** Played now lists by players; turning it off goes back to moh-db's order. */
  function togglePlayedNow() {
    update((next) => {
      next.content.playedNow = !next.content.playedNow;
      next.content.sort = next.content.playedNow ? "played" : "popular";
    });
    void load(false);
  }

  function loadMore() {
    if (state.content.loading || !state.content.hasMore) return;
    void load(true);
  }

  function refresh() {
    void load(false, true);
  }

  /** Something outside this section wrote to the game folder: ask again what is installed. */
  function forget() {
    update((next) => {
      next.content.loadedFor = null;
      next.content.installed.loadedFor = null;
    });
  }

  function select(id) {
    const installed = state.content.tab === "installed";
    const current = installed ? state.content.installed.selected : state.content.selected;
    if (current === id) return;
    update((next) => {
      if (installed) next.content.installed.selected = id;
      else next.content.selected = id;
    });
  }

  /** Install `item`; resolves to whether it is installed now. */
  async function install(item) {
    if (!item?.file || item.state !== "available" || state.content.installs.has(item.id)) return false;
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
        next.content.installed.loadedFor = null;
      });
      return outcome.state === "installed";
    } catch (error) {
      const reason = errorText(error);
      if (reason !== CANCELLED) update((next) => next.content.failures.set(item.id, reason));
      return false;
    } finally {
      update((next) => next.content.installs.delete(item.id));
    }
  }

  /**
   * Install the map, then join `row` the way its server row would: the server is asked again, so
   * its join is judged against the folder the map just went into. Joining needs nothing installed
   * when the game already has the map.
   */
  async function installAndJoin(item, row, join) {
    const ready = item.state === "installed" || item.state === "present" || (await install(item));
    if (ready) join(row);
  }

  function cancel(item) {
    if (!state.content.installs.has(item.id)) return;
    void cancelCatalogueInstall(item.id).catch(() => {});
  }

  /**
   * Delete the package Reveille installed as `entry.filename`, from Installed or from a Maps or
   * Mods entry. Rust refuses a file that changed since.
   */
  async function remove(entry) {
    const key = entry && fileKey(entry.filename);
    if (!entry || state.content.installed.removing.has(key)) return;
    update((next) => {
      next.content.installed.removing.add(key);
      next.content.installed.failures.delete(key);
    });
    try {
      const outcome = await removeInstalledItem(session(), entry.filename);
      update((next) => {
        const list = next.content.installed;
        list.items = list.items.filter((known) => fileKey(known.filename) !== key);
        list.totalSize = list.items.reduce((sum, known) => sum + known.size, 0);
        if (list.selected === key) list.selected = list.items[0] ? fileKey(list.items[0].filename) : null;
        for (const known of next.content.items) {
          if (known.file && fileKey(known.file.filename) === fileKey(outcome.filename)) known.state = outcome.state;
        }
      });
    } catch (error) {
      update((next) => next.content.installed.failures.set(key, errorText(error)));
    } finally {
      update((next) => next.content.installed.removing.delete(key));
    }
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

  return {
    ensureLoaded,
    setTab,
    search,
    setSort,
    setMode,
    togglePlayedNow,
    loadMore,
    refresh,
    forget,
    select,
    install,
    installAndJoin,
    cancel,
    remove,
    requestImage,
    showImage,
    openLink,
  };
}
