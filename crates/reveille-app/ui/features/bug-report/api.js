// SPDX-License-Identifier: GPL-3.0-only

// Commands: crates/reveille-app/src/logs.rs.

import { invoke } from "../../lib/bridge.js";

/** @returns {Promise<{ current: string, previous: string }>} The paths of this run's log and the last one's. */
export const appLogFiles = () => invoke("app_log_files");
