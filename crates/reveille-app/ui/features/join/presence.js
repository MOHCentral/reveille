// SPDX-License-Identifier: GPL-3.0-only

// The Discord status: off until the player chooses it, either in Settings or when asked once, the
// first time a game launches while Discord is running. Nothing is shared before that answer.

import { preferences, registerPreferences, setPreference } from "../../lib/preferences.js";
import { setDiscordPresence } from "./api.js";

const isBoolean = (value) => typeof value === "boolean";

registerPreferences(
  { discordPresence: false, discordPresenceAsked: false },
  { discordPresence: isBoolean, discordPresenceAsked: isBoolean },
);

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
  setPreference("discordPresenceAsked", true);
  setPreference("discordPresence", on);
  return syncDiscordPresence();
}

/** @param {import("./api.js").JoinResult | null} result */
export const discordQuestionDue = (result) =>
  result?.discord_running === true && !preferences().discordPresence && !preferences().discordPresenceAsked;
