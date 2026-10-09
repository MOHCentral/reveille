// SPDX-License-Identifier: GPL-3.0-only

// OpenMoHAA code/fgame/bg_public.h:112-123 defines these multiplayer modes.
export const GAME_TYPES = { 1: "Free-for-all", 2: "Team match", 3: "Round-based match", 4: "Objective match" };

export function actionFeedback(action, phase) {
  const messages = {
    change_map: [`Changing map to ${action.map}…`, `Map change to ${action.map} sent.`],
    restart_round: ["Restarting round…", "Round restart sent."],
    set_rotation: ["Saving rotation…", "Rotation saved."],
    set_game_type: ["Setting game type…", `${GAME_TYPES[action.game_type] ?? action.game_type} queued for next map load.`],
    say: ["Sending message…", "Message sent."],
    message: ["Sending player message…", "Player message sent."],
    kick: ["Kicking player…", "Kick sent."],
    ban: ["Banning player…", "Ban sent."],
    console: ["Sending command…", "Command sent."],
  };
  return { kind: action.kind, phase, text: (messages[action.kind] ?? ["Sending action…", "Action sent."])[phase === "busy" ? 0 : 1] };
}

export function freshness(entry, now = Date.now()) {
  if (entry?.at == null) return entry?.loading ? "Fetching status…" : "No status received yet";
  const seconds = Math.max(0, Math.floor((now - entry.at) / 1000));
  const age = seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)} min ago` : `${Math.floor(seconds / 3600)}h ago`;
  return `${entry.failure ? "Last update" : "Updated"} ${age}${entry.failure ? " · stale" : ""}${entry.loading ? " · refreshing…" : ""}`;
}
