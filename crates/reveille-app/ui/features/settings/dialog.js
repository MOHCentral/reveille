// SPDX-License-Identifier: GPL-3.0-only

// The Settings panel, drawn in the shared dialog. Every control saves as it changes; there is no
// Apply button to forget. Each feature draws its own section, so the panel knows none of them.

import { $, el, preserveFocus } from "../../lib/dom.js";
import { openDialog } from "../../lib/dialog.js";
import { setPreference } from "../../lib/preferences.js";
import { update } from "../../lib/store.js";

export const START_AT_LOGIN_LABEL = "Start Reveille in the background when I sign in";

/**
 * Open Settings with `sections` in order. Each is called on every draw with `{ change, redraw }`
 * and returns its `section()`, or nothing to leave itself out. `change(name, value)` saves a
 * preference and redraws; `redraw()` draws again after a section's own answer arrives.
 */
export function openSettings(sections) {
  const redraw = () => preserveFocus($("#info-dialog-body"), () => openSettings(sections));
  const change = (name, value) => {
    setPreference(name, value);
    // Ping colours are drawn in the list, which repaints on a notify.
    update(() => {});
    redraw();
  };
  openDialog("Settings", ...sections.map((draw) => draw({ change, redraw })));
}

export function section(title, ...children) {
  return el("section", { className: "settings__section" }, el("h3", { className: "label" }, title), ...children);
}

export function toggle(id, label, on, onChange, disabled = false) {
  return el(
    "label",
    { className: "settings__toggle", for: id },
    el("input", {
      id,
      type: "checkbox",
      checked: on,
      disabled,
      dataset: { focusKey: id },
      onchange: (event) => onChange(event.target.checked),
    }),
    el("span", null, label),
  );
}

export function choice(id, label, values, current, text, onChange, disabled = false, parse = Number) {
  return el(
    "label",
    { className: "settings__choice", for: id },
    el("span", null, label),
    el(
      "select",
      {
        id,
        disabled,
        dataset: { focusKey: id },
        onchange: (event) => onChange(parse(event.target.value)),
      },
      values.map((value) =>
        el("option", { value: String(value), selected: value === current }, text(value)),
      ),
    ),
  );
}
