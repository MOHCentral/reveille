// SPDX-License-Identifier: GPL-3.0-only

import { el, fill } from "../../lib/dom.js";
import { state, update } from "../../lib/store.js";
import { busyKey } from "./controller.js";

export function withoutColours(text) {
  return text.replace(/\^[0-9]/gu, "");
}

function lineText(line) {
  const time = line.at == null ? "" : `[${new Date(line.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}] `;
  return `${time}${line.kind === "in" ? "> " : ""}${withoutColours(line.text)}`;
}

export function consoleView({ controller }) {
  const histories = new Map();
  const drafts = new Map();
  const copyResults = new Map();
  const emptyLines = [];
  const selected = () => state.admin.servers.some((server) => server.address === state.admin.selected) ? state.admin.selected : null;
  const lines = () => state.admin.consoles.get(selected()) ?? emptyLines;
  const history = () => {
    const address = selected();
    if (!histories.has(address)) histories.set(address, { lines: [], at: 0 });
    return histories.get(address);
  };
  const log = el("div", {
    className: "admin-console__log data", role: "log", "aria-label": "Console output",
    dataset: { focusKey: "admin-console-log" },
  });
  const input = el("input", {
    type: "text", autocomplete: "off", spellcheck: false, "aria-label": "RCON command",
    dataset: { focusKey: "admin-console" },
    oninput: () => { if (selected()) drafts.set(selected(), input.value); },
    onkeydown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void send();
      } else if (selected() && ["ArrowUp", "ArrowDown"].includes(event.key) && history().lines.length) {
        event.preventDefault();
        const entry = history();
        entry.at = Math.max(0, Math.min(entry.lines.length, entry.at + (event.key === "ArrowUp" ? -1 : 1)));
        input.value = entry.lines[entry.at] ?? "";
        drafts.set(selected(), input.value);
      }
    },
  });
  const sendButton = el("button", {
    type: "button", className: "btn", dataset: { focusKey: "admin-console-send" }, onclick: () => void send(),
  }, "Send");
  const clearButton = el("button", {
    type: "button", className: "btn btn--sm", dataset: { focusKey: "admin-console-clear" },
    onclick: () => {
      const address = selected();
      if (!address) return;
      copyResults.delete(address);
      update((next) => next.admin.consoles.set(address, []));
      render();
    },
  }, "Clear");
  const copyResult = el("span", {
    className: "quiet admin-console__copy-result", role: "status", dataset: { focusKey: "admin-console-copy-result" },
  });
  const copyButton = el("button", {
    type: "button", className: "btn btn--sm", dataset: { focusKey: "admin-console-copy" }, onclick: () => void copy(),
  }, "Copy output");
  const root = el("div", { className: "admin-console" },
    el("div", { className: "admin-console__heading" },
      el("p", { className: "label" }, "Console"),
      copyResult, clearButton, copyButton,
    ),
    log,
    el("div", { className: "admin-console__input" },
      el("label", { className: "field" }, el("span", { className: "field__icon", "aria-hidden": "true" }, ">"), input),
      sendButton,
    ),
  );

  async function send() {
    const address = selected();
    const line = input.value.trim();
    if (!address || !line || state.admin.busy.has(busyKey(address, { kind: "console" }))) return;
    const entry = history();
    entry.lines.push(line);
    entry.at = entry.lines.length;
    drafts.set(address, "");
    input.value = "";
    const ok = await controller.act({ kind: "console", line });
    if (!ok && !drafts.get(address)) {
      drafts.set(address, line);
      if (selected() === address) input.value = line;
    }
  }

  async function copy() {
    const address = selected();
    if (!address || !lines().length) return;
    const output = lines().map(lineText).join("\n");
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(output);
      copyResults.set(address, "Output copied.");
    } catch {
      copyResults.set(address, "Could not copy. Select the output and copy it manually.");
    }
    if (selected() === address) copyResult.textContent = copyResults.get(address);
  }

  let paintedAddress;
  let paintedLines;
  function render() {
    const address = selected();
    const changedServer = paintedAddress !== address;
    for (const map of [histories, drafts, copyResults]) {
      for (const key of map.keys()) if (!state.admin.servers.some((server) => server.address === key)) map.delete(key);
    }
    if (changedServer) input.value = drafts.get(address) ?? "";
    const busy = address && state.admin.busy.has(busyKey(address, { kind: "console" }));
    input.disabled = !address;
    input.placeholder = address ? "Type an RCON command" : "Add a server to use the console";
    sendButton.disabled = !address || Boolean(busy);
    sendButton.textContent = busy ? "Sending…" : "Send";
    clearButton.disabled = copyButton.disabled = !lines().length;
    copyResult.textContent = copyResults.get(address) ?? "";
    const content = lines();
    if (!changedServer && content === paintedLines) return;
    const top = log.scrollTop ?? 0;
    const follow = changedServer || !content.length || (log.scrollHeight ?? 0) - (log.clientHeight ?? 0) - top <= 24;
    const retainedAt = changedServer ? -1 : (paintedLines?.indexOf(content[0]) ?? -1);
    // Removing capped history must move the scroll offset by the removed rows' actual height.
    const removedHeight = retainedAt > 0
      ? [...log.children].slice(0, retainedAt).reduce((height, row) => height + (row.getBoundingClientRect?.().height ?? row.offsetHeight ?? 0), 0)
      : 0;
    paintedAddress = address;
    paintedLines = content;
    fill(log, content.map((line) => el("div", { className: `admin-console__line admin-console__line--${line.kind}` }, lineText(line))));
    log.scrollTop = follow ? log.scrollHeight : Math.max(0, top - removedHeight);
  }

  return { root, input, render, clearInput: () => {
    input.value = "";
    if (selected()) drafts.set(selected(), "");
  } };
}
