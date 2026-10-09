// SPDX-License-Identifier: GPL-3.0-only

// The keys Admin owns. Nothing here is remembered between runs: the list of servers is Rust's, in
// the app data directory, and their passwords are in the system's credential store.

export function initial() {
  return {
    admin: {
      /** The servers added, as `admin_servers` lists them. */
      servers: [],
      /** Whether the list has been read once. */
      loaded: false,
      /** Where passwords are kept: "credential_manager", "keychain" or "memory". */
      vault: "memory",
      /** The server on screen, by address. */
      selected: null,
      /** The selected player's slot, so the keyboard reaches that row's actions. */
      player: null,
      /** What each server last said, by address: `{ status, failure, at, loading }`. */
      statuses: new Map(),
      /** Console lines, by address: `{ kind: "in" | "out" | "error", text }`. */
      consoles: new Map(),
      /** Actions waiting on a server's answer, as `address:kind:slot`. */
      busy: new Set(),
    },
  };
}
