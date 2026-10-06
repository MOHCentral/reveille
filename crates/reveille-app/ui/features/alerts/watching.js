// SPDX-License-Identifier: GPL-3.0-only

// The Watching scope's view of player alerts: which rows carry a bell, and the line under each.

import { state } from "../../lib/store.js";
import { watchLine } from "./format.js";
import { watchReading, watchedEntries } from "./player-alerts.js";

/** Addresses watched for player arrivals in the game this session is browsing. */
export function watchedAddresses() {
  return new Set(watchedEntries().map((entry) => entry.address));
}

/** What the monitor last saw on a watched server, when it last alerted, and its rule. */
export function watchedLine(address, alerted) {
  const threshold = watchedEntries().find((entry) => entry.address === address)?.threshold;
  return watchLine(watchReading(address), alerted.get(`${state.game}|${address}`) ?? null, threshold);
}
