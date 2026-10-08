// SPDX-License-Identifier: GPL-3.0-only

// The rail down the left edge: one button per section, and Settings at its foot.
//
// Sections are where the player is, so they sit apart from Servers, Favorites, Watching and History,
// which only narrow one list and stay as buttons in the toolbar.

import { el, fill } from "./dom.js";
import { icon } from "./icons.js";
import { activeSection, sections, showSection } from "./sections.js";

export function railView(root, { onSettings }) {
  const settings = el(
    "button",
    {
      type: "button",
      id: "settings-btn",
      className: "rail__item rail__item--foot",
      title: "Settings",
      onclick: onSettings,
    },
    icon("gear"),
    el("span", { className: "rail__label" }, "Settings"),
  );
  const items = new Map();

  const item = (section, index) =>
    el(
      "button",
      {
        type: "button",
        className: "rail__item",
        title: `${section.label} (Ctrl+Shift+${index + 1})`,
        dataset: { section: section.id },
        onclick: () => showSection(section.id),
      },
      icon(section.icon, { outline: true }),
      el("span", { className: "rail__label" }, section.railLabel ?? section.label),
      el("span", { className: "rail__progress hidden", "aria-hidden": "true" }, el("span")),
    );

  function render() {
    const shown = sections();
    const signature = shown.map((section) => section.id).join(",");
    if (root.dataset.sections !== signature) {
      items.clear();
      fill(
        root,
        shown.map((section, index) => {
          const node = item(section, index);
          items.set(section.id, node);
          return node;
        }),
        el("span", { className: "rail__spacer" }),
        settings,
      );
      root.dataset.sections = signature;
    }
    const active = activeSection();
    for (const section of shown) {
      const node = items.get(section.id);
      if (section === active) node.setAttribute("aria-current", "page");
      else node.removeAttribute("aria-current");
      const share = section.progress?.() ?? null;
      const bar = node.querySelector(".rail__progress");
      bar.classList.toggle("hidden", share === null);
      bar.firstChild.style.width = share === null ? "" : `${Math.round(Math.min(1, Math.max(0, share)) * 100)}%`;
      node.title = share === null
        ? `${section.label} (Ctrl+Shift+${shown.indexOf(section) + 1})`
        : `${section.label}: downloading, ${Math.round(share * 100)}%`;
    }
  }

  return { render, settings };
}
