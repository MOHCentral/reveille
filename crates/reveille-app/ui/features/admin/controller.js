// SPDX-License-Identifier: GPL-3.0-only

// Reading each server's status while Admin is on screen, running actions one at a time, and adding
// and removing servers.

import { errorText } from "../../lib/shell.js";
import { state, update } from "../../lib/store.js";
import { adminAction, adminServers, adminStatus, addAdminServer, removeAdminServer } from "./api.js";
import { actionFeedback, GAME_TYPES } from "./format.js";

/** How often the server on screen is asked again. Two requests each time, well under any limit. */
export const POLL_MS = 5_000;
/** Console lines kept per server. */
export const CONSOLE_LIMIT = 200;

/** What the console echoes for an action, in place of the command the server receives. */
export function echo(action, players = []) {
  const who = (slot) => players.find((player) => player.slot === slot)?.name ?? `player ${slot}`;
  switch (action.kind) {
    case "kick":
      return `kick ${who(action.slot)}`;
    case "ban":
      return `ban ${who(action.slot)}`;
    case "message":
      return `message ${who(action.slot)}: ${action.text}`;
    case "say":
      return `say ${action.text}`;
    case "change_map":
      return `map ${action.map}`;
    case "restart_round":
      return "restart";
    case "set_rotation":
      return `rotation ${action.maps.join(" ")}`;
    case "set_game_type":
      return `g_gametype ${action.game_type} (next map load)`;
    default:
      return action.line;
  }
}

/** Actions after which the status on screen is out of date. */
const CHANGES_STATUS = new Set(["kick", "ban", "change_map", "restart_round", "set_rotation", "set_game_type", "console"]);

export function adminController({ onListChanged = () => {} } = {}) {
  let timer = null;
  const generations = new Map();
  const generation = (address) => generations.get(address) ?? 0;
  const current = (address, epoch) => generation(address) === epoch && state.admin.servers.some((server) => server.address === address);

  async function load() {
    const overview = await adminServers().catch(() => null);
    if (!overview) return;
    update((next) => {
      next.admin.servers = overview.servers;
      next.admin.vault = overview.vault;
      next.admin.loaded = true;
      if (!overview.servers.some((server) => server.address === next.admin.selected)) {
        next.admin.selected = overview.servers[0]?.address ?? null;
        next.admin.player = null;
      }
    });
    onListChanged();
  }

  async function refresh(address = state.admin.selected) {
    const epoch = generation(address);
    if (!address || !current(address, epoch) || state.admin.statuses.get(address)?.loading) return;
    update((next) => {
      const known = next.admin.statuses.get(address);
      next.admin.statuses.set(address, { status: null, failure: null, at: null, ...known, loading: true });
    });
    try {
      const status = await adminStatus(address);
      update((next) => {
        if (!current(address, epoch)) return;
        next.admin.statuses.set(address, { status, failure: null, at: Date.now(), loading: false });
        if (next.admin.pendingGameTypes.get(address) === status.game_type_number) {
          next.admin.pendingGameTypes.delete(address);
          const feedback = next.admin.feedback.get(address);
          if (feedback?.kind === "set_game_type" && feedback.phase === "success") {
            next.admin.feedback.set(address, { ...feedback, text: `${GAME_TYPES[status.game_type_number]} is active.` });
          }
        }
        if (next.admin.selected === address && !status.players.some((player) => player.slot === next.admin.player)) {
          next.admin.player = null;
        }
      });
    } catch (error) {
      // The last answer stays on screen, marked stale by the failure beside it.
      update((next) => {
        if (!current(address, epoch)) return;
        const known = next.admin.statuses.get(address);
        next.admin.statuses.set(address, { ...known, failure: failureOf(error), loading: false });
      });
    }
  }

  /** Poll the server on screen while `active`; stop when Admin is left. */
  function watch(active) {
    if (active && !timer) {
      // Set before the first refresh, whose update re-enters `watch` through the render.
      timer = setInterval(() => {
        if (globalThis.document?.visibilityState !== "hidden") void refresh();
      }, POLL_MS);
      void refresh();
    } else if (!active && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function select(address) {
    if (state.admin.selected === address) return;
    update((next) => {
      next.admin.selected = address;
      next.admin.player = null;
    });
    void refresh(address);
  }

  function selectPlayer(slot) {
    update((next) => (next.admin.player = slot));
  }

  function log(address, kind, text, epoch) {
    update((next) => {
      if (!current(address, epoch)) return;
      const lines = [...(next.admin.consoles.get(address) ?? []), { kind, text, at: Date.now() }];
      next.admin.consoles.set(address, lines.slice(-CONSOLE_LIMIT));
    });
  }

  /** Run `action` on the server on screen; resolves to whether the server took it. */
  async function act(action) {
    const address = state.admin.selected;
    const epoch = generation(address);
    if (!address || !current(address, epoch)) return false;
    const key = busyKey(address, action);
    if (state.admin.busy.has(key)) return false;
    const players = state.admin.statuses.get(address)?.status?.players ?? [];
    const feedback = actionFeedback(action, "busy");
    update((next) => {
      next.admin.busy.add(key);
      next.admin.feedback.set(address, feedback);
    });
    log(address, "in", echo(action, players), epoch);
    let ok = false;
    try {
      const output = await adminAction(address, action);
      if (output.trim()) log(address, "out", output.trimEnd(), epoch);
      ok = current(address, epoch);
      update((next) => {
        if (!current(address, epoch)) return;
        if (action.kind === "set_game_type") next.admin.pendingGameTypes.set(address, action.game_type);
        if (next.admin.feedback.get(address) === feedback) next.admin.feedback.set(address, actionFeedback(action, "success"));
      });
    } catch (error) {
      log(address, "error", errorText(error), epoch);
      update((next) => {
        if (next.admin.feedback.get(address) === feedback) next.admin.feedback.set(address, { phase: "error", text: errorText(error) });
      });
    } finally {
      update((next) => { if (generation(address) === epoch) next.admin.busy.delete(key); });
    }
    if (ok && CHANGES_STATUS.has(action.kind)) void refresh(address);
    return ok;
  }

  /** Add a server, or give one a new password. Rejects with the failure to show in the dialog. */
  async function add(address, password) {
    const server = await addAdminServer(address, password);
    update((next) => {
      next.admin.selected = server.address;
      next.admin.statuses.delete(server.address);
    });
    await load();
    void refresh(server.address);
    return server;
  }

  async function remove(address) {
    await removeAdminServer(address);
    generations.set(address, generation(address) + 1);
    update((next) => {
      next.admin.servers = next.admin.servers.filter((server) => server.address !== address);
      if (next.admin.selected === address) {
        next.admin.selected = next.admin.servers[0]?.address ?? null;
        next.admin.player = null;
      }
      for (const key of next.admin.busy) if (key.startsWith(`${address}:`)) next.admin.busy.delete(key);
      next.admin.statuses.delete(address);
      next.admin.consoles.delete(address);
      next.admin.feedback.delete(address);
      next.admin.pendingGameTypes.delete(address);
      next.admin.messageDrafts.delete(address);
    });
    await load();
  }

  return { load, refresh, watch, select, selectPlayer, act, add, remove };
}

export function busyKey(address, action) {
  return `${address}:${action.kind}:${action.slot ?? ""}`;
}

/** A failure as Rust classified it, or a plain one when something else went wrong. */
export function failureOf(error) {
  if (error && typeof error === "object" && typeof error.reason === "string") {
    return { reason: error.reason, message: String(error.message ?? "") };
  }
  return { reason: "no_answer", message: errorText(error) };
}
