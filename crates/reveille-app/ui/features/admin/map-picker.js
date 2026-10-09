// SPDX-License-Identifier: GPL-3.0-only

import { el, fill } from "../../lib/dom.js";

export function mapPicker({ onSubmit }) {
  let maps = [];
  let current = "";
  let matches = [];
  let opened = false;
  let active = -1;
  let query = "";

  const input = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "dm/mohdm6",
    className: "data",
    role: "combobox",
    "aria-label": "Map",
    "aria-autocomplete": "list",
    "aria-controls": "admin-map-options",
    "aria-expanded": "false",
    dataset: { focusKey: "admin-map" },
    onfocus: () => open(""),
    onblur: close,
    oninput: () => open(input.value),
    onkeydown: (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        if (!opened) open("");
        if (!matches.length) return;
        const direction = event.key === "ArrowDown" ? 1 : -1;
        active = active < 0
          ? (direction > 0 ? 0 : matches.length - 1)
          : (active + direction + matches.length) % matches.length;
        paint();
        list.children[active]?.scrollIntoView?.({ block: "nearest" });
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        if (opened && active >= 0) choose(matches[active]);
        else {
          close();
          onSubmit();
        }
      } else if (event.key === "Escape" && opened) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    },
  });
  const toggle = el("button", {
    type: "button",
    className: "admin-map-picker__toggle",
    "aria-label": "Show map suggestions",
    tabIndex: -1,
    onpointerdown: (event) => event.preventDefault(),
    onclick: () => {
      if (opened) close();
      else {
        input.focus();
        open("");
      }
    },
  }, "▾");
  const list = el("div", {
    id: "admin-map-options",
    className: "admin-map-picker__list hidden",
    role: "listbox",
    "aria-label": "Map suggestions",
    onpointerdown: (event) => event.preventDefault(),
  });
  const root = el("div", { className: "admin-map-picker" }, el("div", { className: "field" }, input, toggle), list);

  function close() {
    opened = false;
    active = -1;
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-activedescendant", "");
    list.classList.add("hidden");
  }

  function open(value) {
    query = value.toLowerCase().trim();
    opened = true;
    active = -1;
    paint();
  }

  function choose(map) {
    input.value = map;
    close();
  }

  function paint() {
    matches = maps.filter((map) => map.toLowerCase().includes(query));
    input.setAttribute("aria-expanded", String(opened));
    input.setAttribute("aria-activedescendant", active >= 0 ? `admin-map-option-${active}` : "");
    list.classList.toggle("hidden", !opened);
    fill(
      list,
      matches.length
        ? matches.map((map, index) => el(
            "div",
            {
              id: `admin-map-option-${index}`,
              className: "admin-map-picker__option",
              role: "option",
              "aria-selected": String(index === active),
              onclick: () => choose(map),
            },
            el("span", { className: "data" }, map),
            map === current && el("span", { className: "admin-map-picker__current" }, "Current"),
          ))
        : el("p", { className: "admin-map-picker__empty quiet" }, "No matching maps. You can type any map name."),
    );
  }

  function update({ maps: rotation, current: now, reset = false }) {
    maps = [...new Set([...rotation, now].filter(Boolean))];
    current = now;
    if (reset) close();
    else if (opened) {
      active = -1;
      paint();
    }
  }

  return { root, input, update };
}
