// SPDX-License-Identifier: GPL-3.0-only

// The Discord section of Settings.

import { el } from "../../lib/dom.js";
import { preferences } from "../../lib/preferences.js";
import { section, toggle } from "../settings/index.js";
import { changeDiscordPresence } from "./presence.js";

export const DISCORD_PRESENCE_LABEL = "Show the server I'm playing on in my Discord status";
export const DISCORD_PRESENCE_HINT =
  "Your Discord friends see the game and the server's name. Some servers put their address in that name. Needs the Discord app on this computer.";

export function discordSettingsSection() {
  return ({ redraw }) =>
    section(
      "Discord",
      toggle("settings-discord-presence", DISCORD_PRESENCE_LABEL, preferences().discordPresence, (on) => {
        void changeDiscordPresence(on);
        redraw();
      }),
      el("p", { className: "settings__hint" }, DISCORD_PRESENCE_HINT),
    );
}
