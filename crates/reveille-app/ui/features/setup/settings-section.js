// SPDX-License-Identifier: GPL-3.0-only

// The Game and engine section of Settings.

import { el } from "../../lib/dom.js";
import { GAME_LABELS } from "../../lib/catalog.js";
import { displayPath } from "../../lib/format.js";
import { state } from "../../lib/store.js";
import { section } from "../settings/index.js";

/** `engine` is the engine's display name; `onChangeInstall()` opens Setup. */
export function installSettingsSection({ engine, onChangeInstall }) {
  return () =>
    section(
      "Game and engine",
      el(
        "p",
        { className: "settings__value" },
        `${GAME_LABELS[state.game] ?? state.game} · ${engine}`,
      ),
      el("p", { className: "settings__hint data" }, displayPath(state.install?.root ?? "")),
      el(
        "button",
        { type: "button", className: "btn btn--sm", onclick: onChangeInstall },
        "Change folder or engine…",
      ),
    );
}
