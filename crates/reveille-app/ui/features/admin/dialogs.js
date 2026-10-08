// SPDX-License-Identifier: GPL-3.0-only

// Adding a server the player runs. The password field is the only place in the page a password
// exists, and only until the server has answered.

import { closeDialog, openDialog } from "../../lib/dialog.js";
import { el } from "../../lib/dom.js";
import { errorText } from "../../lib/shell.js";

const KEPT = {
  credential_manager: "Once the server accepts it, the password is kept in Windows Credential Manager. Reveille never shows it again.",
  keychain: "Once the server accepts it, the password is kept in your macOS keychain. Reveille never shows it again.",
  memory: "This system has no password store Reveille can use, so it keeps the password until it closes.",
};

/**
 * Ask for a server's address and RCON password, check them with the server, then add it.
 * `address` and `name` fill the dialog for a server already known, from a row or from Admin.
 */
export function openAddServer({ controller, vault, address = "", name = null, onAdded = () => {} }) {
  const addressInput = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "203.0.113.4:12203",
    value: address,
    "aria-label": "Server address",
  });
  const passwordInput = el("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: false,
    "aria-label": "RCON password",
  });
  const error = el("p", { className: "form-error", role: "alert" });
  const submit = el("button", { type: "button", className: "btn btn--primary", onclick: () => void add() }, "Add server");

  async function add() {
    const password = passwordInput.value;
    if (!addressInput.value.trim() || !password) {
      error.textContent = !addressInput.value.trim() ? "Enter the server's address." : "Enter the server's RCON password.";
      return;
    }
    submit.disabled = true;
    submit.textContent = "Checking with the server…";
    error.textContent = "";
    try {
      const server = await controller.add(addressInput.value, password);
      passwordInput.value = "";
      closeDialog();
      onAdded(server);
    } catch (failure) {
      error.textContent = errorText(failure);
      submit.disabled = false;
      submit.textContent = "Add server";
      passwordInput.select();
    }
  }

  for (const input of [addressInput, passwordInput]) {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void add();
    });
  }

  openDialog(
    name ? `RCON password for ${name}` : "Add a server you run",
    el("p", null, "Admin lets you kick and ban players, change the map and type console commands on a server you run, with its RCON password."),
    el("label", { className: "form-row" }, el("span", { className: "label" }, "Address"), el("span", { className: "field" }, addressInput)),
    el("label", { className: "form-row" }, el("span", { className: "label" }, "RCON password"), el("span", { className: "field" }, passwordInput)),
    el("p", { className: "quiet" }, KEPT[vault] ?? KEPT.memory),
    error,
    el("div", { className: "actions__row" }, submit),
  );
  (address ? passwordInput : addressInput).focus();
}

/** Ask before Admin forgets `server` and its password. */
export function confirmRemoveServer(controller, server) {
  openDialog(
    `Remove ${server.name} from Admin?`,
    el("p", null, "Reveille forgets this server and its RCON password. The server itself is not changed."),
    el(
      "div",
      { className: "actions__row" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn--primary",
          onclick: async () => {
            closeDialog();
            await controller.remove(server.address).catch((error) =>
              openDialog("Remove from Admin", el("p", null, errorText(error))),
            );
          },
        },
        "Remove",
      ),
    ),
  );
}
