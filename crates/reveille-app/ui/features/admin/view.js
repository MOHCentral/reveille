// SPDX-License-Identifier: GPL-3.0-only

// Admin: one button per server in the toolbar, the players with their actions, the console at the
// bottom, and the map, rotation and message to everyone in the pane.
//
// Kick and Ban sit on a player's row only while it is hovered or selected, like the bin on a map,
// so a list of names does not read as a list of threats. Ban asks first; nothing else does,
// because everything else can be undone from the same screen.

import { closeDialog, openDialog } from "../../lib/dialog.js";
import { el, fill, preserveFocus } from "../../lib/dom.js";
import { icon } from "../../lib/icons.js";
import { state } from "../../lib/store.js";
import { busyKey } from "./controller.js";
import { confirmRemoveServer, openAddServer } from "./dialogs.js";

export const VAULT_TEXT = {
  credential_manager: "RCON passwords kept in Windows Credential Manager",
  keychain: "RCON passwords kept in your macOS keychain",
  memory: "RCON passwords kept until Reveille closes",
};

export function adminView({ controller, onToggleDetail }) {
  const serverButtons = el("div", { className: "scope admin-switch", role: "group", "aria-label": "Servers you run" });
  const addButton = el(
    "button",
    {
      type: "button",
      className: "btn btn--sm",
      dataset: { focusKey: "admin-add" },
      onclick: () => openAddServer({ controller, vault: state.admin.vault }),
    },
    "+ Add server",
  );
  const detailToggle = el(
    "button",
    {
      type: "button",
      className: "btn btn--icon toolbar__pane",
      dataset: { focusKey: "admin-detail-toggle" },
      "aria-label": "Details",
      onclick: onToggleDetail,
    },
    el("span", { className: "toolbar__pane-glyph", "aria-hidden": "true" }),
  );
  const toolbar = el(
    "div",
    { className: "toolbar toolbar--admin" },
    serverButtons,
    addButton,
    el("span", { className: "toolbar__spacer" }),
    el("div", { className: "toolbar__action" }, detailToggle),
  );

  const head = el("div", { className: "admin-head" });
  const players = el("div", { className: "admin-players", onkeydown: onPlayersKey });

  // The console's input is built once, so a status poll never takes the caret out of it.
  const history = [];
  let historyAt = 0;
  const consoleLog = el("div", { className: "admin-console__log data", role: "log", "aria-label": "Console output" });
  const consoleInput = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Type an RCON command",
    "aria-label": "RCON command",
    dataset: { focusKey: "admin-console" },
    onkeydown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        sendConsole();
      } else if (event.key === "ArrowUp" && history.length) {
        event.preventDefault();
        historyAt = Math.max(0, historyAt - 1);
        consoleInput.value = history[historyAt];
      } else if (event.key === "ArrowDown" && history.length) {
        event.preventDefault();
        historyAt = Math.min(history.length, historyAt + 1);
        consoleInput.value = history[historyAt] ?? "";
      }
    },
  });
  const consoleSend = el("button", { type: "button", className: "btn", onclick: sendConsole }, "Send");
  const consolePane = el(
    "div",
    { className: "admin-console" },
    el("p", { className: "label" }, "Console"),
    consoleLog,
    el(
      "div",
      { className: "admin-console__input" },
      el("label", { className: "field" }, el("span", { className: "field__icon", "aria-hidden": "true" }, ">"), consoleInput),
      consoleSend,
    ),
  );

  function sendConsole() {
    const line = consoleInput.value.trim();
    if (!line) return;
    history.push(line);
    historyAt = history.length;
    consoleInput.value = "";
    void controller.act({ kind: "console", line });
  }

  const listPane = el("div", { className: "list-pane admin-main" }, head, players, consolePane);

  // The pane's inputs are built once for the same reason.
  const mapInput = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "dm/mohdm6",
    "aria-label": "Map",
    list: "admin-maps",
    dataset: { focusKey: "admin-map" },
    onkeydown: (event) => {
      if (event.key === "Enter") changeMap();
    },
  });
  const mapChoices = el("datalist", { id: "admin-maps" });
  const sayInput = el("input", {
    type: "text",
    autocomplete: "off",
    maxLength: 150,
    placeholder: "Shown in the chat of every player",
    "aria-label": "Message everyone",
    dataset: { focusKey: "admin-say" },
    onkeydown: (event) => {
      if (event.key === "Enter") say();
    },
  });
  const rotationList = el("div", { className: "admin-rotation" });
  const removeLink = el(
    "button",
    {
      type: "button",
      className: "link-button",
      dataset: { focusKey: "admin-remove" },
      onclick: () => {
        const server = selectedServer();
        if (server) confirmRemoveServer(controller, server);
      },
    },
    "Remove this server from Admin",
  );
  const detailBody = el(
    "div",
    { className: "detail-pane__scroll admin-side" },
    el(
      "section",
      { className: "detail__section" },
      el("h3", { className: "display heading-sm" }, "Map"),
      el("label", { className: "field" }, mapInput),
      mapChoices,
      el(
        "div",
        { className: "actions__row" },
        el("button", { type: "button", className: "btn", dataset: { focusKey: "admin-change-map" }, onclick: changeMap }, "Change map"),
        el(
          "button",
          {
            type: "button",
            className: "btn",
            dataset: { focusKey: "admin-restart" },
            onclick: () => void controller.act({ kind: "restart_round" }),
          },
          "Restart round",
        ),
      ),
    ),
    el(
      "section",
      { className: "detail__section" },
      el("h3", { className: "display heading-sm" }, "Rotation"),
      rotationList,
      el(
        "div",
        { className: "actions__row" },
        el("button", { type: "button", className: "btn", dataset: { focusKey: "admin-rotation" }, onclick: editRotation }, "Edit rotation"),
      ),
    ),
    el(
      "section",
      { className: "detail__section" },
      el("h3", { className: "display heading-sm" }, "Message everyone"),
      el("label", { className: "field" }, sayInput),
      el("div", { className: "actions__row" }, el("button", { type: "button", className: "btn", dataset: { focusKey: "admin-say-send" }, onclick: say }, "Send")),
    ),
    el("section", { className: "detail__section" }, removeLink),
  );
  const detail = el("aside", { className: "detail-pane hidden", "aria-label": "Selected server" }, detailBody);
  const statusbar = el("div", { className: "statusbar" });

  function changeMap() {
    const map = mapInput.value.trim();
    if (map) void controller.act({ kind: "change_map", map });
  }

  async function say() {
    const text = sayInput.value.trim();
    if (!text) return;
    if (await controller.act({ kind: "say", text })) sayInput.value = "";
  }

  const selectedServer = () => state.admin.servers.find((server) => server.address === state.admin.selected) ?? null;
  const entry = () => state.admin.statuses.get(state.admin.selected) ?? null;

  let paintedSwitch = null;
  function paintToolbar() {
    const signature = JSON.stringify([state.admin.servers, state.admin.selected, counts()]);
    if (signature !== paintedSwitch) {
      paintedSwitch = signature;
      preserveFocus(serverButtons, () =>
        fill(
          serverButtons,
          state.admin.servers.map((server) => {
            const status = state.admin.statuses.get(server.address)?.status;
            const count = status ? `${status.players.length}${status.capacity ? `/${status.capacity}` : ""}` : "";
            return el(
              "button",
              {
                type: "button",
                className: "scope__option admin-switch__option",
                "aria-pressed": server.address === state.admin.selected ? "true" : "false",
                title: `${server.name}\n${server.address}`,
                dataset: { focusKey: `admin-server-${server.address}` },
                onclick: () => controller.select(server.address),
              },
              el("span", { className: "scope__label truncate" }, server.name),
              el("span", { className: "scope__count data" }, count),
            );
          }),
        ),
      );
    }
    const collapsed = state.detailCollapsed;
    detailToggle.setAttribute("aria-pressed", collapsed ? "false" : "true");
    detailToggle.title = collapsed ? "Show details (Ctrl+D)" : "Hide details (Ctrl+D)";
  }

  const counts = () => state.admin.servers.map((server) => state.admin.statuses.get(server.address)?.status?.players.length ?? null);

  function paintHead() {
    const server = selectedServer();
    const current = entry();
    const status = current?.status ?? null;
    const failure = current?.failure ?? null;
    const name = status?.name ?? server?.name ?? "";
    const facts = status
      ? [status.map, status.game_type, `${status.players.length}${status.capacity ? `/${status.capacity}` : ""}`].filter(Boolean).join(" · ")
      : "";
    const connection = !server
      ? null
      : failure
        ? el("span", { className: "admin-state admin-state--down" }, el("span", { className: "ping-dot ping-dot--poor" }), "Not connected")
        : status
          ? el("span", { className: "admin-state admin-state--up" }, el("span", { className: "ping-dot ping-dot--good" }), "Connected")
          : el("span", { className: "admin-state" }, "Connecting…");
    preserveFocus(head, () =>
      fill(
        head,
        el(
          "div",
          { className: "admin-head__title" },
          el("h2", { className: "pane-title truncate", title: name }, name),
          connection,
          facts && el("span", { className: "admin-head__facts data" }, facts),
        ),
        failure && failureNotice(server, failure),
      ),
    );
  }

  /** What went wrong, and the one thing that puts it right. */
  function failureNotice(server, failure) {
    if (failure.reason === "needs_password" || failure.reason === "bad_password") {
      const text =
        failure.reason === "needs_password"
          ? "Reveille needs this server's RCON password again."
          : "The server did not accept the saved password. It may have changed.";
      return el(
        "div",
        { className: "admin-notice" },
        el("p", null, text),
        el("button", { type: "button", className: "btn btn--primary btn--sm", dataset: { focusKey: "admin-password" }, onclick: () => openAddServer({ controller, vault: state.admin.vault, address: server.address, name: server.name }) }, "Enter password…"),
      );
    }
    return el(
      "div",
      { className: "admin-notice" },
      el("p", null, failure.message),
      el("button", { type: "button", className: "btn btn--sm", dataset: { focusKey: "admin-retry" }, onclick: () => void controller.refresh() }, "Try again"),
    );
  }

  let paintedPlayers = null;
  function paintPlayers() {
    const current = entry();
    const status = current?.status ?? null;
    const signature = JSON.stringify([
      state.admin.selected,
      status,
      Boolean(current?.loading),
      state.admin.player,
      [...state.admin.busy].filter((key) => key.startsWith(`${state.admin.selected}:`)),
    ]);
    if (signature === paintedPlayers) return;
    paintedPlayers = signature;
    preserveFocus(players, () => {
      if (!status) {
        fill(players, el("p", { className: "admin-players__empty quiet" }, current?.loading ? "Asking the server…" : ""));
        return;
      }
      fill(
        players,
        el(
          "table",
          { className: "admin-table" },
          el(
            "thead",
            null,
            el("tr", null, el("th", { scope: "col" }, "Player"), el("th", { scope: "col", className: "num" }, "Score"), el("th", { scope: "col", className: "num" }, "Ping"), el("th", { scope: "col" }, el("span", { className: "sr-only" }, "Actions"))),
          ),
          el(
            "tbody",
            null,
            status.players.length
              ? status.players.map((player) => playerRow(player, status))
              : el("tr", null, el("td", { colSpan: 4, className: "quiet" }, "No one is on the server.")),
          ),
        ),
      );
    });
  }

  function playerRow(player, status) {
    const selected = state.admin.player === player.slot;
    const address = state.admin.selected;
    const busy = (kind) => state.admin.busy.has(busyKey(address, { kind, slot: player.slot }));
    const action = (kind, label, onclick, title) =>
      el(
        "button",
        {
          type: "button",
          className: "btn btn--sm",
          tabIndex: selected ? 0 : -1,
          disabled: busy(kind),
          title,
          dataset: { focusKey: `admin-${kind}-${player.slot}` },
          onclick: (event) => {
            event.stopPropagation();
            controller.selectPlayer(player.slot);
            onclick();
          },
        },
        label,
      );
    return el(
      "tr",
      {
        tabIndex: selected || (state.admin.player === null && status.players[0] === player) ? 0 : -1,
        "aria-selected": selected ? "true" : "false",
        dataset: { slot: String(player.slot), focusKey: `admin-player-${player.slot}` },
        onclick: () => controller.selectPlayer(player.slot),
      },
      el("td", { className: "admin-table__name" }, el("span", { className: "truncate", title: player.name }, player.name)),
      el("td", { className: "num data" }, String(player.score)),
      el("td", { className: "num data" }, player.ping === null ? "joining" : String(player.ping)),
      el(
        "td",
        { className: "admin-table__actions" },
        el(
          "span",
          { className: "admin-actions" },
          status.can_message && action("message", "Message", () => messagePlayer(player), `Write to ${player.name} alone`),
          action("kick", "Kick", () => void controller.act({ kind: "kick", slot: player.slot }), `Drop ${player.name} from the server`),
          status.can_ban && action("ban", "Ban…", () => confirmBan(player), `Ban ${player.name}'s address and drop them`),
        ),
      ),
    );
  }

  function onPlayersKey(event) {
    const rows = [...players.querySelectorAll("tbody tr[data-slot]")];
    if (!rows.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    if (!event.target.matches("tr")) return;
    event.preventDefault();
    const at = rows.indexOf(event.target);
    const target = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: rows.length - 1 }[event.key];
    const row = rows[Math.max(0, Math.min(rows.length - 1, target))];
    controller.selectPlayer(Number(row.dataset.slot));
    players.querySelector(`tr[data-slot="${row.dataset.slot}"]`)?.focus();
  }

  function messagePlayer(player) {
    const input = el("input", { type: "text", autocomplete: "off", maxLength: 150, "aria-label": `Message to ${player.name}`, dataset: { focusKey: "admin-tell" } });
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      closeDialog();
      await controller.act({ kind: "message", slot: player.slot, text });
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") void send();
    });
    openDialog(
      `Message ${player.name}`,
      el("p", null, "Only this player sees it, in their chat."),
      el("label", { className: "field" }, input),
      el("div", { className: "actions__row" }, el("button", { type: "button", className: "btn btn--primary", onclick: () => void send() }, "Send")),
    );
    input.focus();
  }

  function confirmBan(player) {
    openDialog(
      `Ban ${player.name}?`,
      el("p", null, "The server adds this player's address to its ban list and drops them now. They cannot come back from that address."),
      el("p", { className: "quiet" }, "To lift it later, type listbans in the console, then bandel and the ban's number."),
      el(
        "div",
        { className: "actions__row" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn--primary",
            dataset: { focusKey: "admin-ban-confirm" },
            onclick: () => {
              closeDialog();
              void controller.act({ kind: "ban", slot: player.slot });
            },
          },
          "Ban",
        ),
      ),
    );
  }

  function editRotation() {
    const status = entry()?.status;
    const area = el("textarea", {
      className: "admin-textarea data",
      rows: 8,
      spellcheck: false,
      "aria-label": "Maps in rotation, one per line",
      value: (status?.rotation ?? []).join("\n"),
    });
    openDialog(
      "Edit rotation",
      el("p", null, "One map per line, in the order the server plays them. The change applies from the next map."),
      area,
      el(
        "div",
        { className: "actions__row" },
        el(
          "button",
          {
            type: "button",
            className: "btn btn--primary",
            onclick: async () => {
              const maps = area.value.split(/\s+/u).filter(Boolean);
              if (!maps.length) return;
              closeDialog();
              await controller.act({ kind: "set_rotation", maps });
            },
          },
          "Save rotation",
        ),
      ),
    );
    area.focus();
  }

  let paintedConsole = null;
  function paintConsole() {
    const lines = state.admin.consoles.get(state.admin.selected) ?? [];
    const signature = `${state.admin.selected}:${lines.length}:${lines.at(-1)?.text ?? ""}`;
    if (signature === paintedConsole) return;
    paintedConsole = signature;
    fill(
      consoleLog,
      lines.map((line) =>
        el("div", { className: `admin-console__line admin-console__line--${line.kind}` }, line.kind === "in" ? `> ${line.text}` : withoutColours(line.text)),
      ),
    );
    consoleLog.scrollTop = consoleLog.scrollHeight;
  }

  let paintedDetail = null;
  function paintDetail() {
    const status = entry()?.status ?? null;
    const signature = JSON.stringify([state.admin.selected, status?.map, status?.rotation]);
    if (signature === paintedDetail) return;
    const changedServer = JSON.parse(paintedDetail ?? "[null]")[0] !== state.admin.selected;
    paintedDetail = signature;
    const rotation = status?.rotation ?? [];
    if (changedServer || !mapInput.value) mapInput.value = rotation.find((map) => map !== status?.map) ?? "";
    fill(mapChoices, [...new Set([...rotation, status?.map].filter(Boolean))].map((map) => el("option", { value: map })));
    fill(
      rotationList,
      rotation.length
        ? rotation.map((map) =>
            el(
              "div",
              { className: `admin-rotation__row${map === status?.map ? " admin-rotation__row--now" : ""}` },
              el("span", { className: "data" }, map),
              map === status?.map && el("span", { className: "admin-rotation__now" }, "now"),
            ),
          )
        : el("p", { className: "quiet" }, status ? "The server publishes no rotation." : ""),
    );
  }

  function paintStatus() {
    const connected = state.admin.servers.filter((server) => {
      const known = state.admin.statuses.get(server.address);
      return known?.status && !known.failure;
    }).length;
    fill(
      statusbar,
      el("span", null, el("strong", null, String(state.admin.servers.length)), state.admin.servers.length === 1 ? " server" : " servers"),
      el("span", null, el("strong", null, String(connected)), " connected"),
      el("span", { className: "statusbar__spacer" }),
      el("span", null, icon("lock", { className: "statusbar__icon" }), VAULT_TEXT[state.admin.vault] ?? VAULT_TEXT.memory),
    );
  }

  function render() {
    paintToolbar();
    paintHead();
    paintPlayers();
    paintConsole();
    if (!state.detailCollapsed) paintDetail();
    paintStatus();
  }

  return {
    toolbar,
    listPane,
    detail,
    statusbar,
    render,
    focusSearch: () => consoleInput.focus(),
    focusList: () => (players.querySelector('tr[tabindex="0"]') ?? consoleInput).focus(),
    clearSearch: () => {
      consoleInput.value = "";
    },
  };
}

/** Quake colour codes (`^7`) are the game's markup, not text the admin should read. */
export function withoutColours(text) {
  return text.replace(/\^[0-9]/gu, "");
}
