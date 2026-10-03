// SPDX-License-Identifier: GPL-3.0-only

// The remote console, in the shared dialog.
//
// It sends one command at a time to the server's game port and shows what the server prints back.
// It does not need the server to be joinable, compatible or even in the current sweep: rcon is a
// connectionless exchange with a password, which is also why it is offered next to the controls
// that act on one server and not inside the join flow.
//
// Kicking and banning pick a client from the server's own `status`. Maps come from this computer's
// game folder, because a stock 1.11 server will not list its own over rcon. The password is kept by the system credential store;
// this side only ever sends one the player just typed, and sends nothing to use the saved one.

import {
  errorText,
  rconForgetPassword,
  rconLocalMaps,
  rconListPlayers,
  rconPasswordSaved,
  sendRconCommand,
} from "../lib/api.js";
import { openDialog } from "../lib/dialog.js";
import { el } from "../lib/dom.js";
import { forgetMap, mergeMaps, rememberMap, rememberedMaps } from "../lib/rcon-maps.js";
import { session } from "../lib/store.js";
import {
  describeOutcome,
  describePasswordNote,
  isSafeMapName,
  playerLabel,
  rconMemory,
} from "../lib/rcon-session.js";

const QUICK_COMMANDS = ["status", "serverinfo", "listbans"];
const CONFIRM_MS = 4000;

/** Open the console for a live server row. */
export function openRconConsole(row) {
  const address = row.address;
  const name = row.server?.hostname || "(unnamed server)";
  let busy = false;
  let cursor = null;
  let saved = false;
  let players = [];
  let localMaps = [];

  const passwordInput = el("input", {
    type: "password",
    autocomplete: "off",
    spellcheck: false,
    "aria-label": "Rcon password",
    onkeydown: (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      commandInput.focus();
    },
  });

  const rememberBox = el("input", { type: "checkbox", checked: true });
  const forgetButton = el(
    "button",
    { type: "button", className: "btn btn--ghost btn--sm", onclick: () => void forget() },
    "Forget saved password",
  );
  forgetButton.hidden = true;

  const log = el("div", {
    className: "rcon__log data",
    role: "log",
    tabIndex: 0,
    "aria-label": "Console output",
    dataset: { placeholder: "What the server prints appears here." },
  });

  const commandInput = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    placeholder: "Command, for example status",
    "aria-label": "Command",
    onkeydown: onCommandKey,
  });

  const sendButton = el(
    "button",
    { type: "button", className: "btn btn--primary", onclick: () => void run(commandInput.value) },
    "Send",
  );

  const quick = el(
    "div",
    { className: "rcon__quick" },
    QUICK_COMMANDS.map((command) =>
      el(
        "button",
        { type: "button", className: "btn btn--ghost btn--sm", onclick: () => void run(command) },
        command,
      ),
    ),
  );

  const playerSelect = el("select", { "aria-label": "Player" });
  playerSelect.append(el("option", { value: "" }, "Load the players first"));
  playerSelect.onchange = refreshPlayerButtons;
  const kickButton = actionButton("Kick", () => kickSelected());
  const banButton = actionButton("Ban", () => banSelected());
  const loadPlayersButton = el(
    "button",
    { type: "button", className: "btn btn--ghost btn--sm", onclick: () => void loadPlayers() },
    "Load players",
  );

  const mapList = el("datalist", { id: "rcon-maps" });
  const mapInput = el("input", {
    type: "text",
    autocomplete: "off",
    spellcheck: false,
    list: "rcon-maps",
    placeholder: "Map, for example dm/mohdm1",
    "aria-label": "Map",
    onkeydown: (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      void changeMap();
    },
  });
  const mapButton = el(
    "button",
    { type: "button", className: "btn btn--ghost btn--sm", onclick: () => void changeMap() },
    "Change map",
  );
  const forgetMapButton = el(
    "button",
    {
      type: "button",
      className: "btn btn--ghost btn--sm",
      title: "Remove this map from the list remembered for this server",
      onclick: () => dropRemembered(),
    },
    "Remove",
  );
  forgetMapButton.hidden = true;
  mapInput.addEventListener("input", paintForgetMap);

  openDialog(
    "Remote console",
    el(
      "div",
      { className: "rcon" },
      el(
        "p",
        { className: "rcon__target" },
        el("strong", null, name),
        el("span", { className: "quiet data" }, address),
      ),
      el(
        "label",
        { className: "rcon__field" },
        el("span", { className: "rcon__label" }, "Rcon password"),
        el("span", { className: "field" }, passwordInput),
      ),
      el(
        "div",
        { className: "rcon__remember" },
        el("label", { className: "rcon__check" }, rememberBox, el("span", null, "Remember on this computer")),
        forgetButton,
      ),
      el(
        "p",
        { className: "quiet" },
        "Sent unencrypted, as the game does. Remembered in the system credential store.",
      ),
      el(
        "div",
        { className: "rcon__tools" },
        el("span", { className: "rcon__label" }, "Player"),
        el("span", { className: "field" }, playerSelect),
        el("span", { className: "rcon__buttons" }, loadPlayersButton, kickButton, banButton),
        el("span", { className: "rcon__label" }, "Map"),
        el("span", { className: "field" }, mapInput, mapList),
        el("span", { className: "rcon__buttons" }, forgetMapButton, mapButton),
      ),
      log,
      quick,
      el("div", { className: "rcon__send" }, el("span", { className: "field" }, commandInput), sendButton),
    ),
  );
  passwordInput.focus();
  void showSavedState();
  void loadMaps();

  async function showSavedState() {
    try {
      saved = await rconPasswordSaved(address);
    } catch {
      saved = false;
    }
    paintSaved();
    if (saved) commandInput.focus();
  }

  function paintSaved() {
    forgetButton.hidden = !saved;
    passwordInput.placeholder = saved ? "Saved password in use" : "";
  }

  async function forget() {
    let done = false;
    try {
      done = await rconForgetPassword(address);
    } catch {
      done = false;
    }
    if (done) {
      saved = false;
      paintSaved();
      append("notice", "The saved password was removed.");
      passwordInput.focus();
    } else {
      append("error", "The system credential store would not remove the password.");
    }
  }

  function append(tone, text) {
    log.append(el("pre", { className: `rcon__entry rcon__entry--${tone}` }, text));
    log.scrollTop = log.scrollHeight;
  }

  function setBusy(next) {
    busy = next;
    // `aria-disabled` rather than `disabled`, as everywhere in this interface: the button goes
    // busy while the caret is in the command box, and a disabled element cannot keep focus.
    sendButton.setAttribute("aria-disabled", next ? "true" : "false");
    sendButton.textContent = next ? "Sending…" : "Send";
  }

  /** The password to send: what was typed, or nothing so that the saved one is used. */
  function typedPassword() {
    return passwordInput.value || null;
  }

  /**
   * One round trip. Prints what the server said, applies what became of the password, and returns
   * the response, or `null` when nothing could be sent or the server refused.
   */
  async function exchange(echo, call) {
    if (busy) return null;
    if (!typedPassword() && !saved) {
      append("error", "Enter the rcon password first.");
      passwordInput.focus();
      return null;
    }
    setBusy(true);
    if (echo) append("echo", `> ${echo}`);
    let response = null;
    let described;
    try {
      response = await call(typedPassword(), rememberBox.checked);
      described = describeOutcome(response.outcome);
    } catch (error) {
      described = { tone: "error", text: errorText(error), password: "unknown" };
    }
    setBusy(false);

    applyPasswordNote(response?.password);
    if (described.password === "rejected") {
      append(described.tone, described.text);
      passwordInput.value = "";
      passwordInput.focus();
      return null;
    }
    if (described.password === "accepted" && passwordInput.value && rememberBox.checked) {
      passwordInput.value = "";
    }
    return { response, described };
  }

  function applyPasswordNote(note) {
    if (note === "saved") saved = true;
    if (note === "forgotten") saved = false;
    paintSaved();
    const text = describePasswordNote(note);
    if (text) append(note === "not_saved" ? "notice" : "echo", text);
  }

  async function run(raw) {
    const command = raw.trim();
    if (!command) return;
    rconMemory.remember(command);
    cursor = null;
    commandInput.value = "";
    const result = await exchange(command, (password, remember) =>
      sendRconCommand(address, password, command, remember),
    );
    if (result) {
      append(result.described.tone, result.described.text);
      commandInput.focus();
    }
  }

  /* Players ------------------------------------------------------------- */

  async function loadPlayers() {
    const result = await exchange(null, (password, remember) =>
      rconListPlayers(address, password, remember),
    );
    if (!result) return;
    if (result.response.outcome.status !== "reply" || result.described.tone === "error") {
      append(result.described.tone, result.described.text);
      return;
    }
    players = result.response.players ?? [];
    playerSelect.replaceChildren(
      el("option", { value: "" }, players.length ? "Choose a player…" : "No players on the server"),
      ...players.map((player) => el("option", { value: String(player.slot) }, playerLabel(player))),
    );
    refreshPlayerButtons();
    append("notice", `${players.length} player${players.length === 1 ? "" : "s"} loaded.`);
  }

  function selectedPlayer() {
    return players.find((player) => String(player.slot) === playerSelect.value) ?? null;
  }

  function refreshPlayerButtons() {
    const player = selectedPlayer();
    kickButton.setAttribute("aria-disabled", player ? "false" : "true");
    // Bots and loopback clients have no address a ban could name.
    const bannable = Boolean(player?.bannable);
    banButton.setAttribute("aria-disabled", bannable ? "false" : "true");
    banButton.title = player && !bannable ? "This client has no address that can be banned." : "";
    kickButton.dataset.armed = "";
    banButton.dataset.armed = "";
    kickButton.textContent = "Kick";
    banButton.textContent = "Ban";
  }

  async function kickSelected() {
    const player = selectedPlayer();
    if (!player) return;
    await run(`clientkick ${player.slot}`);
    await loadPlayers();
  }

  async function banSelected() {
    const player = selectedPlayer();
    if (!player?.bannable) return;
    // `banaddr` is OpenMoHAA's; a stock server answers it as an unknown command.
    await run(`banaddr ${player.slot}`);
    await loadPlayers();
  }

  /** A button that must be pressed twice within a few seconds, so a slip kicks no one. */
  function actionButton(label, act) {
    const button = el("button", { type: "button", className: "btn btn--ghost btn--sm" }, label);
    let timer = null;
    button.setAttribute("aria-disabled", "true");
    button.onclick = () => {
      if (button.getAttribute("aria-disabled") === "true" || busy) return;
      if (button.dataset.armed === "1") {
        clearTimeout(timer);
        button.dataset.armed = "";
        button.textContent = label;
        void act();
        return;
      }
      button.dataset.armed = "1";
      button.textContent = `Confirm ${label.toLowerCase()}?`;
      timer = setTimeout(() => {
        button.dataset.armed = "";
        button.textContent = label;
      }, CONFIRM_MS);
    };
    return button;
  }

  /* Maps ---------------------------------------------------------------- */

  function paintMaps() {
    const names = mergeMaps(localMaps, rememberedMaps(address));
    mapList.replaceChildren(...names.map((map) => el("option", { value: map })));
    paintForgetMap();
  }

  function paintForgetMap() {
    const typed = mapInput.value.trim().toLowerCase();
    forgetMapButton.hidden = !rememberedMaps(address).some((map) => map.toLowerCase() === typed);
  }

  function dropRemembered() {
    forgetMap(address, mapInput.value.trim());
    paintMaps();
  }

  async function loadMaps() {
    paintMaps();
    try {
      localMaps = await rconLocalMaps(session());
    } catch (error) {
      append("notice", `This computer's maps could not be read: ${errorText(error)}`);
      return;
    }
    paintMaps();
  }

  async function changeMap() {
    const map = mapInput.value.trim();
    if (!map) return;
    if (!isSafeMapName(map)) {
      append("error", "That is not a map name: use letters, digits, _ - . and / only.");
      return;
    }
    // Remembered only when this computer does not already have it, so the list stays the one
    // place a map the player types by hand can come back from.
    if (!localMaps.some((known) => known.toLowerCase() === map.toLowerCase())) {
      rememberMap(address, map);
      paintMaps();
    }
    await run(`map ${map}`);
  }

  function onCommandKey(event) {
    if (event.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void run(commandInput.value);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const step = rconMemory.step(cursor, event.key === "ArrowUp" ? -1 : 1);
    if (step.text === null) return;
    event.preventDefault();
    cursor = step.cursor;
    commandInput.value = step.text;
    commandInput.setSelectionRange(step.text.length, step.text.length);
  }
}
