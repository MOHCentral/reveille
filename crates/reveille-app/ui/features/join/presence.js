// SPDX-License-Identifier: GPL-3.0-only

// The Discord status: off until the player turns it on, beside Join or in Settings. Nothing is
// shared before that.

import { preferences, registerPreferences, setPreference } from "../../lib/preferences.js";
import { setDiscordPresence } from "./api.js";

registerPreferences({ discordPresence: false }, { discordPresence: (value) => typeof value === "boolean" });

/** Send the saved choice. The shell shares nothing until it has heard it. */
export async function syncDiscordPresence() {
  try {
    await setDiscordPresence(preferences().discordPresence);
  } catch {
    // Without the shell there is no status to change.
  }
}

/** Save the player's choice, wherever it was made, and tell the shell. */
export function changeDiscordPresence(on) {
  setPreference("discordPresence", on);
  return syncDiscordPresence();
}
