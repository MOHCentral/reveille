// SPDX-License-Identifier: GPL-3.0-only

// The sections the rail switches between: Servers, Maps & mods, and later Admin.
//
// A section owns a toolbar, a list, a detail pane and a status bar, and the shell shows one
// section's four at a time. Registering is the whole contract, so a new section — Admin, or an
// extension's page — adds itself here without the shell learning its name.

import { state, update } from "./store.js";

export function initial() {
  return {
    /** The section on screen. Reveille always opens on Servers. */
    section: "servers",
  };
}

const registry = [];

/**
 * Add a section. `id`, `label` and `icon` name it on the rail; `parts` are its four regions.
 *
 * `railLabel` breaks the label where the rail should, with a newline. Optional hooks: `visible()` hides it from the rail (Admin, until a server is added); `progress()`
 * returns 0–1 while it has work running, drawn as a line under its rail item; `enter()` runs each
 * time it is shown; `focusSearch`, `focusList`, `clearSearch` and `refresh` serve the global keys.
 */
export function registerSection(section) {
  if (registry.some((known) => known.id === section.id)) {
    throw new Error(`section ${section.id} is registered twice`);
  }
  registry.push(section);
}

/** Every registered section the rail should show, in registration order. */
export function sections() {
  return registry.filter((section) => section.visible?.() ?? true);
}

/** Every registered section, shown or not, so a section hidden while on screen is put away too. */
export function registeredSections() {
  return [...registry];
}

/** The section on screen, falling back to the first when the remembered one is hidden. */
export function activeSection() {
  const shown = sections();
  return shown.find((section) => section.id === state.section) ?? shown[0] ?? null;
}

/** Show section `id`. Unknown or hidden sections are refused. */
export function showSection(id) {
  const section = sections().find((known) => known.id === id);
  if (!section) return false;
  if (state.section !== id) update((next) => (next.section = id));
  section.enter?.();
  return true;
}

/** Forget every registration. For tests. */
export function resetSections() {
  registry.length = 0;
}
