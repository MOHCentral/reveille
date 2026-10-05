// SPDX-License-Identifier: GPL-3.0-only

// The detail pane. Selecting a server previews the join in place, so the list
// never disappears and servers stay comparable.
//
// This is where two of the four canonical state names are rendered — Needs N
// maps and No download for N maps — because this is where the decision is made.
// The list deliberately does not repeat them as badges. Each name states what
// Reveille measured rather than how confident it feels about it
// (features/join/format.js `stateName`).
//
// Compatible and Map list not published are rendered nowhere before the join.
// Neither leaves the player anything to do, and a heading above a button reading
// `Join` restates the control beneath it. Silence is the correct rendering of
// "nothing to do". A missing current map is still called out by the action bar.
//
// The join gate is about the map running *now*, not the whole rotation. A server
// with one unobtainable map later in its rotation is perfectly playable until it
// reaches that map; refusing the join would invent a problem the engine does not
// have. What is refused is joining a server whose current map is absent, because
// that connection fails immediately.

import { el, fill, frag, preserveFocus } from "../lib/dom.js";
import {
  bytes,
  clockTime,
  displayPath,
  engineLabel,
  gameType,
  launchedLabel,
  mapKey,
  mapName,
  occupancy,
  occupancyText,
  playerRoster,
  plural,
  rosterShortfall,
  roundTrip,
  shortVersion,
} from "../lib/format.js";
import { nonResultReason } from "../features/servers/format.js";
import { stateExplanation, stateName } from "../features/join/format.js";
import { historyByAddress, isFavorite, toggleFavorite } from "../lib/bookmarks.js";
import { icon } from "../lib/icons.js";
import { THRESHOLDS, playerAlert, setAlertThreshold } from "../lib/player-alerts.js";
import { closePopover, openPopover } from "../lib/popover.js";
import { GAME_LABELS } from "../lib/catalog.js";
import {
  canRecheck,
  playableGames,
  selectedRow,
  state,
  update,
} from "../lib/store.js";

export function joinView(root, { onInstallServerFiles, onJoin, onRecheck, onTogglePlayerAlert }) {
  const scroll = el("div", { className: "detail-pane__scroll" });
  // Rendered inside the scroll, right under what it acts on, and sticky so a long list of choices
  // cannot push it out of reach.
  const actions = el("div", { className: "actions" });
  fill(root, scroll);
  // Set by a double-click or Enter on a row that needs something first. Join is disabled while the
  // downloads are being priced, so focus waits for the first render where it can land.
  let focusJoinFor = null;

  const render = () => {
    const row = selectedRow();
    // A selection whose row has left the list because a check found it gone. The pane keeps the
    // player's place and says what the check found, rather than emptying with no explanation.
    const gone = !row && state.selected ? state.checks.get(state.selected) : null;
    if (!row && !gone?.dropped) {
      fill(scroll, idlePlaceholder());
      return;
    }
    preserveFocus(root, () => {
      fill(
        actions,
        ...(row
          ? actionBar(row, onInstallServerFiles, onJoin)
          : goneActions(state.selected, gone, onRecheck)),
      );
      fill(
        scroll,
        row
          ? body(row, actions, onRecheck, onTogglePlayerAlert)
          : frag(gonePane(state.selected, gone), actions),
      );
    });
    if (focusJoinFor !== null) {
      const join = actions.querySelector('[data-focus-key="join"]');
      if (focusJoinFor !== row?.address) focusJoinFor = null;
      else if (join && !join.disabled) {
        focusJoinFor = null;
        join.focus();
      }
    }
  };

  const focusJoin = (address) => {
    focusJoinFor = address;
    render();
  };

  return { render, focusJoin };
}

function idlePlaceholder() {
  return el(
    "div",
    { className: "placeholder" },
    el("h3", null, "No server selected"),
    el("p", null, "Pick one to see what it needs."),
  );
}

function body(row, actions, onRecheck, onTogglePlayerAlert) {
  const { server, compatibility } = row;
  const preview = state.preview?.address === row.address ? state.preview : null;
  const assessment = preview?.assessment ?? compatibility;
  const run = state.installRun;
  const result = state.joinResult?.address === row.address ? state.joinResult : null;

  return frag(
    header(row, server, onRecheck, onTogglePlayerAlert),
    facts(server),
    result ? outcomeSection(result) : null,
    run ? installSection(run) : null,
    !run && !result ? needsSection(assessment, preview, server) : null,
    actions,
    playersSection(server),
    afterChecks(row.address),
    more(row, server),
  );
}

function header(row, server, onRecheck, onTogglePlayerAlert) {
  const starred = isFavorite(row.address);
  const watch = playerAlert(state.game, row.address);
  const watched = Boolean(watch);
  const name = server.hostname || "(unnamed server)";
  return el(
    "div",
    { className: "detail__head" },
    el("h2", { className: "detail__title", title: name }, name),
    el(
      "div",
      { className: "detail__marks" },
      markToggle({
        kind: "star",
        on: starred,
        label: "Favorite",
        focusKey: "detail-star",
        title: starred ? "Remove from Favorites (F)" : "Keep this server in Favorites (F)",
        onclick: () => {
          toggleFavorite(row);
          update(() => {});
        },
      }),
      markToggle({
        kind: "bell",
        on: watched,
        label: watched ? "Watching" : "Watch",
        focusKey: "detail-player-alert",
        title: watched
          ? "Stop notifying me about this server (W)"
          : "Notify me when players join this server (W)",
        onclick: () => void onTogglePlayerAlert(row),
      }),
      watched &&
        el(
          "button",
          {
            type: "button",
            className: "mark-toggle mark-toggle--rule",
            dataset: { focusKey: "detail-watch-rule" },
            "aria-haspopup": "dialog",
            "aria-expanded": "false",
            "aria-label": `Watch rule: notify at ${watch.threshold} ${watch.threshold === 1 ? "player" : "players"}`,
            title: "When to notify",
            onclick: (event) => openWatchRule(event.currentTarget, row, watch, onTogglePlayerAlert),
          },
          `${watch.threshold}+`,
          el("span", { className: "mark-toggle__caret", "aria-hidden": "true" }, "▾"),
        ),
      reloadButton(row, onRecheck),
    ),
  );
}

/**
 * The selected server, asked again on its own. No Stop, unlike the toolbar's Refresh: one server
 * gives up within the probe timeout, too soon for a Stop to be worth reaching for.
 */
function reloadButton(row, onRecheck) {
  const checking = state.checks.get(row.address)?.status === "checking";
  const sweeping = state.browse.running;
  const at = state.checkedAt.get(row.address) ?? state.browse.finishedAt;
  return el(
    "button",
    {
      type: "button",
      className: checking ? "pane-reload pane-reload--running" : "pane-reload",
      // `aria-disabled`, not `disabled`: this button disables itself the moment it is pressed,
      // and focus cannot be restored to a disabled element after the repaint, so a keyboard
      // player would lose the caret on every check. `canRecheck` refuses the press instead.
      "aria-disabled": canRecheck(row.address) ? null : "true",
      "aria-label": checking ? "Refreshing this server" : "Refresh this server",
      dataset: { focusKey: "detail-recheck" },
      title: sweeping
        ? "The whole list is being refreshed, this server with it"
        : at
          ? `Figures from ${clockTime(new Date(at))}. Refresh this server (R)`
          : "Refresh this server (R)",
      onclick: () => onRecheck(row),
    },
    icon("reload", { outline: true }),
  );
}


/** The watch's one rule: how many players make it worth a notification. Bots never count. */
function openWatchRule(anchor, row, watch, onTogglePlayerAlert) {
  const choose = (threshold) => {
    setAlertThreshold(state.game, row.address, threshold);
    closePopover({ restoreFocus: true });
    update(() => {});
  };
  openPopover(
    anchor,
    "Watch rule",
    el("div", { className: "popover__head" }, el("h2", { className: "popover__title" }, "Notify me when")),
    el(
      "div",
      { className: "watch-rule" },
      el("p", { className: "watch-rule__label" }, "players reach"),
      el(
        "div",
        { className: "watch-rule__choices", role: "radiogroup", "aria-label": "Players needed" },
        THRESHOLDS.map((threshold) =>
          el(
            "button",
            {
              type: "button",
              role: "radio",
              className: "watch-rule__choice",
              "aria-checked": String(threshold === watch.threshold),
              onclick: () => choose(threshold),
            },
            String(threshold),
          ),
        ),
      ),
      el("p", { className: "quiet" }, "Bots are not counted."),
    ),
    el(
      "div",
      { className: "popover__foot" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn--sm btn--utility",
          onclick: () => {
            closePopover();
            void onTogglePlayerAlert(row);
          },
        },
        "Stop watching",
      ),
    ),
  );
}

function markToggle({ kind, on, label, focusKey, title, onclick }) {
  return el(
    "button",
    {
      type: "button",
      className: `mark-toggle mark-toggle--${kind}`,
      dataset: { focusKey },
      "aria-pressed": on ? "true" : "false",
      title,
      onclick,
    },
    icon(kind, { outline: !on }),
    label,
  );
}

/** The six figures a player compares servers by, laid out two rows of three. */
function facts(server) {
  const counts = occupancy(server);
  const ping = roundTrip(server);
  const mode = gameType(server);
  const full = counts.capacity && counts.clients >= counts.capacity;
  return el(
    "dl",
    { className: "facts" },
    fact(
      "Players",
      counts.clients === null
        ? "—"
        : [
            el("strong", { className: full ? "facts__full" : null }, String(counts.clients)),
            counts.capacity ? `/${counts.capacity}` : "",
          ],
      occupancyText(counts),
    ),
    fact("Bots", counts.bots ? String(counts.bots) : "none"),
    fact(
      "Ping",
      ping.band
        ? [el("span", { className: `ping-dot ping-dot--${ping.band}`, "aria-hidden": "true" }), ping.text]
        : ping.text,
      ping.title,
    ),
    fact(
      "Map",
      server.current_map ? mapName(server.current_map) : "—",
      server.current_map ? mapName(server.current_map) : "This server did not publish its map.",
    ),
    fact("Mode", mode.text, mode.title),
    fact("Version", shortVersion(server), engineLabel(server)),
  );
}

function fact(term, value, title = null) {
  return el("div", { className: "fact", title }, el("dt", null, term), el("dd", null, value));
}

const PLAYERS_SHOWN = 8;

// Module state for the same reason as `moreOpen` below.
let allPlayersShown = false;

/**
 * Who is on the server, from the same reading as the figures above, so the freshness line covers
 * it. Placed after the action bar because it informs the join without deciding it.
 */
function playersSection(server) {
  const roster = playerRoster(server);
  if (roster.length === 0) return null;
  const scored = roster.some((player) => Number.isInteger(player.kills));
  const shown = allPlayersShown ? roster : roster.slice(0, PLAYERS_SHOWN);
  const shortfall = rosterShortfall(server, roster.length);
  return el(
    "section",
    { className: "detail__section players", "aria-label": "Players on this server" },
    el(
      "table",
      { className: "players__table" },
      el(
        "thead",
        null,
        el(
          "tr",
          null,
          el("th", { scope: "col" }, "Player"),
          scored && el("th", { scope: "col", className: "players__num" }, "Kills"),
          scored && el("th", { scope: "col", className: "players__num" }, "Deaths"),
          el(
            "th",
            {
              scope: "col",
              className: "players__num",
              title: "The ping this server measured for each player, in milliseconds.",
            },
            "Ping",
          ),
        ),
      ),
      el(
        "tbody",
        null,
        shown.map((player) => playerRow(player, scored)),
      ),
    ),
    roster.length > PLAYERS_SHOWN &&
      el(
        "button",
        {
          type: "button",
          className: "detail__more-toggle",
          "aria-expanded": allPlayersShown ? "true" : "false",
          dataset: { focusKey: "detail-players" },
          onclick: () => {
            allPlayersShown = !allPlayersShown;
            update(() => {});
          },
        },
        allPlayersShown ? "Show fewer" : `Show all ${roster.length}`,
      ),
    shortfall && el("p", { className: "players__note" }, shortfall),
  );
}

function playerRow(player, scored) {
  const figure = (value) => (Number.isInteger(value) ? String(value) : "—");
  return el(
    "tr",
    null,
    player.name
      ? el("td", { className: "players__name", title: player.name }, player.name)
      : el("td", { className: "players__name players__name--unnamed" }, "No name"),
    scored && el("td", { className: "players__num" }, figure(player.kills)),
    scored && el("td", { className: "players__num" }, figure(player.deaths)),
    el("td", { className: "players__num" }, figure(player.ping)),
  );
}

// Module state rather than store state: whether the fold is open is a reading preference that
// should survive selecting another server, and nothing else in the app depends on it.
let moreOpen = false;

/** Everything about the server that does not decide the join, folded away until asked for. */
function more(row, server) {
  return el(
    "div",
    { className: "detail__more" },
    el(
      "button",
      {
        type: "button",
        className: "detail__more-toggle",
        "aria-expanded": moreOpen ? "true" : "false",
        dataset: { focusKey: "detail-more" },
        onclick: () => {
          moreOpen = !moreOpen;
          update(() => {});
        },
      },
      "More about this server",
    ),
    moreOpen ? moreFacts(row, server) : null,
  );
}

function moreFacts(row, server) {
  const rotation = server.rotation ?? [];
  const limits = pingLimits(server);
  return el(
    "dl",
    { className: "kv" },
    el("dt", null, "Address"),
    el(
      "dd",
      { className: "detail__address" },
      el("span", { className: "data selectable" }, row.address),
      el(
        "button",
        {
          type: "button",
          className: "btn btn--sm",
          dataset: { focusKey: "detail-copy" },
          // No failure notice: the clipboard is only unavailable where the address can still be
          // selected and copied by hand, right beside this button.
          onclick: (event) => {
            const button = event.currentTarget;
            navigator.clipboard
              ?.writeText(row.address)
              .then(() => (button.textContent = "Copied"))
              .catch(() => {});
          },
        },
        "Copy",
      ),
    ),
    el("dt", null, "Map list"),
    el(
      "dd",
      null,
      rotation.length ? rotation.map((map) => mapName(map)).join(", ") : "not published",
    ),
    el("dt", null, "Downloads"),
    el("dd", null, downloadPolicy(server.allow_download)),
    el("dt", null, "Checksum"),
    el(
      "dd",
      null,
      server.map_checksum === null || server.map_checksum === undefined
        ? "not published, so maps are matched by name only"
        : "published",
    ),
    limits ? el("dt", null, "Ping limit") : null,
    limits ? el("dd", null, limits) : null,
    server.reserved_slots ? el("dt", null, "Reserved") : null,
    server.reserved_slots
      ? el("dd", null, `${plural(server.reserved_slots, "slot")} held back`)
      : null,
    el("dt", null, "Build"),
    el("dd", null, engineLabel(server)),
  );
}

function downloadPolicy(allow) {
  if (allow === null || allow === undefined) return "not published";
  return Number(allow) === 0 ? "the server sends no files" : "the server sends missing files";
}

/** The server's own admission gate, which is not the round trip shown above. */
function pingLimits(server) {
  const min = Number(server.minimum_ping) || 0;
  const max = Number(server.maximum_ping) || 0;
  if (min > 0 && max > 0) return `${min} to ${max} ms`;
  if (max > 0) return `up to ${max} ms`;
  if (min > 0) return `at least ${min} ms`;
  return null;
}

/**
 * What a check left to say beyond the new figures, and when the game was last started here.
 *
 * A check that never ran is not a server that did not answer, and the figures above are still
 * the last thing actually measured. Saying so is what stops an unchanged age from reading as a
 * fresh confirmation.
 */
function afterChecks(address) {
  const check = state.checks.get(address);
  const failed =
    check?.status === "failed" && !state.browse.running
      ? el("p", { className: "error", role: "alert" }, `The check could not run. ${check.error}`)
      : null;
  const launched = launchedLine(address);
  if (!failed && !launched) return null;
  return el("div", { className: "detail__freshness" }, failed, launched);
}

function launchedLine(address) {
  const launched = launchedLabel(historyByAddress().get(address));
  if (!launched) return null;
  return el(
    "p",
    { className: "quiet", title: "Last time Reveille started the game on this server." },
    launched,
  );
}

/**
 * The selected server, after a check that ran and found it no longer there.
 *
 * The row has left the list, because a check that got no answer is evidence about now and the
 * client count, map and round trip it replaced are not. Emptying the pane
 * instead would lose the player's place and say nothing about why, so what is left is the name it
 * had, the address, what the check found, and the one thing that can change the answer.
 *
 * The name is drawn in the remembered style, like an absent row's, because it is the only thing
 * here that came from a past reading.
 */
function gonePane(address, check) {
  return frag(
    el(
      "div",
      { className: "detail__head" },
      el(
        "h2",
        { className: "detail__title detail__title--remembered" },
        check.dropped.hostname || "(unnamed server)",
      ),
      el("p", { className: "data quiet selectable" }, address),
    ),
    el(
      "div",
      { className: "detail__section" },
      el("p", { className: "label" }, "Last check"),
      el("h3", { className: "display heading-sm" }, goneHeadline(check)),
      el("p", { className: "quiet" }, goneDetail(check, address)),
    ),
  );
}

function goneHeadline(check) {
  if (check.status === "checking") return "Checking…";
  if (check.status === "failed") return "The check did not run";
  if (check.otherGame) return `Runs ${GAME_LABELS[check.otherGame] ?? check.otherGame}`;
  if (check.movedTo) return "Answers at another address";
  return "Did not answer";
}

function goneDetail(check, address) {
  if (check.status === "checking") return `Asking ${address} again.`;
  if (check.status === "failed") return `The check could not run. ${check.error}`;
  if (check.otherGame) {
    const name = GAME_LABELS[check.otherGame] ?? check.otherGame;
    return playableGames(state.install).includes(check.otherGame)
      ? `It answered for ${name}. Switch this session to ${name} to join it.`
      : `It answered for ${name}, which this game folder cannot run.`;
  }
  // "Publishes", not "replied from": the reply came from the query port that was asked. What moved
  // is the game address the server publishes in it.
  if (check.movedTo) {
    return `It now publishes ${check.movedTo} as its game address, which is in the list.`;
  }
  if (check.nonResult) return `This server ${nonResultReason(check.nonResult)}.`;
  return "This server is offline.";
}

/**
 * What this server needs — and nothing at all when it needs nothing.
 *
 * Until 27 Aug 2026 this was two sections. **Before you join** restated a verdict the primary
 * button already carries in its own label, and **Maps** listed the whole published rotation,
 * every map already on disk included, under headings that were mostly empty. A ready server —
 * the ordinary case, and the one a player is trying to pick out of the list — drew two headings,
 * a state name and a paragraph of maps it already has, and pushed the address and the freshness
 * line below the fold to do it. A ready server says nothing; silence is the correct rendering of
 * "nothing to do", and an explanation earns a paragraph only if it changes the next click.
 *
 * So this returns `null` outright for a compatible server with nothing to qualify. What survives
 * is what changes the click: the state and how it was reached, what it costs, and the one choice
 * Reveille refuses to make on the player's behalf.
 *
 * The rotation is not drawn at all. A map already on disk needs no row; a missing map that
 * resolves is a number in the button, not a list to read; and *which* maps have no download
 * changes nothing the player can do about them, so the state name counts them and stops there.
 * The single map that does block a join — the one running right now — is named by the action bar,
 * which is where the block is.
 */
function needsSection(assessment, preview, server) {
  const resolving = state.previewProgress && !preview;
  const totals = preview ? shoppingTotals(preview) : null;
  const explanation = stateExplanation(assessment.state);
  const notes = caveats(server, ["compatible", "cant_tell"].includes(assessment.state?.state));
  const costly = Boolean(totals && (totals.count > 0 || totals.serverFiles > 0));
  const serverStageUnresolved =
    Number(totals?.serverFiles ?? 0) > 0 || Boolean(totals?.retryServerFiles);
  const choices = serverStageUnresolved
    ? []
    : (preview?.catalogue?.resolutions ?? []).filter(
        (resolution) => resolution.outcome === "choice_required",
      );

  if (!resolving && !explanation && !costly && !choices.length && !notes && !state.previewError) {
    return null;
  }

  return el(
    "div",
    { className: "detail__section" },
    // The state name is drawn only when it qualifies something. "Compatible" over a button that
    // already reads `Join` is a heading restating the control beneath it.
    explanation ? el("h3", { className: "display heading-sm" }, stateName(assessment.state)) : null,
    // Persistent, not a tooltip: this sentence is what makes the name above it a decision, and a
    // title is unreachable by keyboard and by touch.
    explanation ? el("p", { className: "verdict-note" }, explanation) : null,
    resolving ? resolvingMeter() : null,
    totals?.serverFiles > 0
      ? el(
          "div",
          { className: "headline-number" },
          el("strong", null, plural(totals.serverFiles, "server file")),
          el("span", { className: "quiet" }, "Download size not provided"),
        )
      : null,
    totals?.serverFiles > 0
      ? el(
          "p",
          { className: "verdict-note" },
          "Reveille will install and verify these files, then check whether anything else is needed.",
        )
      : null,
    !serverStageUnresolved && totals?.count > 0
      ? el(
          "div",
          { className: "headline-number" },
          el("strong", null, bytes(totals.size)),
          el(
            "span",
            { className: "quiet" },
            `to fetch · ${plural(totals.count, "file")}${totals.pending ? ` · ${totals.pending} awaiting a choice` : ""}`,
          ),
        )
      : null,
    preview?.pakradar?.non_result
      ? el(
          "p",
          { className: "quiet", title: preview.pakradar.non_result },
          "The server's download list did not answer. Retry it before the map catalogue is checked.",
        )
      : null,
    state.previewError ? el("p", { className: "error", role: "alert" }, state.previewError) : null,
    choices.length
      ? el(
          "div",
          { className: "rot" },
          el(
            "p",
            {
              className: "label group-title",
              title:
                "The catalogue files these under a different name. Reveille never picks for you, and checks the archive contents after downloading.",
            },
            "Needs your choice",
          ),
          choices.map((resolution) => choiceBlock(resolution)),
        )
      : null,
    notes,
  );
}

function resolvingMeter() {
  const { index, of, map } = state.previewProgress;
  const percent = of > 0 ? Math.round(((index + 1) / of) * 100) : 0;
  const status = of > 0 ? `looking up ${mapName(map)} · ${index + 1}/${of}` : "checking downloads…";
  return el(
    "div",
    { className: "stack--tight" },
    el(
      "div",
      {
        className: "meter",
        role: "progressbar",
        "aria-label": "Looking up missing maps",
        "aria-valuenow": index + 1,
        "aria-valuemin": 0,
        "aria-valuemax": of,
      },
      el("span", { className: "meter__fill", style: `width:${percent}%` }),
    ),
    el("p", { className: "quiet data" }, status),
  );
}

function line(mark, kind, name, trailing) {
  return el(
    "div",
    { className: "rot__row" },
    el("span", { className: `rot__mark rot__mark--${kind}`, "aria-hidden": "true" }, mark),
    el("span", { className: "rot__name", title: name }, name),
    trailing ? el("span", { className: "rot__size" }, trailing) : null,
  );
}

function choiceBlock(resolution) {
  const name = resolution.wanted.name;
  const chosen = state.choices.get(name) ?? null;
  return frag(
    line("?", "choose", mapName(name), plural(resolution.choices.length, "candidate")),
    el(
      "div",
      { className: "choices", role: "radiogroup", "aria-label": `Source for ${mapName(name)}` },
      resolution.choices.map((candidate) =>
        el(
          "label",
          { className: "choice" },
          el("input", {
            type: "radio",
            name: `choice-${name}`,
            value: String(candidate.id),
            checked: chosen === candidate.id,
            dataset: { focusKey: `choice-${name}-${candidate.id}` },
            onchange: () => update((next) => next.choices.set(name, candidate.id)),
          }),
          el(
            "span",
            { className: "choice__body" },
            el("span", { className: "choice__file" }, candidate.filename),
            el(
              "span",
              { className: "choice__meta" },
              `${bytes(candidate.file_size)} · ${candidate.downloads} downloads${candidate.map_file_tested ? " · tested" : ""}`,
            ),
          ),
        ),
      ),
    ),
  );
}

function installSection(run) {
  return el(
    "div",
    { className: "detail__section" },
    el("p", { className: "label" }, run.done ? "Finished" : "Getting files"),
    el(
      "div",
      { className: "install-list" },
      [...run.items.values()].map((item) => installItem(item)),
    ),
    run.items.size === 0 ? el("p", { className: "quiet" }, "Preparing…") : null,
  );
}

function installItem(item) {
  const percent =
    item.total && item.total > 0 ? Math.min(100, Math.round((item.received / item.total) * 100)) : 0;
  let stateText = "waiting";
  if (item.phase === "downloading") {
    stateText = item.total ? `${bytes(item.received)} / ${bytes(item.total)}` : bytes(item.received);
  }
  else if (item.phase === "confirming") stateText = "checking the file";
  else if (item.phase === "installed") stateText = "installed";
  else if (item.phase === "failed") stateText = "failed";

  return el(
    "div",
    { className: "install-item" },
    el(
      "div",
      { className: "install-item__head" },
      el("span", { className: "install-item__name", title: item.filename }, mapName(item.map)),
      el(
        "span",
        { className: `install-item__state${item.phase === "failed" ? " failed" : ""}` },
        stateText,
      ),
    ),
    item.phase === "downloading"
      ? el(
          "div",
          { className: `meter${item.total ? "" : " meter--indeterminate"}` },
          el("span", { className: "meter__fill", style: item.total ? `width:${percent}%` : null }),
        )
      : null,
    item.phase === "failed" ? el("p", { className: "quiet" }, item.reason) : null,
  );
}

function outcomeSection(result) {
  const launched = result.outcome.launch === "launched";
  return el(
    "div",
    { className: "detail__section" },
    el("p", { className: "label" }, launched ? "Launched" : "Not launched"),
    el(
      "h3",
      { className: "display heading-sm" },
      launched
        ? "The game is starting"
        : result.assessment.state?.state === "cant_tell"
          ? "Cannot join"
          : stateName(result.assessment.state),
    ),
    el(
      "p",
      { className: "quiet" },
      launched
        ? `${GAME_LABELS[result.game] ?? "The game"} is connecting. The server decides the rest: bans, a full server, and its own ping limits.`
        : result.outcome.reason,
    ),
    installedLocations(result),
    result.used_home_fallback
      ? el(
          "p",
          { className: "note note--brass" },
          el("strong", null, "The install folder is not writable. "),
          "Maps went to ",
          el("span", { className: "data selectable" }, displayPath(result.game_directory)),
          ", which the engine searches first.",
        )
      : null,
    result.failures.length
      ? el(
          "div",
          null,
          el("p", { className: "label group-title" }, "Not installed"),
          el(
            "ul",
            { className: "rot" },
            result.failures.map((failure) =>
              el(
                "li",
                { className: "rot__row" },
                el("span", { className: "rot__name" }, mapName(failure.map)),
                el("span", { className: "rot__size" }, failure.reason),
              ),
            ),
          ),
        )
      : null,
  );
}

function installedLocations(result) {
  if (!result.installed.length) return null;
  const directories = result.install_directories?.length
    ? result.install_directories
    : [result.game_directory];
  return el(
    "div",
    { className: "stack--tight" },
    el("p", { className: "quiet" }, `${plural(result.installed.length, "file")} installed.`),
    directories.map((directory) =>
      el("p", { className: "data quiet selectable" }, displayPath(directory)),
    ),
  );
}

/** Drawn only while something is missing, which is the one case where it changes the join. */
function caveats(server, ready) {
  if (ready || server.allow_download !== 0) return null;
  return el(
    "p",
    { className: "quiet" },
    "This server sends no files, so anything missing must be installed before you join.",
  );
}

/** What the current selection would cost, counting only what will actually be fetched. */
export function shoppingTotals(preview) {
  let size = 0;
  let count = 0;
  let pending = 0;
  for (const resolution of preview?.catalogue?.resolutions ?? []) {
    if (resolution.outcome === "exact") {
      size += Number(resolution.name_match.file_size);
      count += 1;
    } else if (resolution.outcome === "choice_required") {
      const chosen = state.choices.get(resolution.wanted.name);
      const candidate = resolution.choices.find((item) => item.id === chosen);
      if (candidate) {
        size += Number(candidate.file_size);
        count += 1;
      } else {
        pending += 1;
      }
    }
  }
  const serverFiles = Number(preview?.pakradar?.pending ?? 0);
  const retryServerFiles = Boolean(preview?.pakradar?.non_result);
  const checksServerFiles = Boolean(preview?.pakradar);
  return { size, count, pending, serverFiles, retryServerFiles, checksServerFiles };
}

/**
 * The one control a gone server offers: ask it again.
 *
 * Offered whatever the check found, including a server that answered for another game — unlike
 * an absent bookmark, this row *was* in this game's list a moment ago, so what the check found is
 * a change and asking again is the way to see whether it changed back.
 */
function goneActions(address, check, onRecheck) {
  return [
    el(
      "button",
      {
        type: "button",
        className: "btn btn--block",
        // Focusable while busy, for the same reason as the header's refresh control.
        "aria-disabled": canRecheck(address) ? null : "true",
        dataset: { focusKey: "detail-recheck" },
        onclick: () =>
          onRecheck({ address, server: { endpoint: { query_port: check.dropped.queryPort } } }),
      },
      check.status === "checking" ? "Checking…" : "Check again",
    ),
  ];
}

function actionBar(row, onInstallServerFiles, onJoin) {
  const preview = state.preview?.address === row.address ? state.preview : null;
  const assessment = preview?.assessment ?? row.compatibility;
  const kind = assessment.state.state;
  const readiness = assessment.current_map?.readiness ?? "unknown";
  const busy = Boolean(state.joining);
  // A probe in flight can drop this row before the join command returns, and the outcome would then
  // have no row to render against. One request either way; waiting for it costs a moment.
  const checking = state.checks.get(row.address)?.status === "checking";
  const resolving = Boolean(state.previewProgress && !preview);
  const totals = preview ? shoppingTotals(preview) : { size: 0, count: 0, pending: 0 };
  const result = state.joinResult?.address === row.address ? state.joinResult : null;

  if (result?.outcome.launch === "launched") {
    return [
      el(
        "button",
        { type: "button", className: "btn btn--block", onclick: () => update((next) => (next.joinResult = null)) },
        "Back to server details",
      ),
    ];
  }

  // The map running right now being absent is the one thing consent cannot buy —
  // that connection is dropped on arrival. But it only blocks the join if the map
  // cannot be fetched. When it is in the shopping list, downloading is precisely
  // the fix, and refusing to let the player start the download would strand them
  // on the one screen that could have solved it.
  const currentMap = row.server.current_map;
  const fetchable = currentMapFetchable(preview, currentMap);
  if (readiness === "missing" && kind !== "compatible" && fetchable === "no") {
    return [
      el(
        "p",
        { className: "note note--bad" },
        `${mapName(currentMap)} is running now, is not on disk, and is not in the catalogue. Joining would drop you immediately.`,
      ),
      el(
        "button",
        { type: "button", className: "btn btn--block", disabled: true },
        "Cannot join while this map is running",
      ),
    ];
  }

  const rows = [];
  if (readiness === "missing" && fetchable === "yes") {
    rows.push(
      el(
        "p",
        { className: "note note--brass" },
        `${mapName(currentMap)} is running now and is not on disk. Fetching is what makes this join work.`,
      ),
    );
  } else if (readiness === "missing" && fetchable === "choose") {
    rows.push(
      el(
        "p",
        { className: "note note--brass" },
        `${mapName(currentMap)} is running now and is not on disk. Pick a source for it above.`,
      ),
    );
  }
  if (totals.pending > 0) {
    rows.push(
      el(
        "p",
        { className: "quiet" },
        `${totals.pending} ${totals.pending === 1 ? "map needs" : "maps need"} a choice above.`,
      ),
    );
  }
  rows.push(
    el(
      "div",
      { className: "actions__row" },
      el(
        "button",
        {
          type: "button",
          className: "btn btn--primary",
          disabled: busy || resolving || checking,
          dataset: { focusKey: "join" },
          // Server files are a separate first stage. Only the later branch asks for launch
          // consent, and its label names what that join is still missing.
          onclick: () =>
            totals.serverFiles > 0 || totals.retryServerFiles
              ? onInstallServerFiles(row)
              : onJoin(row, kind !== "compatible"),
        },
        busy ? "Working…" : joinLabel(kind, totals),
      ),
    ),
  );
  if (state.joinError) {
    rows.push(el("p", { className: "error", role: "alert" }, state.joinError));
  }
  return rows;
}

/** The primary button's label, which is also the consent it records. */
function joinLabel(kind, totals) {
  if (totals.serverFiles > 0) return `Get ${plural(totals.serverFiles, "server file")}`;
  if (totals.retryServerFiles) return "Retry server files";
  if (totals.count > 0) return `Get ${bytes(totals.size)} & join`;
  if (kind === "compatible" || kind === "cant_tell") return "Join";
  return "Join anyway";
}

/**
 * Can the map the server is running right now be fetched?
 *
 * "yes" — it resolved to an exact catalogue match, or the player already chose a
 * source for it. "choose" — candidates exist but none is selected yet.
 * "no" — the catalogue has nothing. "unknown" — resolution has not run or does not
 * cover it, in which case nothing is claimed and the backend decides after the
 * rescan.
 */
function currentMapFetchable(preview, currentMap) {
  const key = mapKey(currentMap);
  if (!preview || key === null) return "unknown";
  // A PakRadar manifest names packages rather than individual BSPs. Until those packages are
  // installed and the search path is rescanned, a catalogue miss cannot prove the current map is
  // unavailable.
  if (Number(preview.pakradar?.pending ?? 0) > 0 || preview.pakradar?.non_result) return "unknown";
  const resolution = (preview.catalogue?.resolutions ?? []).find(
    (item) => mapKey(item.wanted.name) === key,
  );
  if (!resolution) return "unknown";
  if (resolution.outcome === "exact") return "yes";
  if (resolution.outcome === "no_source") return "no";
  return state.choices.has(resolution.wanted.name) ? "yes" : "choose";
}
