// SPDX-License-Identifier: GPL-3.0-only

// The composition root. Features own their state, commands and views; this module composes them,
// binds the intents table, and keeps what belongs to no one feature: the titlebar menus, the
// session changes (game, folder and engine), the global keys and boot.

import { $, el } from "./lib/dom.js";
import { closeDialog, openDialog } from "./lib/dialog.js";
import { closeMenu, menuIsOpen, openMenu } from "./lib/menu.js";
import { icon } from "./lib/icons.js";
import { intentsTable } from "./lib/intents.js";
import { openServerWorkflow } from "./lib/open-server.js";
import { closePopover, popoverAnchor } from "./lib/popover.js";
import { railView } from "./lib/rail.js";
import {
  activeSection,
  initial as sectionsState,
  registerSection,
  registeredSections,
  sections,
  showSection,
} from "./lib/sections.js";
import { appVersion, openExternalUrl, trackEvent } from "./lib/shell.js";
import { adminController } from "./features/admin/controller.js";
import { openAddServer } from "./features/admin/dialogs.js";
import { initial as adminState } from "./features/admin/index.js";
import { adminSettingsSection } from "./features/admin/settings-section.js";
import { adminView } from "./features/admin/view.js";
import { openBugReport } from "./features/bug-report/index.js";
import { initial as contentState, installShare } from "./features/content/index.js";
import { contentController } from "./features/content/controller.js";
import { contentView } from "./features/content/view.js";
import { joinController } from "./features/join/controller.js";
import { initial as joinState } from "./features/join/index.js";
import { initial as selfUpdateState, selfUpdate } from "./features/self-update/index.js";
import { aboutSettingsSection } from "./features/self-update/settings-section.js";
import { initial as serversState } from "./features/servers/index.js";
import { browse } from "./features/servers/browse.js";
import { checks } from "./features/servers/check.js";
import { serverListSettingsSection } from "./features/servers/settings-section.js";
import {
  setStartAtLogin,
  setTelemetryShared,
  startAtLogin,
  TELEMETRY_DETAILS_URL,
  telemetryStatus,
} from "./features/settings/api.js";
import { openSettings } from "./features/settings/dialog.js";
import { privacySettingsSection } from "./features/settings/privacy.js";
import { installSettingsSection } from "./features/setup/settings-section.js";
import { toggleFavorite } from "./lib/bookmarks.js";
import { displayPath } from "./lib/format.js";
import { focusReveille } from "./features/alerts/api.js";
import { playerAlertsController } from "./features/alerts/controller.js";
import { alertsSettingsSection } from "./features/alerts/settings-section.js";
import { ENGINE_LABELS, GAME_LABELS } from "./lib/catalog.js";
import { composeState, notify, state, subscribe, update } from "./lib/store.js";
import { SCOPES, loadFilters, saveFilters } from "./features/servers/state.js";
import { listIsStale, selectedRow } from "./features/servers/selectors.js";
import {
  listIsForCurrentSession,
  playableGames,
  recallInstall,
  rememberGame,
  retireInFlight,
} from "./lib/session.js";
import { setupView } from "./features/setup/view.js";
import { openShortcuts } from "./features/shortcuts/view.js";
import { preferences } from "./lib/preferences.js";
import "./features/alerts/preferences.js";
import { nonResultsBreakdown, serversView } from "./features/servers/view.js";
import { joinView } from "./features/join/view.js";

composeState([sectionsState(), selfUpdateState(), serversState(), joinState(), contentState(), adminState()]);

const shell = $("#shell");
const setupRoot = $("#setup-root");

loadFilters();
state.rememberedInstall = recallInstall();
// A remembered folder means setup finished on an earlier run, so its automatic Continue is not one.
let firstRun = !state.rememberedInstall;

const { select, activate, getServerFiles, getAndJoin } = joinController({
  showPane: toggleDetail,
  focusJoin: (address) => join.focusJoin(address),
  onFilesChanged: () => catalogue.forget(),
});

const {
  refresh,
  refreshBehind,
  stop: stopBrowse,
  finished: browseFinished,
} = browse({ onReselect: select });

const { check, recheck, autoCheckFavorites } = checks({ onReselect: select });

const alerts = playerAlertsController({ onOpenWatching: openWatching, changeStartAtLogin });

const opening = openServerWorkflow({
  selectGame,
  browseFinished,
  check,
  reveal: (address) => {
    showSection("servers");
    servers.reveal(address);
  },
  select,
  activate,
  focus: focusReveille,
});

const intents = intentsTable({
  selectGame,
  select,
  activate,
  refresh,
  check,
  openServer: opening.openServer,
  togglePlayerAlert: alerts.togglePlayerAlert,
});

const servers = serversView({
  onRefresh: intents.refresh,
  onCancel: stopBrowse,
  onSelect: intents.select,
  onActivate: intents.activate,
  onShowNonResults: showNonResults,
  onCheck: intents.check,
  onGame: intents.selectGame,
  onToggleWatch: intents.togglePlayerAlert,
  onToggleDetail: toggleDetail,
  onRunServer: runServer,
  runsServer: (address) => state.admin.servers.some((server) => server.address === address),
});
const join = joinView($("#detail-slot"), {
  onInstallServerFiles: getServerFiles,
  onJoin: getAndJoin,
  onRecheck: recheck,
  onTogglePlayerAlert: intents.togglePlayerAlert,
});
const catalogue = contentController();
const content = contentView({
  controller: catalogue,
  onShowServer: showServer,
  onJoinServer: joinServer,
  onToggleDetail: toggleDetail,
});
const admin = adminController();
const adminPage = adminView({ controller: admin, onToggleDetail: toggleDetail });
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

$("#toolbar-slot").replaceWith(servers.toolbar, content.toolbar, adminPage.toolbar);
$("#list-slot").replaceWith(servers.listPane, content.listPane, adminPage.listPane);
$("#detail-slot").after(content.detail, adminPage.detail);
$("#status-slot").replaceWith(servers.statusbar, content.statusbar, adminPage.statusbar);
document.body.append(servers.live);

registerSection({
  id: "servers",
  label: "Servers",
  icon: "servers",
  parts: [servers.toolbar, servers.listPane, servers.statusbar],
  detail: $("#detail-slot"),
  focusSearch: servers.focusSearch,
  focusList: servers.focusFirstRow,
  clearSearch: () => {
    update((next) => (next.filters.query = ""));
    servers.focusFirstRow();
  },
  refresh: () => {
    if (!state.browse.running) intents.refresh();
  },
});
registerSection({
  id: "content",
  label: "Maps & mods",
  railLabel: "Maps\n& mods",
  icon: "package",
  parts: [content.toolbar, content.listPane, content.statusbar],
  detail: content.detail,
  progress: () => installShare(),
  focusSearch: content.focusSearch,
  focusList: content.focusList,
  clearSearch: () => {
    content.clearSearch();
    content.focusList();
  },
  refresh: catalogue.refresh,
});
registerSection({
  id: "admin",
  label: "Admin",
  icon: "terminal",
  parts: [adminPage.toolbar, adminPage.listPane, adminPage.statusbar],
  detail: adminPage.detail,
  detailVisible: () => state.admin.servers.length > 0,
  focusSearch: adminPage.focusSearch,
  focusList: adminPage.focusList,
  clearSearch: adminPage.clearSearch,
  refresh: () => void admin.refresh(),
});
const rail = railView($("#rail"), { onSettings: () => void openAppSettings() });

$("#more-btn").append(icon("dots"));
$("#game-switch").addEventListener("click", openGameMenu);
$("#reveille-update-btn").addEventListener("click", () => updates.open());
$("#more-btn").addEventListener("click", openMoreMenu);
$("#info-dialog-close").addEventListener("click", closeDialog);

alerts.start(intents);
subscribe(render);
window.addEventListener("focus", refreshOnReturn);

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

async function openAppSettings() {
  const [version, telemetry, login] = await Promise.all([
    appVersion().catch(() => null),
    telemetryStatus().catch(() => null),
    startAtLogin().catch(() => null),
  ]);
  const engine = engineLabel(state.engine);
  const popupSupported = await alerts.popupAvailable();
  openSettings([
    alertsSettingsSection({
      popupSupported,
      startAtLogin: login,
      onCloseToTray: alerts.syncCloseToTray,
      onStartAtLogin: changeStartAtLogin,
      onNotificationSettings: alerts.openSystemNotificationSettings,
      onTestAlert: alerts.sendTestAlert,
      onOpenWatching: () => {
        closeDialog();
        openWatching();
      },
    }),
    serverListSettingsSection(),
    adminSettingsSection({ controller: admin, onAdded: () => showSection("admin") }),
    installSettingsSection({
      engine,
      onChangeInstall: () => {
        if (state.joining) return;
        closeDialog();
        setup.change();
      },
    }),
    privacySettingsSection({
      telemetry,
      onTelemetry: setTelemetryShared,
      onTelemetryDetails: openTelemetryDetails,
    }),
    aboutSettingsSection({
      version,
      onUpdate: () => {
        closeDialog();
        updates.open();
      },
      onCheckUpdate: () => updates.check(),
      onReportBug: () => void openBugReport(),
    }),
  ]);
}

function render() {
  opening.resume();
  const ready = Boolean(state.install);
  shell.classList.toggle("hidden", !ready);
  setupRoot.classList.toggle("hidden", ready);
  if (!ready) return;

  $("#game-switch-game").textContent = GAME_LABELS[state.game] ?? state.game;
  $("#game-switch-engine").textContent = engineLabel(state.engine);
  $("#game-switch").title = `${displayPath(state.install.root)}\nChange game, engine or folder`;
  $("#reveille-update-btn").classList.toggle("hidden", !state.selfUpdate.offer);
  $("#reveille-update-btn").disabled = state.joining;
  const active = activeSection();
  const collapsed = state.detailCollapsed || !(active.detailVisible?.() ?? true);
  for (const section of registeredSections()) {
    const shown = section === active;
    for (const part of section.parts) part.classList.toggle("hidden", !shown);
    section.detail.classList.toggle("hidden", !shown || collapsed);
  }
  $("main.split").classList.toggle("split--wide", collapsed);
  rail.render();
  servers.render();
  if (active.id === "servers" && !collapsed) join.render();
  if (active.id === "content") {
    catalogue.ensureLoaded();
    content.render();
  }
  admin.watch(active.id === "admin");
  if (active.id === "admin") adminPage.render();
}

/** "I run this server…" on a row: the server in Admin, or the dialog that adds it there. */
function runServer(address, hostname) {
  if (state.admin.servers.some((server) => server.address === address)) {
    showSection("admin");
    admin.select(address);
    return;
  }
  openAddServer({
    controller: admin,
    vault: state.admin.vault,
    address,
    name: hostname,
    onAdded: () => showSection("admin"),
  });
}

function openWatching() {
  showSection("servers");
  servers.selectScope("watching");
}

/** From a map's Running now list: the server, selected in the full list. */
function showServer(address) {
  showSection("servers");
  servers.selectScope("all");
  intents.select(address);
}

/**
 * From a map's Running now list, once the map is installed: the server is asked again, so its join
 * is judged against the folder the map just went into, and then joined as a double-click would.
 */
function joinServer(row) {
  intents.openServer({
    game: state.game,
    address: row.address,
    queryPort: Number(row.server.endpoint.query_port),
    hostname: row.server.hostname,
    join: true,
  });
}

function toggleDetail() {
  update((next) => (next.detailCollapsed = !next.detailCollapsed));
  saveFilters();
}

/* Anonymous statistics ------------------------------------------------------ */

function openTelemetryDetails() {
  void openExternalUrl(TELEMETRY_DETAILS_URL).catch(() => {});
}

/* Session changes ----------------------------------------------------------- */

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
  { root: () => activeSection().parts[0], enter: () => activeSection().focusSearch() },
  { root: () => activeSection().parts[1], enter: () => activeSection().focusList() },
  {
    root: () => activeSection().detail,
    enter: () => activeSection().detail.querySelector("button, input, select, a[href]")?.focus(),
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
  const inServers = activeSection().id === "servers";
  if (findOrRefreshModifier && event.shiftKey && /^Digit[1-9]$/u.test(event.code)) {
    // `code`, not `key`: with Shift held, the key reads `!`, `"` or `&` depending on the layout.
    event.preventDefault();
    const section = sections()[Number(event.code.slice(5)) - 1];
    if (section) showSection(section.id);
  } else if (event.key === "F6") {
    event.preventDefault();
    cycleRegion(event.shiftKey);
  } else if (findOrRefreshModifier && (event.key === "f" || event.key === "F")) {
    // Ctrl+F on Windows and Command+F on macOS are the native "find in this thing" chords. `/`
    // stays for the players who learned it here.
    event.preventDefault();
    activeSection().focusSearch();
  } else if (findOrRefreshModifier && /^[1-4]$/u.test(event.key)) {
    event.preventDefault();
    showSection("servers");
    servers.selectScope(SCOPES[Number(event.key) - 1]);
  } else if (findOrRefreshModifier && (event.key === "d" || event.key === "D")) {
    event.preventDefault();
    toggleDetail();
  } else if (event.key === "?" && !typing && !event.ctrlKey && !event.metaKey) {
    event.preventDefault();
    openShortcuts();
  } else if (event.key === "/" && !typing) {
    event.preventDefault();
    activeSection().focusSearch();
  } else if (event.key === "Escape" && popoverAnchor()) {
    closePopover({ restoreFocus: true });
  } else if (event.key === "Escape" && menuIsOpen()) {
    closeMenu();
  } else if (event.key === "Escape" && typing) {
    activeSection().clearSearch();
  } else if (event.key === "F5" || (findOrRefreshModifier && event.key.toLowerCase() === "r")) {
    event.preventDefault();
    activeSection().refresh();
  } else if (!inServers) {
    // The single-letter keys below act on the selected server.
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
    void intents.togglePlayerAlert(row);
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
if (preferences().closeToTray) alerts.syncCloseToTray(true);
alerts.keepWatchingInBackground();
setup.detect();
void updates.find();
void admin.load();

function engineLabel(engine) {
  return ENGINE_LABELS[engine] ?? ENGINE_LABELS.original;
}
