// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/main.rs):
//   app_log_files()                            -> { current, previous }

import { invoke } from "../../lib/bridge.js";

export const appLogFiles = () => invoke("app_log_files");
