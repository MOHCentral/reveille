// SPDX-License-Identifier: GPL-3.0-only

// Maps & mods: toolbar, cards or list, detail pane and status bar.
//
// moh-db is credited where a player decides: the detail pane links to the map's own page, and the
// status bar names the source on every screen of this section. Both open the default browser.
//
// Cards and list are two drawings of the same entries, selection and actions, so switching between
// them loses nothing. Install sits on every card and row, so it is one click either way.

import { el, fill, preserveFocus } from "../../lib/dom.js";
import { bytes, plural, roundTrip } from "../../lib/format.js";
import { icon } from "../../lib/icons.js";
import { openMenu } from "../../lib/menu.js";
import { preferences, setPreference } from "../../lib/preferences.js";
import { state, update } from "../../lib/store.js";
import {
  SORT_LABELS,
  addedText,
  byline,
  liveText,
  progressText,
  stateExplanation,
  stateNote,
} from "./format.js";
import { liveSummary, runningOn, selectedItem } from "./selectors.js";
import { SORTS } from "./state.js";

const MOH_DB_MAPS = "https://www.moh-db.com/maps";
const SEARCH_DELAY_MS = 350;

export function contentView({ controller, onShowServer, onToggleDetail }) {
  let searchTimer = null;
  const search = el("input", {
    id: "content-search",
    type: "search",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Search maps on moh-db",
    title: "Search (Ctrl+F or /)",
    "aria-label": "Search maps on moh-db",
    oninput: (event) => {
      clearTimeout(searchTimer);
      const query = event.target.value;
      // Each search is a request to moh-db, so wait for a pause in the typing.
      searchTimer = setTimeout(() => controller.search(query), SEARCH_DELAY_MS);
    },
  });

  const sortChip = el("button", {
    type: "button",
    className: "filter-chip",
    dataset: { focusKey: "content-sort" },
    "aria-haspopup": "menu",
    title: "Order of the list",
    onclick: (event) =>
      openMenu(
        SORTS.map((sort) => ({
          label: SORT_LABELS[sort],
          checked: state.content.sort === sort,
          onSelect: () => controller.setSort(sort),
        })),
        event,
        sortChip,
      ),
  });

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
      "aria-label": "Map details",
      onclick: onToggleDetail,
    },
    el("span", { className: "toolbar__pane-glyph", "aria-hidden": "true" }),
  );

  const toolbar = el(
    "div",
    { className: "toolbar toolbar--content" },
    el(
      "label",
      { className: "field toolbar__search", for: "content-search" },
      el("span", { className: "field__icon", "aria-hidden": "true" }, "⌕"),
      search,
    ),
    el("div", { className: "filters", role: "group", "aria-label": "Order" }, sortChip),
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
  const listHead = el(
    "div",
    { className: "catalogue-head", "aria-hidden": "true" },
    el("span"),
    el("span", null, "Name"),
    el("span", { className: "catalogue-head__num" }, "Size"),
    el("span", null, "On servers now"),
    el("span"),
  );
  const listPane = el("div", { className: "list-pane content-pane" }, listHead, items, after);
  const detail = el("aside", { className: "detail-pane hidden", "aria-label": "Selected map" });
  const statusbar = el("div", { className: "statusbar" });

  // One node per entry and layout, reused across paints: progress arrives several times a second
  // during a download, and rebuilding a page of screenshots on each would make them flicker.
  const nodes = new Map();
  let paintedLayout = null;
  let paintedDetail = null;

  const layout = () => preferences().contentLayout;

  function itemNode(item, shape) {
    const key = `${shape}:${item.id}`;
    let node = nodes.get(key);
    if (!node) {
      node = shape === "cards" ? cardNode(item) : rowNode(item);
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
        el("span", { className: "item-sub" }, byline(item) || " "),
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

  /** Write what changes after an entry is drawn: selection, screenshot, servers and action. */
  function paintItem(node, item) {
    const selected = state.content.selected === item.id;
    node.setAttribute("aria-selected", selected ? "true" : "false");
    const thumb = node.querySelector(".thumb");
    paintThumb(thumb, item, 0);
    const live = liveText(liveSummary(runningOn(item)));
    const liveSlot = node.querySelector(".card__live, .catalogue-row__live");
    const liveSignature = live ?? "none";
    if (liveSlot.dataset.signature !== liveSignature) {
      liveSlot.dataset.signature = liveSignature;
      fill(
        liveSlot,
        live
          ? el("span", { className: "live" }, el("span", { className: "ping-dot ping-dot--good" }), live)
          : el("span", { className: "quiet" }, node.classList.contains("card") ? "Not on a server now" : "—"),
      );
    }
    paintAction(node.querySelector(".item-action"), item, true);
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

  function paintList() {
    const shape = layout();
    const list = state.content.items;
    if (paintedLayout !== shape) {
      paintedLayout = shape;
      items.className = shape === "cards" ? "catalogue catalogue--cards" : "catalogue catalogue--list";
    }
    listHead.classList.toggle("hidden", shape !== "list" || !list.length);
    const wanted = list.map((item) => itemNode(item, shape));
    const current = [...items.children];
    if (current.length !== wanted.length || current.some((node, index) => node !== wanted[index])) {
      preserveFocus(items, () => items.replaceChildren(...wanted));
    }
    list.forEach((item, index) => paintItem(wanted[index], item));
    syncTabStop();
    paintAfter();
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

  function paintAfter() {
    const { loading, error, hasMore, items: list, query } = state.content;
    if (error) {
      fill(
        after,
        el(
          "div",
          { className: "placeholder" },
          el("h3", { className: "display" }, "moh-db could not be reached"),
          el("p", null, `Reveille could not load the map list: ${error}.`),
          el("button", { type: "button", className: "btn", onclick: () => controller.refresh() }, "Try again"),
        ),
      );
    } else if (loading) {
      fill(after, el("p", { className: "catalogue__loading quiet" }, list.length ? "Loading more maps…" : "Loading maps from moh-db…"));
    } else if (!list.length) {
      fill(
        after,
        el(
          "div",
          { className: "placeholder" },
          el("h3", { className: "display" }, query.trim() ? "No map matches this search" : "No maps listed"),
          el("p", null, query.trim() ? "moh-db searches map titles, or map names when the search has a slash, such as dm/stalingrad." : "moh-db returned an empty list."),
        ),
      );
    } else if (hasMore) {
      fill(
        after,
        el(
          "button",
          { type: "button", className: "btn catalogue__more", dataset: { focusKey: "content-more" }, onclick: () => controller.loadMore() },
          "Show more maps",
        ),
      );
    } else {
      after.replaceChildren();
    }
  }

  function paintDetail() {
    const item = selectedItem();
    if (!item) {
      if (paintedDetail !== "empty") {
        paintedDetail = "empty";
        fill(
          detail,
          el(
            "div",
            { className: "detail-pane__scroll" },
            el("div", { className: "placeholder" }, el("p", { className: "quiet" }, "Select a map to see its details.")),
          ),
        );
      }
      return;
    }
    const index = Math.min(state.content.shown.get(item.id) ?? 0, Math.max(0, item.image_count - 1));
    controller.requestImage(item, index);
    const running = runningOn(item);
    const install = state.content.installs.get(item.id);
    const signature = JSON.stringify([
      item.id,
      item.state,
      index,
      state.content.images.get(`${item.id}:${index}`)?.length ?? 0,
      install ? [install.confirming, Math.round((install.received / Math.max(1, install.total)) * 200)] : null,
      state.content.failures.get(item.id) ?? null,
      running.map((row) => [row.address, row.server.occupancy?.clients_reported, row.server.status_round_trip]),
    ]);
    if (signature === paintedDetail) return;
    paintedDetail = signature;
    preserveFocus(detail, () => fill(detail, el("div", { className: "detail-pane__scroll" }, ...detailBody(item, index, running))));
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
    const facts = [
      ["Size", item.file ? bytes(item.file.size) : "—"],
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
    } else {
      action.append(el("span", { className: `state-note state-note--${item.state}` }, stateNote(item.state)));
    }
    return [
      preview,
      el(
        "div",
        { className: "detail__head content-head" },
        el("h2", { className: "display pane-title" }, item.title),
        byline(item) && el("div", { className: "pane-sub" }, item.author ? "Custom map " : "", byline(item)),
        el(
          "a",
          {
            className: "ext-link",
            href: item.page_url,
            title: "Opens moh-db.com in your browser",
            dataset: { focusKey: "moh-db-page" },
            onclick: (event) => {
              event.preventDefault();
              controller.openLink(item.page_url);
            },
          },
          "More screenshots, versions and comments on moh-db ↗",
        ),
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
        el("p", { className: "quiet" }, stateExplanation(item.state)),
      ),
      el(
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
                  el(
                    "button",
                    {
                      type: "button",
                      className: "btn btn--sm",
                      title: "Show this server in the server list",
                      onclick: () => onShowServer(row.address),
                    },
                    "Show",
                  ),
                );
              }),
              running.length > 6 && el("p", { className: "quiet" }, `and ${plural(running.length - 6, "more server")}`),
            )
          : el(
              "p",
              { className: "quiet" },
              state.servers.length ? "No server in your list is running it now." : "Find servers to see which ones are running it.",
            ),
      ),
      item.description &&
        el("div", { className: "detail__section" }, item.description.split("\n").map((line) => el("p", { className: "pane-text" }, line))),
    ];
  }

  function paintToolbar() {
    if (document.activeElement !== search && search.value !== state.content.query) search.value = state.content.query;
    sortChip.textContent = `${SORT_LABELS[state.content.sort]} ▾`;
    for (const button of layoutButtons) {
      button.setAttribute("aria-pressed", button.dataset.layout === layout() ? "true" : "false");
    }
    const collapsed = state.detailCollapsed;
    detailToggle.setAttribute("aria-pressed", collapsed ? "false" : "true");
    detailToggle.title = collapsed ? "Show map details (Ctrl+D)" : "Hide map details (Ctrl+D)";
  }

  function paintStatus() {
    const { total, installs, items: list } = state.content;
    fill(
      statusbar,
      el(
        "a",
        {
          className: "ext-link statusbar__source",
          href: MOH_DB_MAPS,
          title: "Opens moh-db.com in your browser",
          onclick: (event) => {
            event.preventDefault();
            controller.openLink(MOH_DB_MAPS);
          },
        },
        "Maps from moh-db.com ↗",
      ),
      total !== null && el("span", null, el("strong", null, total.toLocaleString()), " available"),
      installs.size > 0 && el("span", null, el("strong", null, String(installs.size)), " downloading"),
      el("span", { className: "statusbar__spacer" }),
      list.length > 0 && total !== null && el("span", null, `Showing ${list.length.toLocaleString()} of ${total.toLocaleString()}`),
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
    const at = children.findIndex((node) => node.dataset.id === String(state.content.selected));
    const columns = layout() === "cards" ? columnsIn(children) : 1;
    const moves = {
      ArrowDown: columns,
      ArrowUp: -columns,
      ArrowRight: layout() === "cards" ? 1 : 0,
      ArrowLeft: layout() === "cards" ? -1 : 0,
    };
    let target = null;
    if (event.key in moves && moves[event.key] !== 0) target = Math.max(0, Math.min(children.length - 1, (at === -1 ? 0 : at + moves[event.key])));
    else if (event.key === "Home") target = 0;
    else if (event.key === "End") target = children.length - 1;
    else if (event.key === "Enter" && at !== -1) {
      event.preventDefault();
      const item = selectedItem();
      if (item) void controller.install(item);
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

function columnsIn(children) {
  const top = children[0].offsetTop;
  const index = children.findIndex((node) => node.offsetTop !== top);
  return index === -1 ? children.length : index;
}
