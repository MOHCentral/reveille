// SPDX-License-Identifier: GPL-3.0-only

// Maps & mods wording.

import { bytes, plural } from "../../lib/format.js";

export const SORT_LABELS = { popular: "Most downloaded", newest: "Newest", name: "A to Z" };

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

/** The day moh-db added a map, or null. `added` is in Unix seconds. */
export function addedText(added) {
  if (!Number.isFinite(added) || added <= 0) return null;
  return new Date(added * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** The line under a title: who made it and the map name servers will show. */
export function byline(item) {
  return [item.author && `by ${item.author}`, item.map_name].filter(Boolean).join(" · ");
}

/** What the action area says for an entry that cannot simply be installed. */
export function stateNote(state) {
  if (state === "installed") return "✓ Installed";
  if (state === "present") return "In your game folder";
  if (state === "unavailable") return "No download";
  return null;
}

/** The pane's sentence under the action, for each state. */
export function stateExplanation(state) {
  if (state === "installed") return "Reveille installed this map in your game folder.";
  if (state === "present") {
    return "A file with this name is already in your game folder, so Reveille leaves it alone.";
  }
  if (state === "unavailable") return "moh-db has no file Reveille can install for this map. Its page may explain how to get it.";
  return "Goes into your game folder. Nothing already there is replaced.";
}
