// SPDX-License-Identifier: GPL-3.0-only

// The Discord status: on unless the player turns it off, and explained once, the first time
// Discord actually shows a match, so no player learns of it from a friend.

import { preferences, registerPreferences, setPreference } from "../../lib/preferences.js";
import { setDiscordPresence } from "./api.js";

const isBoolean = (value) => typeof value === "boolean";

registerPreferences(
  { discordPresence: true, discordNoticeShown: false },
  { discordPresence: isBoolean, discordNoticeShown: isBoolean },
);

/** Send the saved choice. The shell shares nothing until it has heard it. */
export async function syncDiscordPresence() {
  try {
    await setDiscordPresence(preferences().discordPresence);
  } catch {
    // Without the shell there is no status to change.
  }
}

export function changeDiscordPresence(on) {
  setPreference("discordPresence", on);
  return syncDiscordPresence();
}

/** @param {import("./api.js").JoinResult | null} result */
export const discordNoticeDue = (result) =>
  result?.presence_shown === true && !preferences().discordNoticeShown;

/** Either answer retires the notice; turning it off also ends the status showing now. */
export function answerDiscordNotice(keep) {
  setPreference("discordNoticeShown", true);
  return keep ? Promise.resolve() : changeDiscordPresence(false);
}
