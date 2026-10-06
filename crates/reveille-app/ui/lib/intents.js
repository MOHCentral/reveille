// SPDX-License-Identifier: GPL-3.0-only

// The few things one feature may ask the shell to do for it. A fixed table rather than a service
// bag, so a feature's reach into the rest of the app is the list below and nothing more.

export const INTENT_NAMES = Object.freeze([
  "selectGame",
  "select",
  "activate",
  "refresh",
  "check",
  "openServer",
  "togglePlayerAlert",
]);

/**
 * Freeze the shell's bindings into the intents table. Throws on a missing, extra or non-function
 * entry, so a binding forgotten at boot stops the shell before any listener or monitor can call it.
 */
export function intentsTable(bindings) {
  const unknown = Object.keys(bindings).filter((name) => !INTENT_NAMES.includes(name));
  if (unknown.length) throw new Error(`Unknown intents: ${unknown.join(", ")}`);
  const unbound = INTENT_NAMES.filter((name) => typeof bindings[name] !== "function");
  if (unbound.length) throw new Error(`Unbound intents: ${unbound.join(", ")}`);
  return Object.freeze(Object.fromEntries(INTENT_NAMES.map((name) => [name, bindings[name]])));
}
