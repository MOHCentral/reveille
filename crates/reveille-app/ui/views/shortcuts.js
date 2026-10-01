// SPDX-License-Identifier: GPL-3.0-only

// The shortcut sheet behind `?` and the titlebar's More menu. Every key here must also be handled
// by the keydown listener in app.js or the grid in views/servers.js.

import { openDialog } from "../lib/dialog.js";
import { el } from "../lib/dom.js";

export const SHORTCUTS = [
  {
    heading: "Selected server",
    keys: [
      [["Enter"], "Join, or show what joining needs"],
      [["F"], "Add to or remove from Favorites"],
      [["W"], "Watch for players, or stop watching"],
      [["R"], "Refresh this server"],
      [["Shift", "F10"], "Open the server's menu"],
    ],
  },
  {
    heading: "Server list",
    keys: [
      [["↑", "↓"], "Move between servers"],
      [["Home", "End"], "First or last server"],
      [["Ctrl", "F"], "Search (or /)"],
      [["Esc"], "Clear the search"],
      [["F5"], "Refresh the list (or Ctrl+R)"],
    ],
  },
  {
    heading: "Window",
    keys: [
      [["Ctrl", "1…4"], "Switch view"],
      [["Ctrl", "D"], "Show or hide server details"],
      [["F6"], "Jump between list, toolbar and details"],
      [["?"], "Show this sheet"],
    ],
  },
];

export function openShortcuts() {
  const sections = SHORTCUTS.map(({ heading, keys }) =>
    el(
      "section",
      { className: "shortcuts" },
      el("h3", { className: "shortcuts__heading" }, heading),
      el(
        "dl",
        { className: "shortcuts__list" },
        ...keys.flatMap(([combo, action]) => [
          el("dt", null, ...combo.map((key) => el("kbd", { className: "kbd" }, key))),
          el("dd", null, action),
        ]),
      ),
    ),
  );
  openDialog("Keyboard shortcuts", el("div", { className: "shortcuts-grid" }, ...sections));
}
