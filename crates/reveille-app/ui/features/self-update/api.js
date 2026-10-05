// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/self_update.rs):
//   check_reveille_update()                    -> { version, current_version } | null
//   install_reveille_update()                  -> void (the app exits on Windows)
//   cancel_reveille_update()                   -> void
//
// Events:
//   reveille://self-update SelfUpdateProgress { phase, received?, total? }

import { invoke, listen } from "../../lib/bridge.js";

export const checkReveilleUpdate = () => invoke("check_reveille_update");
export const installReveilleUpdate = () => invoke("install_reveille_update");
export const cancelReveilleUpdate = () => invoke("cancel_reveille_update");

export const onSelfUpdateProgress = (handler) => listen("reveille://self-update", handler);
