// SPDX-License-Identifier: GPL-3.0-only

// Admin: the remote console of servers the player runs, shown only once one is added.

import { state } from "../../lib/store.js";
import { initial } from "./state.js";

export { initial };

/** Whether Admin belongs on the rail: once a server is added, and until the last one is removed. */
export const hasAdminServers = () => state.admin.servers.length > 0;

/** @typedef {import("./api.js").AdminStatus} AdminStatus */
