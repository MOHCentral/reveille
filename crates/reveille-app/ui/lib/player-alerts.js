// SPDX-License-Identifier: GPL-3.0-only

const KEY = "reveille.player-alerts";
const INTERVAL_MS = 60_000;
const COOLDOWN_MS = 15 * 60_000;
const GAMES = new Set(["allied_assault", "spearhead", "breakthrough"]);

export const alertId = (entry) => `${entry.game}|${entry.address}`;

export function playerAlerts() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (entry) =>
        entry &&
        GAMES.has(entry.game) &&
        typeof entry.address === "string" &&
        /^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(entry.address) &&
        Number.isInteger(entry.queryPort) &&
        entry.queryPort > 0 &&
        entry.queryPort <= 65535,
    );
  } catch {
    return [];
  }
}

export function hasPlayerAlert(game, address) {
  return playerAlerts().some((entry) => entry.game === game && entry.address === address);
}

export function addPlayerAlert(row, game) {
  const entry = {
    game,
    address: row.address,
    queryPort: Number(row.server?.endpoint?.query_port),
    hostname: row.server?.hostname || row.address,
  };
  if (
    !GAMES.has(game) ||
    !Number.isInteger(entry.queryPort) ||
    entry.queryPort < 1 ||
    entry.queryPort > 65535
  ) {
    return false;
  }
  return save([...playerAlerts().filter((saved) => alertId(saved) !== alertId(entry)), entry]);
}

export function removePlayerAlert(game, address) {
  save(playerAlerts().filter((entry) => entry.game !== game || entry.address !== address));
}

function save(entries) {
  try {
    localStorage.setItem(KEY, JSON.stringify(entries));
    return true;
  } catch {
    // Browsing and joining still work when preferences cannot be saved.
    return false;
  }
}

/** Unknown breaks continuity; only two successful readings can establish a transition. */
export function nextReading(previous, count, now, cooldownMs = COOLDOWN_MS) {
  if (!Number.isInteger(count) || count < 0) {
    return { state: { ...previous, count: null }, alert: false };
  }
  const alert =
    previous?.count === 0 &&
    count > 0 &&
    now - (previous.lastAlertAt ?? -Infinity) >= cooldownMs;
  return {
    state: { count, lastAlertAt: alert ? now : (previous?.lastAlertAt ?? null) },
    alert,
  };
}

export function startPlayerAlertMonitor(probe, deliver) {
  const readings = new Map();
  let stopped = false;
  let running = false;
  let timer;

  async function poll() {
    if (running || stopped) return;
    running = true;
    clearTimeout(timer);
    for (const entry of playerAlerts()) {
      if (stopped) break;
      const id = alertId(entry);
      let count = null;
      try {
        count = await probe(entry);
      } catch {
        // A failed check is unknown, never an empty server.
      }
      if (!playerAlerts().some((saved) => alertId(saved) === id)) {
        readings.delete(id);
        continue;
      }
      const result = nextReading(readings.get(id), count, Date.now());
      readings.set(id, result.state);
      if (result.alert) {
        try {
          await deliver(entry, count);
        } catch {
          // Delivery must not stop monitoring the remaining servers.
        }
      }
    }
    running = false;
    if (!stopped) timer = setTimeout(poll, INTERVAL_MS);
  }

  void poll();
  return {
    forget(game, address) {
      readings.delete(alertId({ game, address }));
    },
    checkNow() {
      void poll();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
