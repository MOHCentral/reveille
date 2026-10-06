// SPDX-License-Identifier: GPL-3.0-only

// The compatibility verdict the join pane names and explains.

import { plural } from "../../lib/format.js";

/**
 * The canonical four state names.
 *
 * Every one of them is a measurement, not a mood word. A verbal hedge — "can't tell", "no
 * source", "possibly compatible" — costs a reader trust in the figure and in the source, where
 * the same fact stated as a measurement costs almost none (van der Bles et al., PNAS 2020). So the name says what Reveille found, and the player is left to
 * draw the verdict.
 *
 * "Map list", never "rotation" — the server publishes a list, and calling it a rotation claims an
 * order that is the server's to change.
 */
export function stateName(state) {
  switch (state?.state) {
    case "compatible":
      return "Compatible";
    case "needs_maps":
      return `Needs ${plural(state.count, "map")}`;
    case "no_source":
      return `No download for ${plural(state.count, "map")}`;
    default:
      return "Map list not published";
  }
}

/**
 * How each state was arrived at, rendered as persistent text beside the name.
 *
 * Not a tooltip. This is the sentence that turns a two-word noun into a decision, and a `title`
 * is unreachable by keyboard and by touch and fails WCAG 2.2 SC 1.4.13 outright.
 *
 * `Compatible` and `Map list not published` return null on purpose. Neither leaves the player
 * anything to do, and silence is the correct rendering of "nothing to do".
 */
export function stateExplanation(state) {
  switch (state?.state) {
    case "needs_maps":
      return "This server's map list includes maps you do not have. Reveille can download them before you join.";
    case "no_source":
      return state.count === 1
        ? "This map is in no catalogue Reveille can reach. You can play until the map list reaches it, then you are dropped."
        : "These maps are in no catalogue Reveille can reach. You can play until the map list reaches them, then you are dropped.";
    default:
      return null;
  }
}
