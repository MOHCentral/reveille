// SPDX-License-Identifier: GPL-3.0-only

// The Discord section of Settings.

import { el } from "../../lib/dom.js";
import { preferences } from "../../lib/preferences.js";
import { section, toggle } from "../settings/index.js";
import { syncDiscordPresence } from "./presence.js";

export const DISCORD_PRESENCE_LABEL = "Show the server I'm playing on in my Discord status";
const DISCORD_PRESENCE_HINT =
  "Your friends see the server's name and map, never its address. Needs the Discord app on this computer.";

export function discordSettingsSection() {
  return ({ change }) =>
    section(
      "Discord",
      toggle("settings-discord-presence", DISCORD_PRESENCE_LABEL, preferences().discordPresence, (on) => {
        change("discordPresence", on);
        void syncDiscordPresence();
      }),
      el("p", { className: "settings__hint" }, DISCORD_PRESENCE_HINT),
    );
}
