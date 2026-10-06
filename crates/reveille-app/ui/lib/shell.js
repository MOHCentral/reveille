// SPDX-License-Identifier: GPL-3.0-only

// What the desktop shell offers every feature: the app version, the system opener, telemetry
// events and the error normaliser.
//
//   track_event(event)  -> void; `event` is one of the `UiEvent` variants in src/telemetry.rs.
//                          Every other telemetry event is sent by the command that observes it.

import { appVersion, errorText, invoke, openUrl } from "./bridge.js";

export { appVersion, errorText };

/** Fire and forget: a lost event must never surface as an error in the player's way. */
export const trackEvent = (event) => {
  invoke("track_event", { event }).catch(() => {});
};

export const openExternalUrl = (url) => openUrl(url);
