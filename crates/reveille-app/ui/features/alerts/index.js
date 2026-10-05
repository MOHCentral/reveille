// SPDX-License-Identifier: GPL-3.0-only

// What other features may use of player alerts: the Watching scope's entries and row lines for the
// server list, and the watch and its rule for the join pane.

import { lastArrivals } from "./arrival-events.js";
import { THRESHOLDS, playerAlert, setAlertThreshold, watchReading, watchedEntries } from "./player-alerts.js";
import { watchedAddresses, watchedLine } from "./watching.js";

export {
  lastArrivals,
  playerAlert,
  setAlertThreshold,
  THRESHOLDS,
  watchedAddresses,
  watchedEntries,
  watchedLine,
  watchReading,
};
