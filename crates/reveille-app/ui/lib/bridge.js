// SPDX-License-Identifier: GPL-3.0-only

// The only reader of `window.__TAURI__`, which `withGlobalTauri` provides. It is read on each
// call rather than at load, so every module imports in Node, and in the preview, without a bridge
// in place.

function tauri() {
  const bridge = globalThis.window?.__TAURI__;
  if (!bridge) throw new Error("The Tauri bridge is not available.");
  return bridge;
}

export const invoke = (command, args) => tauri().core.invoke(command, args);

/**
 * Invoke `command` with a fresh `tauri::ipc::Channel` as `args[name]`, delivering its messages to
 * `handler`.
 *
 * The channel belongs to this call alone, so its messages need no routing. Tauri orders them among
 * themselves but not against the command's result, and the result is the last word: once the
 * command settles, anything still in flight is dropped.
 */
export async function invokeWithChannel(command, args, name, handler) {
  let open = true;
  const channel = new (tauri().core.Channel)((message) => {
    if (open) handler(message);
  });
  try {
    return await invoke(command, { ...args, [name]: channel });
  } finally {
    open = false;
  }
}

/** Handlers receive the payload, never the Tauri envelope. */
export const listen = (name, handler) => tauri().event.listen(name, (event) => handler(event.payload));

export const openUrl = (url) => tauri().opener.openUrl(url);

export const appVersion = async () => tauri().app.getVersion();

export const focusWindow = () => tauri().window.getCurrentWindow().setFocus();

export const requestAttention = () =>
  tauri().window.getCurrentWindow().requestUserAttention(tauri().window.UserAttentionType.Informational);

export const clearAttention = () => tauri().window.getCurrentWindow().requestUserAttention(null);

/**
 * Commands reject with a plain string. Normalise so callers always get a string
 * to show, whatever the failure was. Windows extended-length prefixes are stripped for the same
 * reason `displayPath` strips them: a message quoting a folder should quote it the way the player
 * would write it.
 */
export function errorText(error) {
  const text =
    typeof error === "string"
      ? error
      : error && typeof error.message === "string"
        ? error.message
        : String(error);
  return text.replace(/\\\\\?\\/g, "");
}
