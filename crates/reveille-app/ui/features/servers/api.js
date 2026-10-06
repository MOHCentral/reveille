// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/main.rs):
//   browse_servers(session)                    -> BrowserPayload
//   cancel_browse()                            -> void
//   check_server(session, address, queryPort)  -> CheckResult
//
// A `session` is `{ path, engine, game }`: which game folder, which engine program, and which of
// the three games — Allied Assault, Spearhead or Breakthrough. Every server-facing command takes
// all three together, because a folder and an engine without a game names no search path.
//
// Events:
//   reveille://browse   BrowseProgress   { registered, inspected, probed, answered, non_results, row }

import { errorText, invoke, listen } from "../../lib/bridge.js";

export const browseServers = (session) => invoke("browse_servers", { session });

export const cancelBrowse = () => invoke("cancel_browse");

/**
 * Probe one remembered server directly. Resolves either way: a server that did not answer comes
 * back as `{ row: null, non_result }`, and one that answered for another of the three games as
 * `{ row: null, other_game }`. Never a rejection.
 */
export const checkServer = (session, address, queryPort) =>
  invoke("check_server", { session, address, queryPort });

export const onBrowseProgress = (handler) => listen("reveille://browse", handler);

/**
 * `browse_servers` is the one command that rejects with a classified failure rather than a string.
 *
 * `{ kind, detail }`, where `kind` is decided in Rust beside the errors it names — the shell must
 * never read a cause out of a formatted message, which is how "no internet" and "the master sent
 * nonsense" ended up as the same unreadable line. Anything else that
 * reaches this is carried through as `internal` with its own message intact.
 */
export function browseFailure(error) {
  if (error && typeof error === "object" && typeof error.kind === "string") {
    return { kind: error.kind, detail: errorText(error.detail ?? "") };
  }
  return { kind: "internal", detail: errorText(error) };
}
