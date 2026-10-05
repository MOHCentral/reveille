// SPDX-License-Identifier: GPL-3.0-only

// What the server list says about a server it could not list, a map it lacks, or a sweep that failed.

import { plural } from "../../lib/format.js";

/**
 * What the Map cell adds after the map name: how many maps this server needs, so "can I join
 * right now?" is answered on every row without selecting it. Nothing for a ready server, nor for
 * one that publishes no map list: its current map was checked, and the rest is nothing a player
 * can act on before joining.
 */
export function mapNeed(state) {
  switch (state?.state) {
    case "needs_maps":
      return {
        kind: "download",
        text: String(state.count),
        title: `Needs ${plural(state.count, "map")}. Reveille downloads them when you join.`,
      };
    case "no_source":
      return {
        kind: "missing",
        text: String(state.count),
        title: `No download found for ${plural(state.count, "map")}.`,
      };
    default:
      return null;
  }
}

/**
 * Non-result reasons in plain language.
 *
 * The stage matters as much as the reason: a timeout answering the master's
 * server-list query and a timeout answering the game query are different
 * failures, and labelling both "did not answer" makes one group look like a
 * duplicate of the other.
 */
export function nonResultReason(group) {
  if (group.reason === "duplicate_endpoint") return "is the same server registered twice";
  if (group.reason === "missing_host_port") return "did not publish a game port";

  const what =
    group.stage === "get_status" ? "the game query" : "the server-list query";
  switch (group.reason) {
    case "timeout":
      return `did not answer ${what}`;
    case "network":
      return `was unreachable for ${what}`;
    case "malformed":
      return `answered ${what} with a reply Reveille could not read`;
    default:
      return `${group.reason} at ${what}`;
  }
}

/**
 * Why the server list could not be built, in the player's terms.
 *
 * The `kind` is decided in Rust, beside the errors it names, exactly as `OpenMohaaFailureKind`
 * already is — the shell never reads a cause out of a formatted message. Each one carries a cause
 * and a remedy, because the two moments this fires are where a non-technical player decides
 * whether the tool is broken or their PC is.
 *
 * The original message is kept as `detail` and shown as detail, not as the whole status bar.
 */
const BROWSE_FAILURES = {
  no_network: {
    title: "Reveille could not reach the network",
    remedy:
      "Check that this PC is online. A firewall blocking the master server's TCP connection can cause this too.",
  },
  master_unreachable: {
    title: "The master server could not be reached",
    remedy: "It is run by the community and is sometimes down. Try again in a few minutes.",
  },
  master_unreadable: {
    title: "The master server sent a reply Reveille could not read",
    remedy: "Nothing on this PC caused it. Try again; the reply may have been cut short.",
  },
  game_unavailable: {
    title: "Reveille could not find the game in the saved folder",
    remedy:
      "The folder may have moved or changed. Choose it again in Settings → Change folder or engine.",
  },
  engine_unavailable: {
    title: "The selected engine is no longer available",
    remedy: "Choose an installed engine in Settings → Change folder or engine.",
  },
  maps_unreadable: {
    title: "Reveille could not read the maps in the game folder",
    remedy: "Check that the game folder is readable, then try again.",
  },
  internal: {
    title: "The server list could not be built",
    remedy: null,
  },
};

export function browseFailureText(failure) {
  const known = BROWSE_FAILURES[failure?.kind] ?? BROWSE_FAILURES.internal;
  return { ...known, detail: failure?.detail ?? "" };
}

/**
 * What the live region says while a sweep runs.
 *
 * The sweep emits one event per probed endpoint, so a region restating "N of M done" fired
 * roughly two hundred announcements per sweep — not progress reporting but a denial of service
 * against the one output a blind player has. Progress is announced at
 * quarters instead: start, three milestones, then the summary. Five utterances rather than two
 * hundred.
 *
 * Deliberately carries no live counts. A running total inside the sentence would make the string
 * differ on every probe and defeat the whole point of the milestone.
 */
const SWEEP_MILESTONES = [
  "A quarter of the servers checked.",
  "Half of the servers checked.",
  "Three quarters of the servers checked.",
];

export function sweepProgressText({ probed, inspected }) {
  if (inspected <= 0) return "Getting the server list. Contacting the master server.";
  const quarter = Math.min(3, Math.floor((probed / inspected) * 4));
  return quarter === 0 ? `Checking ${inspected} servers.` : SWEEP_MILESTONES[quarter - 1];
}
