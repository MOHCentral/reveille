// SPDX-License-Identifier: GPL-3.0-only

// Finding a server by the address someone shared, for one the list does not show.

import { closeDialog, dialogShows, openDialog } from "../../lib/dialog.js";
import { el } from "../../lib/dom.js";
import { errorText } from "../../lib/shell.js";
import { locateServer } from "./api.js";

const FIND = "Find server";

/**
 * Ask for an address, find the server behind it, then hand it to `onFound`.
 * `text` fills the field, as a paste onto the list does, and starts looking straight away.
 *
 * @param {{ text?: string, onFound: (server: import("./api.js").LocatedServer) => void }} options
 */
export function openFindByAddress({ text = "", onFound }) {
  const input = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "203.0.113.4:12203",
    value: text.trim(),
    "aria-label": "Server address",
  });
  const error = el("p", { className: "form-error", role: "alert" });
  const submit = el("button", { type: "button", className: "btn btn--primary", onclick: () => void find() }, FIND);

  async function find() {
    if (!input.value.trim()) {
      error.textContent = "Enter the server's address.";
      return;
    }
    submit.disabled = true;
    submit.textContent = "Looking for the server…";
    error.textContent = "";
    try {
      const server = await locateServer(input.value);
      // Closed or replaced while the server was being asked: the player has moved on.
      if (!dialogShows(input)) return;
      closeDialog();
      onFound(server);
    } catch (failure) {
      error.textContent = errorText(failure);
      input.focus();
    } finally {
      submit.disabled = false;
      submit.textContent = FIND;
    }
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !submit.disabled) void find();
  });
  // Editing the address after a failed lookup makes the old reason wrong.
  input.addEventListener("input", () => {
    error.textContent = "";
  });

  openDialog(
    "Find a server by its address",
    el("p", null, "For a server someone shared with you, or one the list does not show. Reveille finds it and selects it in the list, ready to join."),
    el("label", { className: "form-row" }, el("span", { className: "label" }, "Address"), el("span", { className: "field" }, input)),
    el("p", { className: "quiet" }, "An IP address with or without its port, a server name, or a whole “connect …” line pasted from chat."),
    error,
    el("div", { className: "actions__row" }, submit),
  );
  input.focus();
  if (input.value) void find();
}
