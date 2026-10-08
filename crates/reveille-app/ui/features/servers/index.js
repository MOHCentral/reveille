// SPDX-License-Identifier: GPL-3.0-only

// The server list: the sweep, the one-server check, and the table that shows what they found.

import { nonResultReason } from "./format.js";
import { rememberReadyJoin } from "./reducers.js";
import { canRecheck, selectedRow } from "./selectors.js";
import { initial } from "./state.js";

export { canRecheck, initial, nonResultReason, rememberReadyJoin, selectedRow };

/** @typedef {import("./api.js").Server} Server */
/** @typedef {import("./api.js").CompatibilityAssessment} CompatibilityAssessment */
/** @typedef {import("./api.js").BrowserServer} BrowserServer */
