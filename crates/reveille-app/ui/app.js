// SPDX-License-Identifier: GPL-3.0-only

// Boot, routing and the long-running operations. Views render from `state`;
// this module is the only place that calls commands and mutates state in
// response to them.

import { $, el } from "./lib/dom.js";
import { closeDialog, openDialog } from "./lib/dialog.js";
import { closeMenu, menuIsOpen, openMenu } from "./lib/menu.js";
import { icon } from "./lib/icons.js";
import { closePopover, openPopover, popoverAnchor } from "./lib/popover.js";
import { appVersion, errorText, openExternalUrl, trackEvent } from "./lib/shell.js";
import {
  clearPlayerAlertAttention,
  focusReveille,
  gameClientRunning,
  onHiddenToTray,
  onPlayerNotificationClick,
  onPopupMore,
  onPopupSnooze,
  openNotificationSettings,
  popupSupported,
  readWatchedServer,
  requestPlayerAlertAttention,
  sendPlayerNotification,
  sendReveilleNotice,
  setTrayTooltip,
  showAlertPopup,
} from "./features/alerts/api.js";
import { openBugReport } from "./features/bug-report/index.js";
import {
  installAndLaunch,
  installServerFiles,
  onInstallProgress,
  onPreviewProgress,
  previewJoin,
} from "./features/join/api.js";
import { initial as joinState } from "./features/join/index.js";
import { initial as selfUpdateState, selfUpdate } from "./features/self-update/index.js";
import { initial as serversState } from "./features/servers/index.js";
import { browse } from "./features/servers/browse.js";
import { checks } from "./features/servers/check.js";
import {
  setCloseToTray,
  setStartAtLogin,
  setTelemetryShared,
  startAtLogin,
  TELEMETRY_DETAILS_URL,
  telemetryStatus,
} from "./features/settings/api.js";
import {
  arrivalById,
  arrivalEvents,
  clearArrivals,
  markArrivalsRead,
  recordArrival,
  unreadArrivalCount,
} from "./lib/arrival-events.js";
import { recordLaunch, toggleFavorite } from "./lib/bookmarks.js";
import {
  addPlayerAlert,
  alertId,
  hasPlayerAlert,
  playerAlerts,
  removePlayerAlert,
  startPlayerAlertMonitor,
} from "./lib/player-alerts.js";
import { displayPath, occupancy, plural, timeAgo } from "./lib/format.js";
import { alertDetail } from "./features/alerts/format.js";
import { catchUpNotice, hiddenNotice, isStale, needsBackgroundWatching, trayTooltip } from "./lib/reach.js";
import { ENGINE_LABELS, GAME_LABELS } from "./lib/catalog.js";
import { composeState, notify, state, subscribe, update } from "./lib/store.js";
import { SCOPES, loadFilters, saveFilters } from "./features/servers/state.js";
import { listIsStale, selectedRow } from "./features/servers/selectors.js";
import { rememberReadyJoin } from "./features/servers/reducers.js";
import {
  generations,
  listIsForCurrentSession,
  playableGames,
  recallInstall,
  rememberGame,
  retireInFlight,
  session,
} from "./lib/session.js";
import { setupView } from "./views/setup.js";
import { alertErrorLine, openSettings } from "./views/settings.js";
import { openAlertsIntro } from "./views/alerts-intro.js";
import { openShortcuts } from "./views/shortcuts.js";
import { preferences, setPreference } from "./lib/preferences.js";
import "./features/alerts/preferences.js";
import { nonResultsBreakdown, serversView } from "./features/servers/view.js";
import { joinView, shoppingTotals } from "./features/join/view.js";

composeState([selfUpdateState(), serversState(), joinState()]);

const shell = $("#shell");
const setupRoot = $("#setup-root");

loadFilters();
state.rememberedInstall = recallInstall();
// A remembered folder means setup finished on an earlier run, so its automatic Continue is not one.
let firstRun = !state.rememberedInstall;

const {
  refresh,
  refreshBehind,
  stop: stopBrowse,
  finished: browseFinished,
} = browse({ onReselect: select });

const { check, recheck, autoCheckFavorites } = checks({ onReselect: select });

const servers = serversView({
  onRefresh: refresh,
  onCancel: stopBrowse,
  onSelect: select,
  onActivate: activate,
  onShowNonResults: showNonResults,
  onCheck: check,
  onGame: selectGame,
  onToggleWatch: togglePlayerAlert,
  onToggleDetail: toggleDetail,
});
const join = joinView($("#detail-slot"), {
  onInstallServerFiles: getServerFiles,
  onJoin: getAndJoin,
  onRecheck: recheck,
  onTogglePlayerAlert: togglePlayerAlert,
});
const setup = setupView(setupRoot, $("#setup-dialog"), {
  onReady: () => {
    if (firstRun) trackEvent({ event: "first_run_completed", game: state.game, engine: state.engine });
    firstRun = false;
    enterServers();
  },
  onApply: applyInstallChange,
  onUpdate: () => updates.open(),
  onReportBug: () => void openBugReport(),
});
const updates = selfUpdate({
  host: document.body,
  onOffer: () => {
    if (!state.install) setup.renderUpdateOffer();
  },
});

$("#toolbar-slot").replaceWith(servers.toolbar);
$("#list-slot").replaceWith(servers.listPane);
$("#status-slot").replaceWith(servers.statusbar);
document.body.append(servers.live);

$("#arrival-events-btn").prepend(icon("bell"));
$("#settings-btn").append(icon("gear"));
$("#more-btn").append(icon("dots"));
$("#game-switch").addEventListener("click", openGameMenu);
$("#reveille-update-btn").addEventListener("click", () => updates.open());
$("#arrival-events-btn").addEventListener("click", toggleArrivals);
$("#settings-btn").addEventListener("click", () => void openAppSettings());
$("#more-btn").addEventListener("click", openMoreMenu);
$("#info-dialog-close").addEventListener("click", closeDialog);

subscribe(render);

let pendingArrival = null;
let shownTooltip = null;
let heldWhilePlaying = [];
let gameWatch = null;
let openingArrival = false;
let attentionRequested = false;
window.addEventListener("focus", () => {
  attentionRequested = false;
  // Seen under the bell now, so the after-game summary would only repeat it.
  heldWhilePlaying = [];
  void clearPlayerAlertAttention().catch(() => {});
  refreshOnReturn();
});
void onPlayerNotificationClick(({ eventId, join }) => {
  const event = arrivalById(eventId);
  if (event) requestOpenArrival(event, { join: join === true });
});
// Snoozed from a pop-up: arrivals still reach the bell, without a pop-up or notification.
let snoozedUntil = 0;
const SNOOZE_MS = 60 * 60_000;
void onPopupSnooze(() => {
  snoozedUntil = Date.now() + SNOOZE_MS;
});
void onPopupMore(() => {
  if (popoverAnchor() !== $("#arrival-events-btn")) toggleArrivals();
});
const popupAvailable = popupSupported().catch(() => false);
void onHiddenToTray(() => {
  if (preferences().trayNoticeShown) return;
  setPreference("trayNoticeShown", true);
  void sendReveilleNotice(hiddenNotice(playerAlerts().length), false).catch(() => {});
});
const alertMonitor = startPlayerAlertMonitor(
  readWatchedServer,
  deliverArrival,
  (id, reading) => update((next) => next.watchReadings.set(id, reading)),
  () => preferences().cooldownMinutes * 60_000,
);

async function deliverArrival(entry, count, reading, { toast = true } = {}) {
  if (!preferences().alertsEnabled) return;
  const event = recordArrival(entry, count, Date.now(), alertDetail(reading));
  renderArrivalBadge();
  // Inside the cooldown the arrival still reaches the bell; only the interruption waits.
  if (!toast) return;
  if (snoozedUntil > Date.now()) return;
  // Kept under the bell, but no toast and no flashing taskbar over a game in progress.
  if (preferences().quietWhilePlaying && (await gameClientRunning().catch(() => null)) === true) {
    if (event) holdUntilGameCloses(event);
    return;
  }
  if (!document.hasFocus() && !attentionRequested) {
    attentionRequested = true;
    void requestPlayerAlertAttention().catch(() => { attentionRequested = false; });
  }
  try {
    if (event && !(await showPopup(popupCard(event)))) {
      await sendPlayerNotification(event, preferences().alertSound);
    }
    if (state.alertError) update((next) => (next.alertError = null));
  } catch {
    update((next) => (next.alertError = "Reveille could not show a system notification."));
  }
}

/**
 * Resolves to whether the alert went out as a Reveille pop-up. False when the player chose system
 * notifications or this desktop cannot draw one, so the caller sends a notification instead.
 */
async function showPopup(card) {
  if (preferences().alertStyle !== "popup" || !(await popupAvailable)) return false;
  return showAlertPopup(card, preferences().alertSound).catch(() => false);
}

function popupCard(event) {
  return {
    eventId: event.id,
    game: event.game,
    address: event.address,
    hostname: event.hostname,
    count: event.count,
    title: null,
    detail: event.detail ?? null,
  };
}

const TEST_ALERT = {
  title: "Test alert from Reveille",
  body: "This is how an alert looks when players join a server you watch.",
};

/** Resolves to whether the test went out as a pop-up rather than a system notification. */
async function sendTestAlert() {
  const card = {
    eventId: `test-${Date.now()}`,
    game: state.game ?? "",
    address: "",
    hostname: "",
    count: 1,
    title: TEST_ALERT.title,
    detail: TEST_ALERT.body,
  };
  if (await showPopup(card)) return true;
  await sendReveilleNotice(TEST_ALERT, preferences().alertSound);
  return false;
}

/** Arrivals a game kept quiet, summed up in one notice once it closes. */
function holdUntilGameCloses(event) {
  heldWhilePlaying.push(event);
  gameWatch ??= setInterval(async () => {
    if ((await gameClientRunning().catch(() => null)) !== false) return;
    clearInterval(gameWatch);
    gameWatch = null;
    const notice = catchUpNotice(heldWhilePlaying);
    heldWhilePlaying = [];
    if (!notice || document.hasFocus()) return;
    try {
      await sendReveilleNotice(notice, preferences().alertSound);
    } catch {
      update((next) => (next.alertError = "Reveille could not show a system notification."));
    }
  }, 30_000);
}

function forgetWatch(game, address) {
  removePlayerAlert(game, address);
  alertMonitor.forget(game, address);
  update((next) => next.watchReadings.delete(alertId({ game, address })));
}

function renderArrivalBadge() {
  const count = unreadArrivalCount();
  const badge = $("#arrival-unread");
  badge.classList.toggle("hidden", count === 0);
  badge.textContent = count > 0 ? String(count) : "";
  $("#arrival-events-btn").setAttribute("aria-label",
    count ? `Player alerts, ${count} unread` : "Player alerts");
  renderTrayTooltip();
}

/**
 * The bell's popover: the latest arrivals, newest first, each with Show and Join. Opening it marks
 * them read, but the ones that were unread keep their edge until it closes.
 */
function toggleArrivals() {
  const anchor = $("#arrival-events-btn");
  if (popoverAnchor() === anchor) {
    closePopover();
    return;
  }
  const events = arrivalEvents().slice(0, 12);
  markArrivalsRead();
  renderArrivalBadge();
  openPopover(anchor, "Player alerts",
    el("div", { className: "popover__head" },
      el("h2", { className: "popover__title" }, "Player alerts"),
      state.alertError && alertErrorLine(openSystemNotificationSettings),
    ),
    events.length === 0
      ? el("p", { className: "popover__empty" },
          "No alerts yet. Turn on a server's bell and Reveille tells you here when players join it.")
      : el("div", null, events.map(arrivalEntry)),
    el("div", { className: "popover__foot" },
      el("button", {
        type: "button",
        className: "btn btn--sm btn--utility",
        onclick: () => {
          closePopover();
          servers.selectScope("watching");
        },
      }, "Open Watching"),
      events.length > 0 && el("button", {
        type: "button",
        className: "btn btn--sm btn--utility",
        onclick: () => {
          clearArrivals();
          renderArrivalBadge();
          update(() => {});
          closePopover();
          toggleArrivals();
        },
      }, "Clear all"),
    ),
  );
}

function arrivalEntry(event) {
  const where = playableGames(state.install).length > 1 ? `${GAME_LABELS[event.game]} · ` : "";
  const classes = ["arrival", !event.read && "arrival--unread", isStale(event) && "arrival--stale"];
  return el("div", { className: classes.filter(Boolean).join(" ") },
    el("span", { className: "arrival__title", title: event.hostname },
      el("strong", null, plural(event.count, "player")), ` on ${event.hostname}`),
    el("span", { className: "arrival__meta" },
      [where + (timeAgo(new Date(event.at).toISOString()) ?? ""), event.detail].filter(Boolean).join(" · ")),
    el("span", { className: "arrival__actions" },
      el("button", {
        type: "button",
        className: "btn btn--sm",
        onclick: () => requestOpenArrival(event),
      }, "Show"),
      el("button", {
        type: "button",
        className: "btn btn--sm btn--primary",
        onclick: () => requestOpenArrival(event, { join: true }),
      }, "Join"),
    ),
  );
}

function requestOpenArrival(event, { join = false } = {}) {
  pendingArrival = { event, join };
  closeDialog();
  closePopover();
  void focusReveille().catch(() => {});
  void openPendingArrival();
}

async function openPendingArrival() {
  if (openingArrival || !pendingArrival || state.browse.running || state.joining) return;
  openingArrival = true;
  const pending = pendingArrival;
  const { event } = pending;
  pendingArrival = null;
  try {
    if (!state.install || !playableGames(state.install).includes(event.game)) {
      openDialog("Server unavailable", el("p", null,
        `${event.hostname} (${event.address}) requires ${GAME_LABELS[event.game]}.`));
      return;
    }
    if (state.game !== event.game) await selectGame(event.game);
    if (state.browse.running) await browseFinished();
    if (state.game !== event.game || state.joining) {
      pendingArrival = pending;
      return;
    }
    const checked = await check({ address: event.address, queryPort: event.queryPort });
    if (pendingArrival) return;
    if (checked?.address === event.address && state.game === event.game) {
      servers.reveal(event.address);
      select(event.address);
      if (pending.join && occupancy(checked.server).clients === 0) {
        openDialog("No players right now", el("p", null,
          `${event.hostname} has no players right now. It is selected in the list if you still want to join.`));
      } else if (pending.join) {
        // Join goes through the same path as a double-click, so a server that needs downloads
        // stops on its priced button rather than fetching anything.
        activate(event.address);
      }
    } else {
      openDialog("Server unavailable", el("p", null,
        `${event.hostname} (${event.address}) is no longer answering.`));
    }
  } finally {
    openingArrival = false;
    if (pendingArrival) queueMicrotask(() => void openPendingArrival());
  }
}

/* Titlebar menus ------------------------------------------------------------ */

/**
 * The game and engine this session plays, and the way to change either. It replaced the toolbar's
 * Game select and the folder chip: both answer "what am I browsing for", so they sit together.
 */
function openGameMenu(event) {
  const anchor = $("#game-switch");
  const games = playableGames(state.install);
  openMenu([
    ...(games.length > 1
      ? games.map((game) => ({
          label: GAME_LABELS[game] ?? game,
          checked: game === state.game,
          disabled: state.joining && game !== state.game,
          onSelect: () => void selectGame(game),
        }))
      : []),
    games.length > 1 && { separator: true },
    { label: "Change folder or engine…", disabled: state.joining, onSelect: () => setup.change() },
    { note: displayPath(state.install.root) },
  ].filter(Boolean), event, anchor);
}

function openMoreMenu(event) {
  openMenu([
    { label: "Keyboard shortcuts", hint: "?", onSelect: openShortcuts },
    { label: "Report a bug", onSelect: () => void openBugReport() },
    { label: "About Reveille", onSelect: () => void openAbout() },
  ], event, $("#more-btn"));
}

async function openAbout() {
  const version = await appVersion().catch(() => null);
  openDialog("About Reveille",
    el("p", null, "A server browser and launcher for Medal of Honor: Allied Assault, Spearhead and Breakthrough."),
    version && el("p", { className: "data" }, `Version ${version}`),
    el("p", { className: "quiet" }, "Free software under the GNU General Public License, version 3."),
  );
}

async function togglePlayerAlert(row) {
  const game = state.game;
  if (hasPlayerAlert(game, row.address)) {
    forgetWatch(game, row.address);
    return;
  }
  if (!addPlayerAlert(row, game, preferences().defaultThreshold)) {
    openDialog("Player alerts", el("p", null,
      "Reveille could not save this server's alert. Try again after restarting the app."));
    return;
  }
  keepWatchingInBackground();
  update(() => {});
  alertMonitor.checkNow();
  if (!preferences().alertsIntroShown) {
    setPreference("alertsIntroShown", true);
    openAlertsIntro({
      startAtLogin: await startAtLogin().catch(() => null),
      onTest: sendTestAlert,
      onCloseToTray: syncCloseToTray,
      onStartAtLogin: changeStartAtLogin,
      onNotificationSettings: openSystemNotificationSettings,
    });
  }
}

function keepWatchingInBackground() {
  if (!needsBackgroundWatching(preferences(), playerAlerts().length)) return;
  setPreference("closeToTray", true);
  syncCloseToTray(true);
}

/** Resolves to whether Reveille now starts at sign-in, whatever happened to the request. */
async function changeStartAtLogin(enabled) {
  try {
    await setStartAtLogin(enabled);
  } catch {
    openDialog("Start in the background", el("p", null,
      enabled
        ? "Reveille could not add itself to the programs that start when you sign in."
        : "Reveille could not remove itself from the programs that start when you sign in."));
  }
  return startAtLogin().catch(() => null);
}

function openSystemNotificationSettings() {
  openNotificationSettings().catch(() => {
    openDialog("Notification settings", el("p", null,
      "Open your system's notification settings and allow notifications for Reveille."));
  });
}

async function openAppSettings() {
  const [version, telemetry, login] = await Promise.all([
    appVersion().catch(() => null),
    telemetryStatus().catch(() => null),
    startAtLogin().catch(() => null),
  ]);
  openSettings({
    engine: engineLabel(state.engine),
    version,
    telemetry,
    onTelemetry: setTelemetryShared,
    onTelemetryDetails: openTelemetryDetails,
    onChangeInstall: () => {
      if (state.joining) return;
      closeDialog();
      setup.change();
    },
    onOpenWatching: () => {
      closeDialog();
      servers.selectScope("watching");
    },
    onUpdate: () => {
      closeDialog();
      updates.open();
    },
    onCheckUpdate: () => updates.check(),
    onReportBug: () => void openBugReport(),
    onCloseToTray: syncCloseToTray,
    startAtLogin: login,
    onStartAtLogin: changeStartAtLogin,
    onNotificationSettings: openSystemNotificationSettings,
    popupSupported: await popupAvailable,
    onTestAlert: sendTestAlert,
  });
}

function syncCloseToTray(enabled) {
  // A new icon starts with the default text.
  shownTooltip = null;
  setCloseToTray(enabled).then(renderTrayTooltip, () => {
    openDialog("Keep watching", el("p", null,
      "Reveille could not add its notification-area icon, so closing the window still quits it."));
    setPreference("closeToTray", false);
  });
}

function renderTrayTooltip() {
  if (!preferences().closeToTray) return;
  const text = trayTooltip(playerAlerts().length, unreadArrivalCount());
  if (text === shownTooltip) return;
  shownTooltip = text;
  void setTrayTooltip(text).catch(() => (shownTooltip = null));
}

function render() {
  renderArrivalBadge();
  if (pendingArrival && !openingArrival && !state.browse.running && !state.joining) {
    queueMicrotask(() => void openPendingArrival());
  }
  const ready = Boolean(state.install);
  shell.classList.toggle("hidden", !ready);
  setupRoot.classList.toggle("hidden", ready);
  if (!ready) return;

  $("#game-switch-game").textContent = GAME_LABELS[state.game] ?? state.game;
  $("#game-switch-engine").textContent = engineLabel(state.engine);
  $("#game-switch").title = `${displayPath(state.install.root)}\nChange game, engine or folder`;
  $("#reveille-update-btn").classList.toggle("hidden", !state.selfUpdate.offer);
  $("#reveille-update-btn").disabled = state.joining;
  const collapsed = state.detailCollapsed;
  $("main.split").classList.toggle("split--wide", collapsed);
  $("#detail-slot").classList.toggle("hidden", collapsed);
  servers.render();
  if (!collapsed) join.render();
}

function toggleDetail() {
  update((next) => (next.detailCollapsed = !next.detailCollapsed));
  saveFilters();
}

/* Anonymous statistics ------------------------------------------------------ */

function openTelemetryDetails() {
  void openExternalUrl(TELEMETRY_DETAILS_URL).catch(() => {});
}

/* First run ---------------------------------------------------------------- */

/**
 * Show the server list, sweeping when what is on screen is not an answer to this session.
 *
 * Setup is re-entered to change something — the folder, the engine, or which of the three games —
 * and Continue returns here with a list that was swept for the session just left. Those rows are
 * not this game's servers, and their compatibility was judged against another search path, so they
 * are dropped and swept again rather than shown under a new heading. A session that came back
 * unchanged keeps its list: re-sweeping it would cost a couple of hundred probes to arrive at the
 * same table.
 *
 * The first run has nothing on screen and no session recorded, so it sweeps for the same reason.
 */
function enterServers() {
  render();
  if (state.browse.running) return;
  if (!state.servers.length || !listIsForCurrentSession()) refresh();
}

/**
 * Adopt the folder, program and game the setup dialog confirmed, without leaving the list.
 *
 * Every result still in flight was asked of the session being left, so the generations
 * `selectGame` retires are retired here, and a running sweep is stopped rather than left to fill the
 * table with the old session's rows. The list is searched again only when the session changed.
 */
async function applyInstallChange({ install, engine, game }) {
  if (state.browse.running) {
    stopBrowse();
    await browseFinished();
  }
  retireInFlight();
  update((next) => {
    next.install = install;
    next.engine = engine;
    next.game = game;
    next.selected = null;
    next.preview = null;
    next.checks = new Map();
    next.checkedAt = new Map();
    next.previewProgress = null;
    next.previewError = null;
    next.joinResult = null;
    next.joinError = null;
  });
  enterServers();
}

/**
 * Switch which of the three games this session is browsing.
 *
 * Not a filter: Allied Assault, Spearhead and Breakthrough register with the master separately and
 * read different directories on disk, so nothing already on screen is true of the new game. The
 * list is dropped and swept again rather than re-labelled.
 *
 * Every operation already in flight was started for the game being left. Each one captured its own
 * session and will still finish against it, so their *results* are stale the moment this returns —
 * an install started for Allied Assault would otherwise render its outcome into a Spearhead
 * session. Retiring every generation is what discards them. A join cannot be abandoned half-written,
 * so the control is refused outright while one is running rather than raced — `joining`, not
 * `installRun`, because a compatible server has nothing to download and still has a game to start.
 *
 * A running search is stopped instead, since its rows are about to be dropped anyway. That is what
 * lets Setup open on one game without asking: the title bar can switch during the first search.
 * Only the last game asked for while a search winds down is switched to.
 */
let wantedGame = null;

async function selectGame(game) {
  if (game === state.game || state.joining) return;
  if (!playableGames(state.install).includes(game)) return;
  if (state.browse.running) {
    wantedGame = game;
    stopBrowse();
    await browseFinished();
    if (wantedGame !== game || state.joining || game === state.game) return;
    wantedGame = null;
  }
  retireInFlight();
  update((next) => {
    next.game = game;
    next.checks = new Map();
    next.checkedAt = new Map();
    next.previewProgress = null;
    next.previewError = null;
    next.joinResult = null;
    next.joinError = null;
    next.joining = false;
  });
  rememberGame(state.install.root, game);
  return refresh();
}

/* Browsing ----------------------------------------------------------------- */

/**
 * Coming back to a list more than five minutes old gets it again, once, behind the list on screen.
 * Not while a join owns the pane or a dialog is open over the list.
 */
function refreshOnReturn() {
  if (!preferences().refreshOnFocus || !state.install || state.browse.running || state.joining) return;
  if (!state.servers.length || !listIsForCurrentSession() || !listIsStale()) return;
  if (document.querySelector("dialog[open]")) return;
  void refreshBehind();
}

/* Selecting and previewing -------------------------------------------------- */

let previewTimer = null;

/**
 * How long a selection has to hold still before its catalogue lookup is sent.
 *
 * Selection follows focus in the grid, which is what makes the arrow keys useful — but it also
 * means holding Down through twenty rows used to fire twenty `preview_join` calls at moh-db, one
 * per row passed over. The pane still updates on every step; only the
 * third-party request waits. Long enough that scrolling costs nothing, short enough that a
 * deliberate selection does not feel delayed.
 */
const PREVIEW_SETTLE_MS = 220;

function select(address) {
  const token = generations.preview.next();
  if (previewTimer !== null) {
    clearTimeout(previewTimer);
    previewTimer = null;
  }
  update((next) => {
    next.selected = address;
    next.preview = null;
    next.previewProgress = null;
    next.previewError = null;
    next.choices = new Map();
    next.installRun = null;
    next.joinResult = null;
    next.joinError = null;
  });

  const row = selectedRow();
  if (row) trackEvent({ event: "server_selected", ready: row.compatibility.state.state === "compatible" });
  // Nothing to resolve: the map list is already satisfied, or there is none.
  if (!row || row.compatibility.state.state === "compatible") return;

  // The meter goes up immediately even though the request has not been sent. It is honest about
  // what it says — this server's sources are being worked out — and a control that looked idle for
  // a fifth of a second and then started would read as a stutter.
  update((next) => (next.previewProgress = { index: -1, of: 0, map: "" }));
  previewTimer = setTimeout(() => {
    previewTimer = null;
    void resolvePreview(address, token);
  }, PREVIEW_SETTLE_MS);
}

/**
 * A double-click or Enter on a row. A server with nothing to fetch joins at once; anything else
 * stops on the priced Join button, so no download starts without its size on screen and a second
 * Enter is the consent.
 */
function activate(address) {
  if (state.selected !== address) select(address);
  const row = selectedRow();
  if (!row) return;
  const ready = row.compatibility.state.state === "compatible";
  const idle = !state.joining && state.checks.get(address)?.status !== "checking";
  if (ready && idle) {
    void getAndJoin(row, false);
    return;
  }
  // The price and the consent live in the pane, so a hidden pane opens for them.
  if (state.detailCollapsed) toggleDetail();
  join.focusJoin(address);
}

async function resolvePreview(address, token) {
  if (!generations.preview.isCurrent(token)) return;
  try {
    const preview = await previewJoin(session(), address);
    if (!generations.preview.isCurrent(token)) return;
    update((next) => {
      next.preview = preview;
      next.previewProgress = null;
    });
  } catch (error) {
    if (!generations.preview.isCurrent(token)) return;
    update((next) => {
      next.previewProgress = null;
      next.previewError = errorText(error);
    });
  }
}

onPreviewProgress((progress) => {
  if (progress.address !== state.selected) return;
  update((next) => (next.previewProgress = progress));
});

/* Getting files and joining in stages ---------------------------------------- */

async function getServerFiles(row) {
  const token = generations.join.next();
  update((next) => {
    next.joinError = null;
    next.joinResult = null;
    next.joining = true;
    next.installRun = { items: new Map(), done: false };
  });

  try {
    const result = await installServerFiles(session(), row.address);
    if (!generations.join.isCurrent(token)) return;
    update((next) => {
      next.joining = false;
      next.installRun = null;
      next.preview = result.preview;
      next.previewProgress = null;
      next.choices = new Map();
      next.joinError = result.failures.length
        ? result.failures.map((failure) => `${failure.map}: ${failure.reason}`).join(" ")
        : null;
    });
  } catch (error) {
    if (!generations.join.isCurrent(token)) return;
    update((next) => {
      next.joining = false;
      next.installRun = null;
      next.joinError = errorText(error);
    });
  }
}

async function getAndJoin(row, acceptIncomplete) {
  const token = generations.join.next();
  const preview = state.preview?.address === row.address ? state.preview : null;
  const totals = preview
    ? shoppingTotals(preview)
    : { count: 0 };
  const selectedCandidateIds = [...state.choices.values()];

  update((next) => {
    next.joinError = null;
    next.joinResult = null;
    // `installRun` covers the downloads; `joining` covers the command. A compatible server has
    // nothing to fetch, so without this the pane would look idle while the game was being started,
    // and a check finishing in that window could drop the row the outcome renders against.
    next.joining = true;
    next.installRun = totals.count > 0 ? { items: new Map(), done: false } : null;
  });

  try {
    const result = await installAndLaunch(
      session(),
      row.address,
      selectedCandidateIds,
      acceptIncomplete,
    );
    // Only a launched outcome is remembered. A refusal means Reveille did not start the game,
    // so there is nothing that happened to record. The launch is recorded even
    // if the session moved on — it really did happen — but its result is not rendered into a
    // session it is no longer about.
    if (result.outcome?.launch === "launched") recordLaunch(row);
    if (!generations.join.isCurrent(token)) return;
    update((next) => {
      next.joining = false;
      next.installRun = null;
      next.joinResult = { ...result, address: row.address };
      rememberReadyJoin(next, row, result);
    });
  } catch (error) {
    if (!generations.join.isCurrent(token)) return;
    update((next) => {
      next.joining = false;
      next.installRun = null;
      next.joinError = errorText(error);
    });
  }
}

onInstallProgress((progress) => {
  if (!state.installRun) return;
  update((next) => {
    const items = next.installRun.items;
    const key = progress.filename;
    const existing = items.get(key) ?? {
      map: progress.map,
      filename: progress.filename,
      received: 0,
      total: null,
    };
    items.set(key, {
      ...existing,
      filename: progress.filename,
      phase: progress.phase,
      received: progress.received ?? existing.received,
      total: progress.total ?? existing.total,
      reason: progress.reason ?? existing.reason,
    });
  });
});

subscribe(autoCheckFavorites);

/* Dialogs and global keys ---------------------------------------------------- */

function showNonResults() {
  openDialog("Registered but not listed", ...nonResultsBreakdown());
}

/**
 * The three regions F6 cycles between, in the order the window reads.
 *
 * F6 is the Windows convention for moving between the panes of one window, and without it a
 * keyboard player crossing from the list to the detail pane has to arrow through the list to its
 * end first.
 */
const REGIONS = [
  { root: () => document.querySelector(".toolbar"), enter: () => servers.focusSearch() },
  { root: () => document.querySelector(".list-pane"), enter: () => servers.focusFirstRow() },
  {
    root: () => $("#detail-slot"),
    enter: () => $("#detail-slot")?.querySelector("button, input, select, a[href]")?.focus(),
  },
];

function cycleRegion(backwards) {
  const active = document.activeElement;
  const at = REGIONS.findIndex((region) => region.root()?.contains(active));
  const step = backwards ? -1 : 1;
  // Start from the list when focus is somewhere with no region of its own — the titlebar, or the
  // body after a repaint — rather than refusing to move at all.
  const from = at === -1 ? (backwards ? 0 : REGIONS.length - 1) : at;
  const wrap = (index) => ((index % REGIONS.length) + REGIONS.length) % REGIONS.length;
  for (let hop = 1; hop <= REGIONS.length; hop += 1) {
    const region = REGIONS[wrap(from + step * hop)];
    const before = document.activeElement;
    region.enter();
    if (document.activeElement !== before) return;
  }
}

/**
 * WebView2's own context menu never reaches a row, a button or a heading.
 *
 * Back, Reload and Inspect on a right-click is the loudest tell that a desktop window is a web
 * page in a costume. It is left alone over anything the player can
 * select text in, because there the browser menu is genuinely the right one — Copy is what a
 * right-click on an address is for.
 */
document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) return;
  const target = event.target;
  const editable =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable === true ||
    Boolean(target?.closest?.(".selectable, .data"));
  if (!editable) event.preventDefault();
});

document.addEventListener("keydown", (event) => {
  if (!state.install) return;
  if (menuIsOpen() && event.key !== "Escape") return;
  // A bare letter is only a shortcut where there is nothing else for it to mean. Inside any form
  // control it is input — the search box, but also the game select, where R jumps to an option —
  // and inside an open dialog the shortcuts behind it are not reachable anyway. Alt and Meta are
  // excluded so a window or system chord is never swallowed.
  const typing =
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target.isContentEditable === true ||
    Boolean(event.target.closest?.("dialog[open], .popover"));
  const plain = !event.ctrlKey && !event.altKey && !event.metaKey;
  const findOrRefreshModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
  if (event.key === "F6") {
    event.preventDefault();
    cycleRegion(event.shiftKey);
  } else if (findOrRefreshModifier && (event.key === "f" || event.key === "F")) {
    // Ctrl+F on Windows and Command+F on macOS are the native "find in this thing" chords. `/`
    // stays for the players who learned it here.
    event.preventDefault();
    servers.focusSearch();
  } else if (findOrRefreshModifier && /^[1-4]$/u.test(event.key)) {
    event.preventDefault();
    servers.selectScope(SCOPES[Number(event.key) - 1]);
  } else if (findOrRefreshModifier && (event.key === "d" || event.key === "D")) {
    event.preventDefault();
    toggleDetail();
  } else if (event.key === "?" && !typing && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    openShortcuts();
  } else if (event.key === "/" && !typing) {
    event.preventDefault();
    servers.focusSearch();
  } else if (event.key === "Escape" && popoverAnchor()) {
    closePopover({ restoreFocus: true });
  } else if (event.key === "Escape" && menuIsOpen()) {
    closeMenu();
  } else if (event.key === "Escape" && typing) {
    update((next) => (next.filters.query = ""));
    servers.focusFirstRow();
  } else if (event.key === "F5" || (findOrRefreshModifier && event.key.toLowerCase() === "r")) {
    event.preventDefault();
    if (!state.browse.running) refresh();
  } else if ((event.key === "f" || event.key === "F") && !typing && plain) {
    const row = selectedRow();
    if (!row) return;
    event.preventDefault();
    toggleFavorite(row);
    notify();
  } else if ((event.key === "w" || event.key === "W") && !typing && plain) {
    const row = selectedRow();
    if (!row) return;
    event.preventDefault();
    void togglePlayerAlert(row);
  } else if ((event.key === "r" || event.key === "R") && !typing && plain) {
    // Plain R re-asks the selected server; Ctrl+R or Command+R, handled above, re-asks the whole
    // list. The modifier is the difference between one probe and a couple of hundred.
    const row = selectedRow();
    if (!row) return;
    event.preventDefault();
    recheck(row);
  }
});

/* Boot ---------------------------------------------------------------------- */

notify();
if (preferences().closeToTray) syncCloseToTray(true);
keepWatchingInBackground();
setup.detect();
void updates.find();

function engineLabel(engine) {
  return ENGINE_LABELS[engine] ?? ENGINE_LABELS.original;
}
