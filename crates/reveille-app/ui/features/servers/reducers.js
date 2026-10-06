// SPDX-License-Identifier: GPL-3.0-only

// How the server list changes when a sweep, a check or a join reports back. Each takes the draft
// `update()` hands it. Where one also clears a key join owns, it says so: the list is what
// decides whether the selected server still exists.

/** Clear the search box and every chip. */
export function clearFilters(next) {
  next.filters = { query: "", maxPing: null, modes: [], ready: false };
}

/** Player counts by address, for the next sweep to compare against. Bots are not counted. */
export function countsByAddress(rows) {
  const counts = new Map();
  for (const row of rows) {
    const clients = row.server.occupancy?.clients_reported;
    if (Number.isInteger(clients)) counts.set(row.address, clients);
  }
  return counts;
}

/**
 * Swap in a sweep that ran behind the list already on screen.
 *
 * The automatic refresh on return keeps the old rows, selection and pane up while it runs, because
 * clearing them under a player who just came back took away what they were reading. A stopped sweep
 * leaves the old list as it was rather than replacing a full table with a partial one.
 *
 * Returns true when the selected server is still listed but its map or readiness changed, so the
 * pane's sources have to be worked out again.
 */
export function adoptBackgroundSweep(next, payload, at, finishedAt) {
  next.browse.running = false;
  if (payload.cancelled) return false;
  const before = next.servers.find((row) => row.address === next.selected);
  const after = payload.servers.find((row) => row.address === next.selected);
  next.previousCounts = countsByAddress(next.servers);
  next.servers = payload.servers;
  next.summary = payload.summary;
  next.nonResults = payload.non_results;
  next.browse.completedAt = at;
  next.browse.finishedAt = finishedAt;
  next.staleAt = null;
  next.checks = new Map();
  next.checkedAt = new Map();
  next.autoCheckedAt = null;
  if (!after) {
    next.selected = null;
    // Join's keys: its preview was for the server that just left the list.
    next.preview = null;
    next.previewProgress = null;
    next.previewError = null;
    next.joinResult = null;
    return false;
  }
  return (
    before?.server.current_map !== after.server.current_map ||
    JSON.stringify(before?.compatibility) !== JSON.stringify(after.compatibility)
  );
}

/**
 * Carry a completed join's fresh disk assessment back to the server row.
 *
 * The row was measured before its downloads. Leaving it that way makes selecting another server
 * and returning start a new preview for maps Reveille just installed, disabling Join while the
 * server manifest and catalogue are queried again. Only a clean, compatible launch is remembered:
 * any failed server package must leave the old question in place so selecting the row retries it.
 */
export function rememberReadyJoin(next, row, result) {
  if (
    result.outcome?.launch !== "launched" ||
    result.assessment?.state?.state !== "compatible" ||
    result.failures.length !== 0
  ) {
    return;
  }
  const current = next.servers.find((server) => server.address === row.address);
  if (current) current.compatibility = result.assessment;
  // Join's keys: the preview priced downloads that are now on disk.
  next.preview = null;
  next.previewProgress = null;
  next.previewError = null;
  next.choices = new Map();
}

/**
 * What a single-server check that got no answer does to the list.
 *
 * A check that ran and got no answer is evidence about *now*, and it outranks whatever the sweep
 * saw. The live row for this address is **dropped** rather than left standing with figures this
 * check has just shown are no longer current — and its freshness stamp goes
 * with it, because a time is a claim about a measurement that no longer exists.
 *
 * `dropped` carries the name the row had, so the pane can still say what the check was about.
 */
export function applyCheckNonResult(next, entry, result, dropped) {
  next.checks.set(entry.address, {
    status: "absent",
    nonResult: result.non_result,
    otherGame: result.other_game,
    dropped,
  });
  next.servers = next.servers.filter((row) => row.address !== entry.address);
  next.checkedAt.delete(entry.address);
}

/**
 * What a single-server check that answered does to the list.
 *
 * A server publishes its own game port, so one that moved now publishes a different game address.
 * The row is real and joins at the address it published; what the player selected or starred is
 * left pointing where they put it, because a shared query port is not proof of the same server.
 * The old address keeps an entry saying where the answer came from.
 *
 * The old *row* goes, though, which is where this differs from `merge_checked_server` on the Rust
 * side: that function sees two game endpoints and cannot tell they came from one query port, so it
 * keeps both. Here the check was addressed to that query port, and nothing now vouches for the
 * game address it used to publish.
 *
 * Both the address asked and the address that answered give way to the new row. Filtering only the
 * second would leave a server that moved listed twice, once with its old figures.
 */
export function applyCheckedRow(next, entry, result, dropped, at) {
  if (result.row.address !== entry.address) {
    next.checks.set(entry.address, { status: "absent", movedTo: result.row.address, dropped });
  } else {
    next.checks.delete(entry.address);
    const before = next.servers.find((row) => row.address === entry.address);
    const clients = before?.server.occupancy?.clients_reported;
    if (Number.isInteger(clients)) next.previousCounts.set(entry.address, clients);
  }
  next.servers = [
    ...next.servers.filter(
      (row) => row.address !== result.row.address && row.address !== entry.address,
    ),
    result.row,
  ];
  next.checkedAt.delete(entry.address);
  next.checkedAt.set(result.row.address, at);
}
