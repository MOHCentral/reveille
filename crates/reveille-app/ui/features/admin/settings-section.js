// SPDX-License-Identifier: GPL-3.0-only

// The Servers you run section of Settings: the other way into Admin, for a server that is not in
// the list right now.

import { el } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { state } from "../../lib/store.js";
import { section } from "../settings/index.js";
import { confirmRemoveServer, openAddServer } from "./dialogs.js";

/** `onAdded(server)` runs once a server is added, to show it in Admin. */
export function adminSettingsSection({ controller, onAdded }) {
  return () =>
    section(
      "Servers you run",
      el(
        "p",
        { className: "quiet" },
        "Add a server you run to manage its players, map and console from an Admin section. You need its RCON password.",
      ),
      state.admin.servers.length > 0 &&
        el(
          "div",
          { className: "admin-settings__list" },
          state.admin.servers.map((server) =>
            el(
              "div",
              { className: "admin-settings__row" },
              el("span", { className: "truncate", title: server.name }, server.name),
              el("span", { className: "data quiet" }, server.address),
              el(
                "button",
                {
                  type: "button",
                  className: "btn btn--sm btn--icon btn--remove",
                  title: `Remove ${server.name} from Admin`,
                  "aria-label": `Remove ${server.name} from Admin`,
                  dataset: { focusKey: `settings-admin-remove-${server.address}` },
                  onclick: () => confirmRemoveServer(controller, server),
                },
                icon("trash"),
              ),
            ),
          ),
        ),
      el(
        "div",
        { className: "actions__row" },
        el(
          "button",
          {
            type: "button",
            className: "btn",
            dataset: { focusKey: "settings-admin-add" },
            onclick: () => openAddServer({ controller, vault: state.admin.vault, onAdded }),
          },
          "Add a server you run…",
        ),
      ),
    );
}
