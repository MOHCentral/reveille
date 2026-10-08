// SPDX-License-Identifier: GPL-3.0-only

// Maps & mods: toolbar, cards or list, detail pane and status bar, for the Maps, Mods and Installed
// tabs.
//
// moh-db is credited where a player decides: the detail pane links to the entry's own page, and the
// status bar names the source on every screen of this section. Both open the default browser.
//
// Cards and list are two drawings of the same entries, selection and actions, so switching between
// them loses nothing. Install sits on every card and row, so it is one click either way. Installed
// is always a list: it holds files on disk, not things to browse.

import { closeDialog, openDialog } from "../../lib/dialog.js";
import { el, fill, preserveFocus } from "../../lib/dom.js";
import { bytes, plural, roundTrip } from "../../lib/format.js";
import { icon } from "../../lib/icons.js";
import { openMenu } from "../../lib/menu.js";
import { preferences, setPreference } from "../../lib/preferences.js";
import { state, update } from "../../lib/store.js";
import {
  MODE_LABELS,
  SORT_LABELS,
  TAB_LABELS,
  addedText,
  byline,
  liveText,
  progressText,
  stateExplanation,
  stateNote,
} from "./format.js";
import { liveSummary, runningOn, selectedInstalled, selectedItem, visibleItems } from "./selectors.js";
import { MODES, PLAYED_SORTS, SORTS, TABS } from "./state.js";

const MOH_DB = { maps: "https://www.moh-db.com/maps", mods: "https://www.moh-db.com/mods" };
const SEARCH_DELAY_MS = 350;
const PLACEHOLDERS = {
  maps: "Search maps on moh-db",
  mods: "Search mods on moh-db",
  installed: "Search what Reveille installed",
};

export function contentView({ controller, onShowServer, onJoinServer, onToggleDetail }) {
  let searchTimer = null;
  const search = el("input", {
    id: "content-search",
    type: "search",
    autocomplete: "off",
    spellcheck: false,
    placeholder: PLACEHOLDERS.maps,
    title: "Search (Ctrl+F or /)",
    "aria-label": PLACEHOLDERS.maps,
    oninput: (event) => {
      clearTimeout(searchTimer);
      const query = event.target.value;
      // A browse search is a request to moh-db, so wait for a pause in the typing.
      const local = state.content.tab === "installed" || (state.content.tab === "maps" && state.content.playedNow);
      if (local) controller.search(query);
      else searchTimer = setTimeout(() => controller.search(query), SEARCH_DELAY_MS);
    },
  });

  const tabButtons = TABS.map((tab) =>
    el(
      "button",
      {
        type: "button",
        className: "scope__option",
        "aria-pressed": "false",
        dataset: { tab, focusKey: `content-tab-${tab}` },
        onclick: () => {
          clearTimeout(searchTimer);
          search.value = state.content.query;
          controller.setTab(tab);
        },
      },
      el("span", { className: "scope__label" }, TAB_LABELS[tab]),
      el("span", { className: "scope__count data" }),
    ),
  );
  const tabs = el("div", { className: "scope content-tabs", role: "group", "aria-label": "What to list" }, tabButtons);

  const chip = (focusKey, onclick, extra = {}) =>
    el("button", { type: "button", className: "filter-chip", dataset: { focusKey }, onclick, ...extra });
  const modeChip = chip(
    "content-mode",
    (event) =>
      openMenu(
        [
          { label: "Every mode", checked: state.content.mode === null, onSelect: () => controller.setMode(null) },
          { separator: true },
          ...MODES.map((mode) => ({
            label: MODE_LABELS[mode],
            checked: state.content.mode === mode,
            onSelect: () => controller.setMode(mode),
          })),
        ],
        event,
        modeChip,
      ),
    { "aria-haspopup": "menu", title: "Only maps of one game mode" },
  );
  const playedChip = chip("content-played", () => controller.togglePlayedNow(), {
    title: "Only the maps servers in your list are running now",
  });
  const sortChip = chip(
    "content-sort",
    (event) =>
      openMenu(
        sortChoices().map((sort) => ({
          label: SORT_LABELS[sort],
          checked: state.content.sort === sort,
          onSelect: () => controller.setSort(sort),
        })),
        event,
        sortChip,
      ),
    { "aria-haspopup": "menu", title: "Order of the list" },
  );
  const filters = el("div", { className: "filters", role: "group", "aria-label": "Filters and order" }, modeChip, playedChip, sortChip);

  const layoutButton = (layout, label, glyph) =>
    el(
      "button",
      {
        type: "button",
        className: "scope__option",
        "aria-pressed": "false",
        "aria-label": label,
        title: label,
        dataset: { layout, focusKey: `layout-${layout}` },
        onclick: () => {
          setPreference("contentLayout", layout);
          update(() => {});
        },
      },
      icon(glyph, { className: "scope__icon" }),
    );
  const layoutButtons = [layoutButton("list", "List", "list"), layoutButton("cards", "Cards", "cards")];
  const layoutSwitch = el(
    "div",
    { className: "scope layout-switch", role: "group", "aria-label": "Layout" },
    layoutButtons,
  );

  const detailToggle = el(
    "button",
    {
      type: "button",
      className: "btn btn--icon toolbar__pane",
      dataset: { focusKey: "content-detail-toggle" },
      "aria-label": "Details",
      onclick: onToggleDetail,
    },
    el("span", { className: "toolbar__pane-glyph", "aria-hidden": "true" }),
  );

  const toolbar = el(
    "div",
    { className: "toolbar toolbar--content" },
    tabs,
    el(
      "label",
      { className: "field toolbar__search", for: "content-search" },
      el("span", { className: "field__icon", "aria-hidden": "true" }, "⌕"),
      search,
    ),
    filters,
    el("span", { className: "toolbar__spacer" }),
    el("div", { className: "toolbar__action" }, layoutSwitch, detailToggle),
  );

  const items = el("div", {
    className: "catalogue",
    role: "listbox",
    "aria-label": "Maps on moh-db",
    onkeydown: onItemsKey,
  });
  const after = el("div", { className: "catalogue__after" });
  const liveHead = el("span", null, "On servers now");
  const listHead = el(
    "div",
    { className: "catalogue-head", "aria-hidden": "true" },
    el("span"),
    el("span", null, "Name"),
    el("span", { className: "catalogue-head__num" }, "Size"),
    liveHead,
    el("span"),
  );
  const listPane = el("div", { className: "list-pane content-pane" }, listHead, items, after);
  const detail = el("aside", { className: "detail-pane hidden", "aria-label": "Selected entry" });
  const statusbar = el("div", { className: "statusbar" });

  // One node per entry and drawing, reused across paints: progress arrives several times a second
  // during a download, and rebuilding a page of screenshots on each would make them flicker.
  const nodes = new Map();
  let paintedShape = null;
  let paintedDetail = null;

  const tab = () => state.content.tab;
  const layout = () => preferences().contentLayout;
  const shape = () => (tab() === "installed" ? "installed" : layout());
  const playedNow = () => tab() === "maps" && state.content.playedNow;
  const sortChoices = () => (playedNow() ? PLAYED_SORTS : SORTS);

  function itemNode(item, drawing) {
    const key = `${drawing}:${item.id}`;
    let node = nodes.get(key);
    if (!node) {
      node = drawing === "cards" ? cardNode(item) : drawing === "installed" ? installedNode(item) : rowNode(item);
      node.dataset.id = String(item.id);
      node.addEventListener("click", (event) => {
        if (event.target.closest("button")) return;
        controller.select(item.id);
      });
      nodes.set(key, node);
    }
    return node;
  }

  function cardNode(item) {
    return el(
      "div",
      { className: "card", role: "option", tabIndex: -1 },
      el("span", { className: "card__thumb thumb" }),
      el(
        "div",
        { className: "card__body" },
        el("span", { className: "item-name", title: item.title }, item.title),
        el("span", { className: "item-sub" }, byline(item) || " "),
        el("div", { className: "card__live" }),
        el(
          "div",
          { className: "card__foot" },
          el("span", { className: "data quiet" }, item.file ? bytes(item.file.size) : ""),
          el("span", { className: "item-action" }),
        ),
      ),
    );
  }

  function rowNode(item) {
    return el(
      "div",
      { className: "catalogue-row", role: "option", tabIndex: -1 },
      el("span", { className: "catalogue-row__thumb thumb" }),
      el(
        "span",
        { className: "catalogue-row__name" },
        el("span", { className: "item-name", title: item.title }, item.title),
        el("span", { className: "item-sub" }, byline(item)),
      ),
      el("span", { className: "catalogue-row__size data" }, item.file ? bytes(item.file.size) : "—"),
      el("span", { className: "catalogue-row__live" }),
      el("span", { className: "item-action" }),
    );
  }

  function installedNode(entry) {
    return el(
      "div",
      { className: "catalogue-row catalogue-row--installed", role: "option", tabIndex: -1 },
      el(
        "span",
        { className: "catalogue-row__thumb thumb thumb--empty" },
        el("span", { className: "thumb__name" }, entry.filename),
      ),
      el(
        "span",
        { className: "catalogue-row__name" },
        el("span", { className: "item-name", title: entry.title }, entry.title, entry.kind === "mod" && modBadge()),
        el("span", { className: "item-sub" }, entry.filename),
      ),
      el("span", { className: "catalogue-row__size data" }, bytes(entry.size)),
      el("span", { className: "catalogue-row__live data" }, addedText(entry.installed_at) ?? "—"),
      el("span", { className: "item-action" }),
    );
  }

  // Installed mixes maps and mods; the Mods tab needs no badge to say what every row is.
  const modBadge = () => el("span", { className: "kind-badge" }, "Mod");

  /** Write what changes after an entry is drawn: selection, screenshot, servers and action. */
  function paintItem(node, item) {
    const selected = state.content.selected === item.id;
    node.setAttribute("aria-selected", selected ? "true" : "false");
    paintThumb(node.querySelector(".thumb"), item, 0);
    const liveSlot = node.querySelector(".card__live, .catalogue-row__live");
    const live = item.kind === "mod" ? null : liveText(liveSummary(runningOn(item)));
    const signature = item.kind === "mod" ? `mod:${item.version ?? ""}` : (live ?? "none");
    if (liveSlot.dataset.signature !== signature) {
      liveSlot.dataset.signature = signature;
      if (item.kind === "mod") {
        fill(liveSlot, el("span", { className: "quiet" }, item.version ? `Version ${item.version}` : "—"));
      } else {
        fill(
          liveSlot,
          live
            ? el("span", { className: "live" }, el("span", { className: "ping-dot ping-dot--good" }), live)
            : el("span", { className: "quiet" }, node.classList.contains("card") ? "Not on a server now" : "—"),
        );
      }
    }
    paintAction(node.querySelector(".item-action"), item, true);
  }

  function paintInstalled(node, entry) {
    const { selected, removing, failures } = state.content.installed;
    node.setAttribute("aria-selected", selected === entry.id ? "true" : "false");
    const slot = node.querySelector(".item-action");
    const signature = `${removing.has(entry.id)}:${entry.changed}:${failures.get(entry.id) ?? ""}`;
    if (slot.dataset.signature === signature) return;
    slot.dataset.signature = signature;
    if (entry.changed) {
      fill(slot, el("span", { className: "state-note", title: "This file changed since Reveille installed it, so Reveille will not delete it." }, "Changed"));
      return;
    }
    fill(slot, removeButton(entry, true));
  }

  function removeButton(entry, compact) {
    const busy = state.content.installed.removing.has(entry.id);
    return el(
      "button",
      {
        type: "button",
        className: compact ? "btn btn--sm" : "btn",
        tabIndex: compact ? -1 : 0,
        disabled: busy,
        dataset: compact ? null : { focusKey: "content-remove" },
        title: `Delete ${entry.filename} from your game folder`,
        onclick: () => {
          controller.select(entry.id);
          confirmRemove(entry);
        },
      },
      busy ? "Removing…" : "Remove",
    );
  }

  function confirmRemove(entry) {
    openDialog(
      `Remove ${entry.title}?`,
      el("p", null, `Reveille deletes ${entry.filename} from your game folder. You can install it again from Maps & mods.`),
      el(
        "div",
        { className: "actions__row" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn--primary",
            dataset: { focusKey: "content-remove-confirm" },
            onclick: () => {
              closeDialog();
              void controller.remove(entry);
            },
          },
          "Remove",
        ),
      ),
    );
  }

  function paintThumb(thumb, item, index) {
    controller.requestImage(item, index);
    const image = state.content.images.get(`${item.id}:${index}`);
    const ready = typeof image === "string" && image.startsWith("data:");
    const signature = ready ? `${item.id}:${index}` : `none:${item.id}`;
    if (thumb.dataset.signature === signature) return;
    thumb.dataset.signature = signature;
    thumb.classList.toggle("thumb--empty", !ready);
    fill(
      thumb,
      ready
        ? el("img", { src: image, alt: "", decoding: "async", draggable: false })
        : el("span", { className: "thumb__name" }, item.map_name ?? item.title),
    );
  }

  /** Install, its progress with Cancel, or what the entry's state says instead. */
  function paintAction(slot, item, compact) {
    const install = state.content.installs.get(item.id);
    const failure = state.content.failures.get(item.id);
    const signature = install
      ? `run:${install.confirming}:${Math.round((install.received / Math.max(1, install.total)) * 200)}`
      : `${item.state}:${failure ?? ""}`;
    if (slot.dataset.signature === signature) return;
    slot.dataset.signature = signature;
    if (install) {
      const share = install.confirming ? 1 : install.received / Math.max(1, install.total);
      fill(
        slot,
        el(
          "span",
          { className: "row-progress" },
          el(
            "span",
            { className: "row-progress__head" },
            el("span", null, progressText(install)),
            !install.confirming &&
              el(
                "button",
                {
                  type: "button",
                  className: compact ? "row-progress__cancel" : "btn btn--sm",
                  title: "Stop this download",
                  "aria-label": `Stop downloading ${item.title}`,
                  tabIndex: compact ? -1 : 0,
                  dataset: compact ? null : { focusKey: "content-cancel" },
                  onclick: () => controller.cancel(item),
                },
                compact ? "✕" : "Cancel",
              ),
          ),
          el(
            "span",
            {
              className: `meter${install.confirming ? " meter--indeterminate" : ""}`,
              role: "progressbar",
              "aria-label": `Downloading ${item.title}`,
              "aria-valuemin": "0",
              "aria-valuemax": "100",
              "aria-valuenow": String(Math.round(share * 100)),
            },
            el("span", { className: "meter__fill", style: `width:${Math.round(share * 100)}%` }),
          ),
        ),
      );
      return;
    }
    // A mod Reveille cannot install still has a way forward: its page, with its author's notes.
    if (item.state === "unavailable" && item.kind === "mod") {
      fill(
        slot,
        el(
          "button",
          {
            type: "button",
            className: "btn btn--sm",
            tabIndex: -1,
            title: "This mod needs installing by hand. Opens its page on moh-db.com in your browser.",
            onclick: () => {
              controller.select(item.id);
              controller.openLink(item.page_url);
            },
          },
          "moh-db ↗",
        ),
      );
      return;
    }
    const note = stateNote(item.state);
    if (note) {
      fill(slot, el("span", { className: `state-note state-note--${item.state}` }, note));
      return;
    }
    fill(
      slot,
      el(
        "button",
        {
          type: "button",
          className: `btn btn--sm${failure ? " btn--retry" : ""}`,
          tabIndex: -1,
          title: failure ? `The last try failed: ${failure}` : `Install ${item.title} into your game folder`,
          onclick: () => {
            controller.select(item.id);
            void controller.install(item);
          },
        },
        compact && failure ? "Try again" : "Install",
      ),
    );
  }

  /** The entries on screen: what the tab lists, with Installed searched here. */
  function listed() {
    if (tab() !== "installed") return visibleItems();
    const needle = state.content.query.trim().toLowerCase();
    return state.content.installed.items.filter(
      (entry) => !needle || entry.title.toLowerCase().includes(needle) || entry.filename.toLowerCase().includes(needle),
    );
  }

  function paintList() {
    const drawing = shape();
    const list = listed();
    if (paintedShape !== drawing) {
      paintedShape = drawing;
      items.className = drawing === "cards" ? "catalogue catalogue--cards" : "catalogue catalogue--list";
    }
    items.setAttribute("aria-label", { maps: "Maps on moh-db", mods: "Mods on moh-db", installed: "Installed by Reveille" }[tab()]);
    liveHead.textContent = { maps: "On servers now", mods: "Version", installed: "Installed" }[tab()];
    listHead.classList.toggle("hidden", drawing === "cards" || !list.length);
    const wanted = list.map((item) => itemNode(item, drawing));
    const current = [...items.children];
    if (current.length !== wanted.length || current.some((node, index) => node !== wanted[index])) {
      preserveFocus(items, () => items.replaceChildren(...wanted));
    }
    if (drawing === "installed") list.forEach((entry, index) => paintInstalled(wanted[index], entry));
    else list.forEach((item, index) => paintItem(wanted[index], item));
    syncTabStop();
    paintAfter(list);
  }

  function syncTabStop() {
    const children = [...items.children];
    const selected = children.find((node) => node.getAttribute("aria-selected") === "true");
    const tabbable = selected ?? children[0] ?? null;
    for (const node of children) {
      node.tabIndex = node === tabbable ? 0 : -1;
      for (const control of node.querySelectorAll("button")) control.tabIndex = -1;
    }
    items.tabIndex = tabbable ? -1 : 0;
  }

  function placeholder(title, text, action) {
    return el("div", { className: "placeholder" }, el("h3", { className: "display" }, title), el("p", null, text), action);
  }

  function paintAfter(list) {
    if (tab() === "installed") {
      const { loading, error, items: all } = state.content.installed;
      if (error) fill(after, placeholder("Reveille could not read what it installed", `${error}.`));
      else if (loading && !all.length) fill(after, el("p", { className: "catalogue__loading quiet" }, "Reading your game folder…"));
      else if (!all.length) {
        fill(after, placeholder("Nothing installed yet", "Maps and mods you install from Maps & mods are listed here, so you can remove them later."));
      } else if (!list.length) fill(after, placeholder("Nothing matches this search", "Search looks at names and file names."));
      else after.replaceChildren();
      return;
    }
    const { loading, error, hasMore, query } = state.content;
    const noun = tab() === "mods" ? "mod" : "map";
    if (error) {
      fill(
        after,
        placeholder(
          "moh-db could not be reached",
          `Reveille could not load the ${noun} list: ${error}.`,
          el("button", { type: "button", className: "btn", onclick: () => controller.refresh() }, "Try again"),
        ),
      );
    } else if (loading) {
      const text = playedNow() ? "Looking up the maps servers are running…" : list.length ? `Loading more ${noun}s…` : `Loading ${noun}s from moh-db…`;
      fill(after, el("p", { className: "catalogue__loading quiet" }, text));
    } else if (!list.length && playedNow()) {
      fill(
        after,
        state.servers.length
          ? placeholder(
              "No custom map is being played",
              state.content.items.length
                ? "No map played now matches this search or mode."
                : "The servers in your list are running maps that come with the game, or ones moh-db does not list.",
            )
          : placeholder("No servers listed", "Find servers first: Played now lists the custom maps they are running."),
      );
    } else if (!list.length) {
      const searched = query.trim() || (tab() === "maps" && state.content.mode);
      fill(
        after,
        searched
          ? placeholder(
              `No ${noun} matches this search`,
              tab() === "maps"
                ? "moh-db searches map titles, or map names when the search has a slash, such as dm/stalingrad."
                : "moh-db searches mod titles.",
            )
          : placeholder(`No ${noun}s listed`, "moh-db returned an empty list."),
      );
    } else if (hasMore) {
      fill(
        after,
        el(
          "button",
          { type: "button", className: "btn catalogue__more", dataset: { focusKey: "content-more" }, onclick: () => controller.loadMore() },
          `Show more ${noun}s`,
        ),
      );
    } else {
      after.replaceChildren();
    }
  }

  function paintDetail() {
    if (tab() === "installed") {
      paintInstalledDetail();
      return;
    }
    const item = selectedItem();
    if (!item) {
      paintEmptyDetail(`Select a ${tab() === "mods" ? "mod" : "map"} to see its details.`);
      return;
    }
    const index = Math.min(state.content.shown.get(item.id) ?? 0, Math.max(0, item.image_count - 1));
    controller.requestImage(item, index);
    const running = item.kind === "mod" ? [] : runningOn(item);
    const install = state.content.installs.get(item.id);
    const signature = JSON.stringify([
      item.id,
      item.state,
      index,
      state.content.images.get(`${item.id}:${index}`)?.length ?? 0,
      install ? [install.confirming, Math.round((install.received / Math.max(1, install.total)) * 200)] : null,
      state.content.failures.get(item.id) ?? null,
      running.map((row) => [row.address, row.server.occupancy?.clients_reported, row.server.status_round_trip]),
      state.joining,
    ]);
    if (signature === paintedDetail) return;
    paintedDetail = signature;
    preserveFocus(detail, () => fill(detail, el("div", { className: "detail-pane__scroll" }, ...detailBody(item, index, running))));
  }

  function paintEmptyDetail(text) {
    if (paintedDetail === text) return;
    paintedDetail = text;
    fill(
      detail,
      el("div", { className: "detail-pane__scroll" }, el("div", { className: "placeholder" }, el("p", { className: "quiet" }, text))),
    );
  }

  function pageLink(url, text) {
    return el(
      "a",
      {
        className: "ext-link",
        href: url,
        title: "Opens moh-db.com in your browser",
        dataset: { focusKey: "moh-db-page" },
        onclick: (event) => {
          event.preventDefault();
          controller.openLink(url);
        },
      },
      text,
    );
  }

  function detailBody(item, index, running) {
    const preview = el("div", { className: "preview thumb" });
    paintThumb(preview, item, index);
    if (item.image_count > 1) {
      preview.append(
        el(
          "span",
          { className: "preview__nav" },
          el("button", { type: "button", className: "preview__step", "aria-label": "Previous screenshot", dataset: { focusKey: "shot-prev" }, onclick: () => controller.showImage(item, -1) }, "‹"),
          el("span", { className: "preview__count" }, `${index + 1} of ${item.image_count} screenshots`),
          el("button", { type: "button", className: "preview__step", "aria-label": "Next screenshot", dataset: { focusKey: "shot-next" }, onclick: () => controller.showImage(item, 1) }, "›"),
        ),
      );
    }
    const mod = item.kind === "mod";
    const facts = [
      ["Size", item.file ? bytes(item.file.size) : "—"],
      mod && item.mod_type && ["Type", item.mod_type],
      mod && item.version && ["Version", item.version],
      item.modes && ["Mode", item.modes],
      item.theme && ["Theme", item.theme],
      item.size_class && ["Map size", item.size_class],
      ["Downloads", item.downloads.toLocaleString()],
      addedText(item.added) && ["Added", addedText(item.added)],
    ].filter(Boolean);
    const failure = state.content.failures.get(item.id);
    const install = state.content.installs.get(item.id);
    const action = el("div", { className: "actions__row" });
    if (install) {
      const slot = el("span", { className: "item-action item-action--pane" });
      paintAction(slot, item, false);
      action.append(slot);
    } else if (item.state === "available") {
      action.append(
        el(
          "button",
          {
            type: "button",
            className: "btn btn--primary",
            dataset: { focusKey: "content-install" },
            onclick: () => void controller.install(item),
          },
          failure ? `Try again · ${bytes(item.file.size)}` : `Install · ${bytes(item.file.size)}`,
        ),
      );
    } else if (mod && item.state === "unavailable") {
      action.append(
        el(
          "button",
          {
            type: "button",
            className: "btn",
            dataset: { focusKey: "content-mod-page" },
            onclick: () => controller.openLink(item.page_url),
          },
          "Download from moh-db ↗",
        ),
      );
    } else {
      action.append(el("span", { className: `state-note state-note--${item.state}` }, stateNote(item.state)));
    }
    const notes = mod && item.install_notes;
    return [
      preview,
      el(
        "div",
        { className: "detail__head content-head" },
        el("h2", { className: "display pane-title" }, item.title),
        byline(item) && el("div", { className: "pane-sub" }, mod ? "Mod " : item.author ? "Custom map " : "", byline(item)),
        pageLink(item.page_url, mod ? "Screenshots, versions and comments on moh-db ↗" : "More screenshots, versions and comments on moh-db ↗"),
      ),
      el(
        "dl",
        { className: "facts" },
        facts.map(([label, value]) => el("div", { className: "fact" }, el("dt", null, label), el("dd", { title: value }, value))),
      ),
      el(
        "div",
        { className: "actions" },
        action,
        failure && !install && el("p", { className: "note note--bad" }, `The last try failed: ${failure}`),
        el("p", { className: "quiet" }, stateExplanation(item.state, item.kind)),
        mod && item.state === "unavailable" && item.archive_name && el("p", { className: "quiet data" }, `Download: ${item.archive_name}`),
      ),
      mod && item.requires && textSection("Needs", item.requires),
      notes && textSection("Install notes", notes),
      !mod && runningSection(item, running),
      item.description && textSection(mod ? "About" : null, item.description),
    ];
  }

  function textSection(heading, text) {
    return el(
      "div",
      { className: "detail__section" },
      heading && el("h3", { className: "display heading-sm" }, heading),
      text.split("\n").map((line) => el("p", { className: "pane-text" }, line)),
    );
  }

  /**
   * The servers running this map, each with the one step that gets the player in: Join once the
   * game has the map, Install and join while it does not, and Show when Reveille cannot install it.
   */
  function runningSection(item, running) {
    return el(
      "div",
      { className: "detail__section" },
      el("h3", { className: "display heading-sm" }, "Running now"),
      running.length
        ? el(
            "div",
            { className: "mini-list" },
            running.slice(0, 6).map((row) => {
              const ping = roundTrip(row.server);
              const players = row.server.occupancy?.clients_reported ?? 0;
              const capacity = row.server.client_capacity;
              return el(
                "div",
                { className: "mini-row" },
                el("span", { className: "truncate", title: row.server.hostname }, row.server.hostname),
                el("span", { className: "data" }, `${capacity ? `${players}/${capacity}` : players} · ${ping.text}`),
                serverAction(item, row),
              );
            }),
            running.length > 6 && el("p", { className: "quiet" }, `and ${plural(running.length - 6, "more server")}`),
          )
        : el(
            "p",
            { className: "quiet" },
            state.servers.length ? "No server in your list is running it now." : "Find servers to see which ones are running it.",
          ),
    );
  }

  function serverAction(item, row) {
    const has = item.state === "installed" || item.state === "present";
    const installable = item.state === "available";
    if (!has && !installable) {
      return el(
        "button",
        { type: "button", className: "btn btn--sm", title: "Show this server in the server list", onclick: () => onShowServer(row.address) },
        "Show",
      );
    }
    const busy = state.joining || state.content.installs.has(item.id);
    return el(
      "button",
      {
        type: "button",
        className: "btn btn--sm",
        disabled: busy,
        title: has ? "Join this server" : `Install ${item.title}, then join this server`,
        onclick: () => void controller.installAndJoin(item, row, onJoinServer),
      },
      has ? "Join" : "Install and join",
    );
  }

  function paintInstalledDetail() {
    const entry = selectedInstalled();
    if (!entry) {
      paintEmptyDetail(state.content.installed.items.length ? "Select an install to see its details." : "Nothing installed yet.");
      return;
    }
    const { removing, failures } = state.content.installed;
    const signature = JSON.stringify(["installed", entry, removing.has(entry.id), failures.get(entry.id) ?? null]);
    if (signature === paintedDetail) return;
    paintedDetail = signature;
    const failure = failures.get(entry.id);
    const facts = [
      ["Size", bytes(entry.size)],
      ["Installed", addedText(entry.installed_at) ?? "—"],
      ["Kind", entry.kind === "mod" ? "Mod" : "Map"],
    ];
    preserveFocus(detail, () =>
      fill(
        detail,
        el(
          "div",
          { className: "detail-pane__scroll" },
          el(
            "div",
            { className: "detail__head content-head" },
            el("h2", { className: "display pane-title" }, entry.title),
            el("div", { className: "pane-sub data" }, entry.filename),
            entry.page_url && pageLink(entry.page_url, "Its page on moh-db ↗"),
          ),
          el(
            "dl",
            { className: "facts" },
            facts.map(([label, value]) => el("div", { className: "fact" }, el("dt", null, label), el("dd", { title: value }, value))),
          ),
          el(
            "div",
            { className: "actions" },
            el("div", { className: "actions__row" }, entry.changed ? el("span", { className: "state-note" }, "Changed since Reveille installed it") : removeButton(entry, false)),
            failure && el("p", { className: "note note--bad" }, failure),
            el(
              "p",
              { className: "quiet" },
              entry.changed
                ? "This file is not the one Reveille wrote any more, so Reveille will not delete it. Delete it yourself if you no longer want it."
                : "Remove deletes this file from your game folder, after checking it is still the one Reveille wrote.",
            ),
          ),
        ),
      ),
    );
  }

  function paintToolbar() {
    const current = tab();
    if (document.activeElement !== search && search.value !== state.content.query) search.value = state.content.query;
    search.placeholder = PLACEHOLDERS[current];
    search.setAttribute("aria-label", PLACEHOLDERS[current]);
    const counts = {
      maps: state.content.totals.maps,
      mods: state.content.totals.mods,
      installed: state.content.installed.loadedFor === null ? null : state.content.installed.items.length,
    };
    for (const button of tabButtons) {
      const id = button.dataset.tab;
      button.setAttribute("aria-pressed", id === current ? "true" : "false");
      const count = counts[id];
      button.querySelector(".scope__count").textContent = count === null || count === undefined ? "" : count.toLocaleString();
    }
    const maps = current === "maps";
    modeChip.classList.toggle("hidden", !maps);
    playedChip.classList.toggle("hidden", !maps);
    sortChip.classList.toggle("hidden", current === "installed");
    setChip(modeChip, state.content.mode !== null, state.content.mode ? MODE_LABELS[state.content.mode] : "Mode", true);
    setChip(playedChip, playedNow(), "Played now", false);
    playedChip.setAttribute("aria-pressed", playedNow() ? "true" : "false");
    setChip(sortChip, false, SORT_LABELS[state.content.sort] ?? SORT_LABELS.popular, true);
    layoutSwitch.classList.toggle("hidden", current === "installed");
    for (const button of layoutButtons) {
      button.setAttribute("aria-pressed", button.dataset.layout === layout() ? "true" : "false");
    }
    const collapsed = state.detailCollapsed;
    detailToggle.setAttribute("aria-pressed", collapsed ? "false" : "true");
    detailToggle.title = collapsed ? "Show details (Ctrl+D)" : "Hide details (Ctrl+D)";
  }

  function paintStatus() {
    const current = tab();
    const { total, installs, installed } = state.content;
    const source = current === "mods" ? MOH_DB.mods : MOH_DB.maps;
    const shown = listed().length;
    fill(
      statusbar,
      el(
        "a",
        {
          className: "ext-link statusbar__source",
          href: source,
          title: "Opens moh-db.com in your browser",
          onclick: (event) => {
            event.preventDefault();
            controller.openLink(source);
          },
        },
        "Maps and mods from moh-db.com ↗",
      ),
      current !== "installed" && total !== null && !playedNow() && el("span", null, el("strong", null, total.toLocaleString()), " available"),
      installed.loadedFor !== null && el("span", null, el("strong", null, installed.items.length.toLocaleString()), " installed"),
      installs.size > 0 && el("span", null, el("strong", null, String(installs.size)), " downloading"),
      el("span", { className: "statusbar__spacer" }),
      current !== "installed" && shown > 0 && total !== null && !playedNow() && el("span", null, `Showing ${shown.toLocaleString()} of ${total.toLocaleString()}`),
      playedNow() && shown > 0 && el("span", null, `${plural(shown, "custom map")} played now`),
      installed.loadedFor !== null && installed.items.length > 0 && el("span", null, `${bytes(installed.totalSize)} installed by Reveille`),
    );
  }

  function render() {
    paintToolbar();
    paintList();
    if (!state.detailCollapsed) paintDetail();
    paintStatus();
  }

  /**
   * Arrow keys move the selection; in cards, up and down move by a row of cards. Enter installs.
   * One tab stop for the whole set, like the server table.
   */
  function onItemsKey(event) {
    const children = [...items.children];
    if (!children.length) return;
    const installed = tab() === "installed";
    const selected = installed ? state.content.installed.selected : state.content.selected;
    const at = children.findIndex((node) => node.dataset.id === String(selected));
    const cards = shape() === "cards";
    const columns = cards ? columnsIn(children) : 1;
    const moves = {
      ArrowDown: columns,
      ArrowUp: -columns,
      ArrowRight: cards ? 1 : 0,
      ArrowLeft: cards ? -1 : 0,
    };
    let target = null;
    if (event.key in moves && moves[event.key] !== 0) target = Math.max(0, Math.min(children.length - 1, (at === -1 ? 0 : at + moves[event.key])));
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = children.length - 1;
    else if (event.key === "Enter" && at !== -1 && !installed) {
      event.preventDefault();
      const item = selectedItem();
      if (item) void controller.install(item);
      return;
    } else if (event.key === "Delete" && at !== -1 && installed) {
      event.preventDefault();
      const entry = selectedInstalled();
      if (entry && !entry.changed) confirmRemove(entry);
      return;
    }
    if (target === null) return;
    event.preventDefault();
    controller.select(Number(children[target].dataset.id));
    children[target].focus();
    children[target].scrollIntoView({ block: "nearest" });
  }

  return {
    toolbar,
    listPane,
    detail,
    statusbar,
    render,
    focusSearch: () => search.focus(),
    focusList: () => (items.querySelector('[tabindex="0"]') ?? items).focus(),
    clearSearch: () => {
      clearTimeout(searchTimer);
      search.value = "";
      controller.search("");
    },
  };
}

/** Write a chip's label and whether it is narrowing the list, in place, as the Servers chips do. */
function setChip(chip, active, label, menu) {
  chip.classList.toggle("filter-chip--on", active);
  const text = menu ? `${label} ▾` : label;
  if (chip.textContent !== text) chip.textContent = text;
}

function columnsIn(children) {
  const top = children[0].offsetTop;
  const index = children.findIndex((node) => node.offsetTop !== top);
  return index === -1 ? children.length : index;
}
