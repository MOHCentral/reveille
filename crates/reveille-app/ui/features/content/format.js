// SPDX-License-Identifier: GPL-3.0-only

// Maps & mods wording.

import { bytes, plural } from "../../lib/format.js";

export const TAB_LABELS = { maps: "Maps", mods: "Mods", installed: "Installed" };
export const SORT_LABELS = { played: "Most played", popular: "Most downloaded", newest: "Newest", name: "A to Z" };
export const MODE_LABELS = { deathmatch: "Deathmatch", objective: "Objective", liberation: "Liberation" };

/** "2 servers · 26 players", or null when no server in the list runs it. */
export function liveText({ servers, players }) {
  if (!servers) return null;
  return `${plural(servers, "server")} · ${plural(players, "player")}`;
}

/** Bytes so far of the whole, while downloading; the archive check after that. */
export function progressText(install) {
  if (install.confirming) return "Checking the file…";
  const received = bytes(install.received);
  const total = bytes(install.total);
  // "19.7 of 31.8 MB" fits a card's foot where "19.7 MB of 31.8 MB" wraps.
  const unit = total.split(" ")[1];
  const [amount, receivedUnit] = received.split(" ");
  return receivedUnit === unit ? `${amount} of ${total}` : `${received} of ${total}`;
}

/** A day as "14 Nov 2023", or null. `seconds` is Unix seconds. */
export function addedText(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The line under a title: who made it, and the map name servers will show or the kind of mod. */
export function byline(item) {
  const what = item.kind === "mod" ? item.mod_type : item.map_name;
  return [item.author && `by ${item.author}`, what].filter(Boolean).join(" · ");
}

/** What the action area says for an entry that cannot simply be installed. */
export function stateNote(state) {
  if (state === "installed") return "✓ Installed";
  if (state === "present") return "In your game folder";
  if (state === "unavailable") return "No download";
  return null;
}

/** The pane's sentence under the action, for each state. */
export function stateExplanation(state, kind = "map") {
  const it = kind === "mod" ? "mod" : "map";
  if (state === "installed") return `Reveille installed this ${it} in your game folder and can remove it again.`;
  if (state === "present") return `Your game already has this ${it}, so Reveille leaves it alone.`;
  if (state === "unavailable") {
    return kind === "mod"
      ? "This mod does not come as a single .pk3, so Reveille cannot tell where its files go. Follow its notes on moh-db."
      : "moh-db has no file Reveille can install for this map. Its page may explain how to get it.";
  }
  return "Goes into your game folder. Nothing already there is replaced, and Reveille can remove it again.";
}
