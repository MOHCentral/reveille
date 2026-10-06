// SPDX-License-Identifier: GPL-3.0-only

// What other features may use from Settings: the controls their sections draw with, and the
// start-at-login switch.

import { choice, section, START_AT_LOGIN_LABEL, toggle } from "./dialog.js";
import { setCloseToTray, startAtLogin } from "./api.js";

export { choice, section, setCloseToTray, START_AT_LOGIN_LABEL, startAtLogin, toggle };
