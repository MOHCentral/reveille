// SPDX-License-Identifier: GPL-3.0-only

import { el, fill } from "../lib/dom.js";
import {
  cancelGameInstallationCopy, cancelOpenMohaaInstall, cancelRebornInstall, copyGameInstallation,
  detectInstall, engineOverview, errorText, identifyInstall, installOpenMohaa, installReborn,
  installationStorage, onInstallationCopyProgress, onOpenMohaaInstallProgress,
  onRebornInstallProgress, openMohaaStatus, pickCopyDestination, pickInstallFolder, selectEngine,
} from "../lib/api.js";
import { bytes, displayPath } from "../lib/format.js";
import {
  GAME_LABELS, defaultGame, migrateInstallationPreferences, notify, playableGames, recallEngine,
  rememberEngine, rememberGame, rememberInstall, state,
} from "../lib/store.js";

const PRODUCT_NAMES = { allied_assault: "Allied Assault", spearhead: "Spearhead", breakthrough: "Breakthrough" };
const DESCRIPTIONS = {
  openmohaa: "Open-source rebuild of the game, made for modern Windows and still updated.",
  reborn: "The original game with community fixes. Windows only.",
  original: "The game program you already have, unchanged.",
};
const LABELS = { openmohaa: "OpenMoHAA", reborn: "Reborn", original: "Original game" };
const RECOMMENDED = "openmohaa";

/**
 * One setup, drawn in two places.
 *
 * `first-run` fills the window before any session exists. `change` is the same folder and program
 * choice in a dialog over the server list, opened from the title bar or Settings, so changing the
 * program no longer tears the session down and Cancel leaves it exactly as it was. `current` is
 * what that session runs, so the dialog can tell a change from a no-op.
 */
const view = {
  mode: "first-run", current: null, found: false,
  candidate: null, missing: null, message: "", busy: true, error: null, manualPath: "", overview: null,
  selected: null, channel: "stable", game: null, openStatus: null, openError: null,
  installing: null, stopping: false, progress: null, result: null,
  storage: null, copyDestination: null, copying: false, copyStopping: false, copyProgress: null,
};
let loadToken = 0;
let callbacks = {};
let redraw = () => {};
let changeDialog = null;

export function setupView(root, dialog, { onReady, onApply, onUpdate, onReportBug }) {
  callbacks = { onReady, onApply, onUpdate, onReportBug };
  changeDialog = dialog;
  const body = dialog.querySelector("[data-setup-body]");
  const foot = dialog.querySelector("[data-setup-foot]");
  const render = () => {
    if (view.mode === "change") {
      fill(body, dialogBody(render));
      fill(foot, dialogFoot(render));
    } else {
      fill(root, card(render));
    }
  };
  redraw = render;
  const renderUpdateOffer = () => {
    const button = root.querySelector("[data-self-update-offer]");
    if (button) button.classList.toggle("hidden", !state.selfUpdate.offer);
  };
  // A program install or a copy cannot be abandoned half-written by closing the dialog.
  dialog.addEventListener("cancel", (event) => {
    if (locked()) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    view.mode = "first-run";
    resetCandidate();
  });
  void onOpenMohaaInstallProgress((progress) => progressFor("openmohaa", progress, render));
  void onRebornInstallProgress((progress) => progressFor("reborn", progress, render));
  void onInstallationCopyProgress((progress) => {
    if (!view.copying) return;
    view.copyProgress = progress;
    render();
  });
  render();
  return {
    render,
    renderUpdateOffer,
    detect: () => autoDetect(render),
    change: () => openChange(dialog, render),
  };
}

function progressFor(engine, progress, render) {
  if (view.installing !== engine) return;
  view.progress = progress;
  render();
}

/** The hidden first-run card keeps its nodes while the dialog is open, so the two never share ids. */
function domId(name) { return view.mode === "change" ? `change-${name}` : name; }

function locked() { return view.busy || Boolean(view.installing) || view.copying; }

/* First run ---------------------------------------------------------------- */

function card(render) {
  const install = view.candidate;
  const protectedFolder = view.storage?.status === "protected";
  return el("div", { className: "setup" }, el("div", { className: "setup__card" },
    el("div", { className: "setup__brand" }, el("span", { className: "wordmark" }, "Reveille"), el("span", { className: "label" }, "First run")),
    el("h1", { className: "setup__title" }, install ? "Two things before the server list" : view.busy ? "Looking for your game" : "Where is your game?"),
    !protectedFolder && view.message && el("p", { className: "setup__lede" }, view.message),
    folderStep(install, render),
    programStep(install, render),
    install && goBlock(render),
    view.error && el("p", { className: "error", role: "alert" }, view.error),
    el("div", { className: "setup__foot" },
      el("button", { type: "button", className: `btn btn--sm btn--primary ${state.selfUpdate.offer ? "" : "hidden"}`, "data-self-update-offer": true, disabled: locked(), onclick: callbacks.onUpdate }, "Update Reveille"),
      el("button", { type: "button", className: "btn btn--sm btn--utility", disabled: locked(), onclick: callbacks.onReportBug }, "Report a bug")),
  ));
}

function step(number, title, { done = false, waiting = false, aside = null }, ...body) {
  const phase = done ? "done" : waiting ? "wait" : "now";
  return el("section", { className: `setup-step setup-step--${phase}`, "aria-label": title },
    el("span", { className: "setup-step__n", "aria-hidden": "true" }, done ? "✓" : String(number)),
    el("div", { className: "setup-step__head" },
      el("h2", { className: "label setup-step__title" }, title),
      aside && el("span", { className: "quiet" }, aside)),
    el("div", { className: "setup-step__body" }, ...body));
}

function folderStep(install, render) {
  if (install) {
    return step(1, "Game folder", { done: true, aside: view.found ? "Found automatically" : null }, folderBox(install, render));
  }
  if (view.busy) {
    return step(1, "Game folder", {},
      el("div", { className: "meter meter--indeterminate", role: "status", "aria-label": "Looking for the game" }, el("span", { className: "meter__fill" })));
  }
  return step(1, "Game folder", {}, manualBlock(render));
}

function programStep(install, render) {
  if (!install) {
    return step(2, "Game program", { waiting: true },
      el("p", { className: "quiet" }, "Choose OpenMoHAA, Reborn or the original game once the folder is found."));
  }
  return step(2, "Game program", { aside: "Change it any time in Settings" }, programList(install, render));
}

/** The one action that finishes setup, priced when it downloads, or its progress while it runs. */
function goBlock(render) {
  if (view.installing) return installProgress(render);
  const action = primaryAction();
  const games = playableGames(view.candidate);
  const game = view.game ?? defaultGame(view.candidate);
  const others = games.filter((other) => other !== game).map((other) => GAME_LABELS[other] ?? other);
  return el("div", { className: "setup__go" },
    el("button", { type: "button", className: "btn btn--primary btn--block", disabled: !action.run || locked(),
      onclick: () => void action.run(render) }, action.label),
    others.length > 0 && el("p", { className: "setup__hint" }, "Opens on ", el("strong", null, GAME_LABELS[game] ?? game),
      `. Switch to ${others.join(" or ")} from the title bar.`));
}

/* Change dialog ------------------------------------------------------------ */

function openChange(dialog, render) {
  if (!state.install || dialog.open) return;
  resetCandidate();
  view.mode = "change";
  view.current = { root: state.install.root, engine: state.engine, game: state.game, playable: playableGames(state.install).join() };
  view.found = false; view.busy = false; view.error = null; view.message = "";
  view.game = state.game;
  render();
  dialog.showModal();
  void reopenSavedFolder(state.install, render);
}

/**
 * Read the session's folder again before offering its programs.
 *
 * The server list sends a player here when that folder moved or was deleted. Loading programs for
 * a folder that is gone only produces errors, so say plainly that it must be chosen again.
 */
async function reopenSavedFolder(saved, render) {
  const token = loadToken;
  let install = null;
  try { install = await identifyInstall(saved.root); } catch { /* Shown as a missing folder. */ }
  if (token !== loadToken) return;
  if (!install || playableGames(install).length === 0) { view.missing = saved.root; render(); return; }
  adoptCandidate(install);
  render();
  await Promise.all([loadOverview(install, render), loadStorage(install, render)]);
}

function closeChange() {
  if (changeDialog?.open) changeDialog.close();
}

function dialogBody(render) {
  const install = view.candidate;
  const action = primaryAction();
  return [
    el("section", { className: "setup-section" }, el("h3", { className: "label" }, "Game folder"),
      install ? folderBox(install, render)
        : view.missing ? missingFolderBox(view.missing, render)
          : el("div", { className: "meter meter--indeterminate" }, el("span", { className: "meter__fill" }))),
    el("section", { className: "setup-section" }, el("h3", { className: "label" }, "Game program"),
      install ? programList(install, render) : view.missing && el("p", { className: "quiet" }, "Choose the game folder first."),
      action.run && changed() && el("p", { className: "quiet" }, "Reveille searches the server list again after the switch.")),
    view.installing && installProgress(render),
    view.error && el("p", { className: "error", role: "alert" }, view.error),
  ];
}

function dialogFoot(render) {
  const action = primaryAction();
  return [
    el("button", { type: "button", className: "btn", disabled: locked(), onclick: closeChange }, "Cancel"),
    el("button", { type: "button", className: "btn btn--primary", disabled: !action.run || locked(),
      onclick: () => void action.run(render) }, action.label),
  ];
}

function changed() {
  return view.mode === "change" && Boolean(view.candidate) &&
    (view.candidate.root !== view.current?.root || view.selected !== view.current?.engine ||
      // The folder is read again on open, so its games may differ from the session's.
      view.game !== view.current?.game || playableGames(view.candidate).join() !== view.current?.playable);
}

/* Folder ------------------------------------------------------------------- */

function folderBox(install, render) {
  const products = (install.products ?? []).map((product) => PRODUCT_NAMES[product] ?? product);
  return el("div", { className: "folder-box" },
    el("span", { className: "folder-box__path data selectable" }, displayPath(install.root)),
    el("button", { type: "button", className: "btn btn--sm", disabled: locked(), onclick: () => void browse(render) },
      view.mode === "change" ? "Change folder…" : "Change…"),
    el("span", { className: "folder-box__games" }, products.length
      ? products.map((name) => el("span", { className: "folder-box__game" }, name))
      : el("span", { className: "quiet" }, "No recognised game data")),
    storageNote(install, render));
}

function missingFolderBox(path, render) {
  return el("div", { className: "folder-box" },
    el("span", { className: "folder-box__path data selectable" }, displayPath(path)),
    el("button", { type: "button", className: "btn btn--sm", disabled: locked(), onclick: () => void browse(render) }, "Change folder…"),
    el("p", { className: "folder-box__warn" },
      "Reveille cannot find the game in this folder any more. It may have moved, been deleted, or be on a drive that is not connected. Choose the game folder again."));
}

/**
 * A protected folder, said where it applies: inside the folder it describes.
 *
 * It limits what can be written, not what can be played, so it is a warning beside the folder
 * rather than an error above everything. The copy it offers is priced before it starts, and the
 * programs that would need it say so on their own rows.
 */
function storageNote(install, render) {
  const storage = view.storage;
  if (!storage || storage.status === "writable") return false;
  if (storage.status === "unavailable") {
    return el("p", { className: "folder-box__warn" }, "Folder access could not be checked. Choose the folder again or report the problem.");
  }
  const destination = view.copyDestination ?? storage.suggested_destination;
  return el("div", { className: "folder-box__warn" },
    el("p", null, "Windows protects this game folder, so maps and game programs can't be installed into it. ",
      el("span", { className: "quiet" }, "The original stays unchanged.")),
    view.copying ? copyProgress(storage, render) : el("div", { className: "folder-box__copy" },
      el("button", { type: "button", className: "btn btn--sm", disabled: !destination || locked(),
        onclick: () => void runCopy(install, destination, render) }, `Make a copy (${bytes(storage.source_bytes)})`),
      el("button", { type: "button", className: "btn btn--sm btn--ghost", disabled: locked(),
        onclick: () => void chooseCopyDestination(install, render) }, "Choose another location"),
      destination && el("span", { className: "quiet" }, "Copies to ", el("span", { className: "data selectable" }, displayPath(destination)))));
}

function copyProgress(storage, render) {
  const progress = view.copyProgress;
  const percent = progress?.total_bytes ? Math.min(100, (progress.copied_bytes / progress.total_bytes) * 100) : 0;
  return el("div", { className: "stack--tight" },
    el("span", { className: "meter", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": String(Math.round(percent)) },
      el("span", { className: "meter__fill", style: `width: ${percent}%` })),
    el("span", { className: "row-between" },
      el("span", { className: "quiet data" }, `${bytes(progress?.copied_bytes ?? 0)} of ${bytes(progress?.total_bytes ?? storage.source_bytes)}`),
      el("button", { type: "button", className: "btn btn--sm btn--ghost", disabled: view.copyStopping, onclick: () => void stopCopy(render) },
        view.copyStopping ? "Stopping…" : "Cancel copy")));
}

/**
 * What Reveille needs on disk, said before the player spends any effort looking for it.
 *
 * Setup can install a game *program*, never the game *data* `install::identify` requires, so the
 * base game is stated as a precondition up front rather than discovered as a failure.
 */
function manualBlock(render) {
  const use = el("button", { type: "button", className: "btn", disabled: view.manualPath.trim() === "",
    onclick: () => void check(view.manualPath, render) }, "Use");
  return el("div", { className: "stack" },
    el("p", { className: "setup__needs" },
      "Reveille needs the game files from your own copy of Medal of Honor: a disc install, GOG or the EA App. Pick the folder that contains a ",
      el("span", { className: "data" }, "main"), " folder."),
    el("button", { type: "button", className: "btn btn--primary btn--block", onclick: () => void browse(render) }, "Browse for the game folder…"),
    el("div", { className: "setup__row" },
      el("label", { className: "field", for: "install-path" },
        el("span", { className: "sr-only" }, "Game folder path"),
        el("input", { id: "install-path", type: "text", autocomplete: "off", spellcheck: false, placeholder: "or paste its path here", value: view.manualPath,
          oninput: (event) => { view.manualPath = event.target.value; use.disabled = view.manualPath.trim() === ""; },
          onkeydown: (event) => { if (event.key === "Enter" && view.manualPath.trim()) void check(view.manualPath, render); } })),
      use));
}

/* Programs ----------------------------------------------------------------- */

function programList(install, render) {
  if (!view.overview) return el("div", { className: "meter meter--indeterminate", role: "status", "aria-label": "Reading the game programs" }, el("span", { className: "meter__fill" }));
  const engines = view.overview.capabilities?.engines ?? [];
  return el("fieldset", { className: "programs", disabled: locked() },
    el("legend", { className: "sr-only" }, "Choose how to run the game"),
    engines.map((engine) => programRow(engine, install, render)));
}

function programRow(engine, install, render) {
  const selected = view.selected === engine;
  const id = domId(`engine-${engine}`);
  const status = programState(engine);
  return el("div", { className: `program ${selected ? "program--selected" : ""}` },
    el("input", { id, type: "radio", name: "engine-choice", value: engine, checked: selected, onchange: () => void chooseEngine(engine, install, render) }),
    el("label", { for: id, className: "program__label" },
      el("span", { className: "program__name" }, LABELS[engine], engine === RECOMMENDED && el("span", { className: "program__tag" }, "Recommended")),
      el("span", { className: `program__state ${status.ok ? "program__state--ok" : ""}` }, status.text),
      el("span", { className: "program__desc" }, DESCRIPTIONS[engine])),
    selected && programDetails(engine, install, render));
}

/** What each row costs or already is, stated on the row so no choice has to be opened to be priced. */
function programState(engine) {
  if (isInstalled(engine)) return { text: inUse(engine) ? "Installed · in use" : "Installed", ok: true };
  if (engine === "original") return { text: "Not found" };
  if (engine === "reborn" && !view.overview.reborn.supported) return { text: "Windows only" };
  if (view.storage?.status === "protected") return { text: "Needs a copy" };
  const size = downloadSize(engine);
  return { text: size === null ? "Not installed" : `${bytes(size)} download` };
}

function inUse(engine) {
  return view.mode === "change" && view.candidate?.root === view.current?.root && view.current?.engine === engine;
}

function downloadSize(engine) {
  if (engine === "reborn") return view.overview?.reborn?.size ?? null;
  if (engine === "openmohaa" && view.openStatus?.availability === "available") return view.openStatus.package.size;
  return null;
}

function programDetails(engine, install, render) {
  if (engine === "original") return isInstalled(engine) ? false : el("p", { className: "program__details note note--bad" }, "No original game program was found.");
  return engine === "reborn" ? rebornDetails(install, render) : openDetails(install, render);
}

function rebornDetails(install, render) {
  const info = view.overview.reborn;
  const build = view.overview.inventory.reborn_build;
  const details = [
    build?.state === "known_other" && el("span", { className: "quiet" }, `${build.version} is installed. Reveille will not call it current.`),
    build?.state === "unknown" && el("span", { className: "quiet" }, "Reborn files are present, but this version is unknown."),
    !info.supported && el("span", { className: "note note--bad" }, "This legacy Reborn package supports Windows only."),
    isInstalled("reborn") && !view.installing && rebornAction(install, info, build, render),
    view.result?.engine === "reborn" && el("span", { className: "note note--brass" }, "Reborn is installed and active."),
  ].filter(Boolean);
  return details.length > 0 && el("div", { className: "program__details" }, details);
}

/**
 * Reborn's secondary action once something is installed; installing from nothing is the setup's
 * own primary button. Reveille installs one pinned package, so any other build is something this
 * can change, and a build proved to be the pinned one is only offered a reinstall.
 */
function rebornAction(install, info, build, render) {
  const current = build?.state === "current";
  const label = current ? "Reinstall this version" : `Install Reborn ${info.version}`;
  return el("button", { type: "button", className: "btn btn--sm", disabled: !info.supported || locked(),
    onclick: (event) => { event.preventDefault(); void runRebornInstall(install, render); } }, `${label} (${bytes(info.size)})`);
}

function openDetails(install, render) {
  const status = view.openStatus;
  const available = status?.availability === "available";
  return el("div", { className: "program__details" },
    el("span", { className: "program__release" },
      el("label", { for: domId("openmohaa-channel") }, "Release"),
      el("select", { id: domId("openmohaa-channel"), value: view.channel, disabled: locked(),
        onchange: (event) => { view.channel = event.target.value; view.result = null; void loadOpenStatus(install, render); } },
        el("option", { value: "stable", selected: view.channel === "stable" }, "Stable"),
        el("option", { value: "preview", selected: view.channel === "preview" }, "Preview — less tested")),
      available && el("span", { className: "data" }, status.package.prerelease ? `${status.package.version} — preview` : status.package.version),
      available && el("span", { className: "quiet", title: status.package.digest }, "Checked after download")),
    view.openError && el("span", { className: "note note--bad", title: view.openError }, "Release details could not be checked right now."),
    status?.availability === "unsupported" && el("span", { className: "note note--bad" }, "OpenMoHAA is unavailable for this computer."),
    available && openBuildNote(status.installed_build),
    available && openRunningNote(status),
    available && isInstalled("openmohaa") && !view.installing && openAction(install, status, render),
    view.result?.engine === "openmohaa" && openOutcomeNote(view.result));
}

function openBuildNote(build) {
  if (build?.state === "current") return el("span", { className: "quiet" }, "This exact version is installed.");
  if (build?.state === "known_other") return el("span", { className: "quiet" }, knownOtherText(build));
  if (build?.state === "unknown") return el("span", { className: "quiet" }, "OpenMoHAA is installed, but this version is unknown.");
  return false;
}

function knownOtherText(build) {
  if (build.relation === "older") return `${build.version} is installed, which is newer than this one.`;
  if (build.relation === "same_version") return `${build.version} is installed, from a different release file.`;
  return `${build.version} is installed.`;
}

/**
 * The installed OpenMoHAA's secondary action, named after what it will actually do.
 *
 * The wording comes from the receipt comparison in Rust, never from comparing version strings
 * here. The channel selector can legitimately offer a *lower* version — preview holds
 * `v0.83.0-rc.2`, stable offers `v0.82.1` — and calling that an update would name a rollback
 * something the player did not choose. A build Reveille can prove is the offered one is only
 * offered a reinstall.
 */
function openAction(install, status, render) {
  const build = status.installed_build;
  const label = build?.state === "current" ? "Reinstall this version" : openActionLabel(build, status.package.version);
  return el("button", { type: "button", className: "btn btn--sm", disabled: locked(),
    onclick: (event) => { event.preventDefault(); void runOpenInstall(install, render); } }, `${label} (${bytes(status.package.size)})`);
}

function openActionLabel(build, version) {
  if (build?.state !== "known_other") return `Install ${version}`;
  if (build.relation === "newer") return `Update to ${version}`;
  if (build.relation === "older") return `Go back to ${version}`;
  if (build.relation === "same_version") return `Reinstall ${version}`;
  return `Install ${version}`;
}

/**
 * Said before the download rather than after it.
 *
 * Reveille will not write over files a running program is using, and it proves that only once
 * the archive has arrived, so a player told afterwards has paid for the download for nothing.
 * With nothing installed there is nothing to overwrite.
 */
function openRunningNote(status) {
  if (status.installed_build?.state === "absent") return false;
  if (status.activity?.state !== "running") return false;
  return el("span", { className: "note note--bad" }, "OpenMoHAA is running. Close it first — Reveille will not replace files a running program is using.");
}

/** What the install actually did, including the case where it deliberately did nothing. */
function openOutcomeNote(result) {
  const outcome = result.outcome?.outcome;
  if (outcome === "deferred") {
    return el("span", { className: "note note--bad", role: "alert" }, result.outcome.reason === "client_running"
      ? "OpenMoHAA was running when the download finished, so nothing in the folder was changed. Close the game and try again."
      : "Reveille could not confirm OpenMoHAA was closed when the download finished, so nothing in the folder was changed. Close the game and try again.");
  }
  return el("span", { className: "note note--brass" }, outcome === "updated"
    ? `OpenMoHAA is now ${result.version}, and active.`
    : `OpenMoHAA ${result.version} is installed and active.`);
}

function installProgress(render) {
  const received = view.progress?.received ?? 0;
  const total = view.progress?.total ?? null;
  const percent = total ? Math.min(100, (received / total) * 100) : null;
  return el("div", { className: "install-progress", role: "status" },
    el("span", { className: "row-between" },
      el("span", { className: "quiet" }, `Downloading ${LABELS[view.installing]}`),
      el("span", { className: "data" }, total ? `${bytes(received)} of ${bytes(total)}` : "Preparing download")),
    el("span", { className: `meter ${percent === null ? "meter--indeterminate" : ""}` }, el("span", { className: "meter__fill", style: percent === null ? null : `width: ${percent}%` })),
    el("span", { className: "row-between" },
      el("span", { className: "quiet" }, view.mode === "change" ? "Reveille switches when it's done." : "Reveille opens the server list when it's done."),
      el("button", { type: "button", className: "btn btn--sm btn--ghost", disabled: view.stopping, onclick: (event) => { event.preventDefault(); void stopInstall(render); } },
        view.stopping ? "Stopping…" : "Stop download")));
}

/**
 * The setup's one primary action, named for everything it will do.
 *
 * Choosing a program that is not installed used to disable Continue and put a second primary
 * Install button inside the card, so finishing setup took two presses in the right order. The
 * install now rides on the button that finishes setup, priced, and a program that cannot be
 * installed here says why instead.
 */
function primaryAction() {
  if (view.missing && !view.candidate) return { label: "Choose a game folder" };
  const verb = view.mode === "change" ? "switch" : "continue";
  const engine = view.selected;
  if (!view.overview || !engine) return { label: "Choose a game program" };
  const name = LABELS[engine];
  if (engine === "reborn" && !view.overview.reborn.supported) return { label: "Choose an available program" };
  if (isInstalled(engine)) {
    if (view.mode !== "change") return { label: "Continue to servers", run: accept };
    if (!changed()) return { label: "No changes" };
    return { label: engine === view.current.engine ? "Use this folder" : `Switch to ${name}`, run: accept };
  }
  if (engine === "original") return { label: "Choose an available program" };
  if (view.storage?.status === "protected") return { label: `Make a copy to install ${name}` };
  const size = downloadSize(engine);
  if (size === null) return { label: `${name} can't be installed right now` };
  return { label: `Install ${name} (${bytes(size)}) and ${verb}`, run: installAndAccept };
}

async function installAndAccept(render) {
  const install = view.candidate;
  const installed = view.selected === "openmohaa" ? await runOpenInstall(install, render) : await runRebornInstall(install, render);
  if (installed && selectedAvailable()) await accept(render);
}

/* State -------------------------------------------------------------------- */

/** Take an identified folder as the candidate, keeping the game choice valid for it. */
function adoptCandidate(install) {
  view.candidate = install;
  if (!playableGames(install).includes(view.game)) view.game = defaultGame(install);
}

function isInstalled(engine) { return Boolean(view.overview?.inventory?.[`${engine}_installed`]); }
function selectedAvailable() {
  if (!view.selected || !view.overview) return false;
  if (view.selected === "reborn" && !view.overview.reborn.supported) return false;
  return isInstalled(view.selected);
}

async function chooseEngine(engine, install, render) {
  view.selected = engine; view.error = null; view.result = null; render();
  if (engine === "openmohaa" && !view.openStatus) await loadOpenStatus(install, render);
}

async function loadOverview(install, render) {
  const token = ++loadToken;
  try {
    const overview = await engineOverview(install.root, recallEngine(install.root));
    if (token !== loadToken) return;
    const supported = overview.capabilities?.engines ?? [];
    view.overview = overview; view.selected = overview.resolved;
    if (!supported.includes(view.selected) && supported.length === 1) view.selected = supported[0];
    // Loaded whenever OpenMoHAA is offered at all, because its row states the download size.
    if (supported.includes("openmohaa")) void loadOpenStatus(install, render);
  } catch (error) { if (token === loadToken) view.error = errorText(error); }
  render();
}

async function loadStorage(install, render) {
  const token = loadToken;
  try {
    const storage = await installationStorage(install.root);
    if (token !== loadToken) return;
    view.storage = storage;
    view.copyDestination = storage.suggested_destination ?? null;
  } catch (error) {
    if (token !== loadToken) return;
    view.storage = { status: "unavailable" };
    view.error = errorText(error);
  }
  render();
}

async function chooseCopyDestination(install, render) {
  try {
    const destination = await pickCopyDestination(install.root);
    if (destination) view.copyDestination = destination;
  } catch (error) {
    view.error = errorText(error);
  }
  render();
}

async function runCopy(install, destination, render) {
  if (!destination) return;
  view.copying = true;
  view.copyStopping = false;
  view.copyProgress = null;
  view.error = null;
  render();
  try {
    const result = await copyGameInstallation(install.root, destination);
    if (result.outcome === "cancelled") {
      view.error = "The copy was cancelled. The incomplete copy was removed.";
      return;
    }
    const copied = result.installation;
    migrateInstallationPreferences(
      install.root,
      copied.root,
      view.selected,
      view.game ?? defaultGame(install),
    );
    resetCandidate();
    adoptCandidate(copied);
    view.found = false;
    view.manualPath = displayPath(copied.root);
    view.message = "The copy is ready. The original game folder was not changed.";
    await Promise.all([loadOverview(copied, render), loadStorage(copied, render)]);
  } catch (error) {
    view.error = errorText(error);
  } finally {
    view.copying = false;
    view.copyStopping = false;
    view.copyProgress = null;
    render();
  }
}

async function stopCopy(render) {
  view.copyStopping = true;
  render();
  try {
    await cancelGameInstallationCopy();
  } catch (error) {
    view.error = errorText(error);
    view.copyStopping = false;
    render();
  }
}

async function loadOpenStatus(install, render) {
  const token = loadToken;
  view.openError = null; render();
  try {
    const status = await openMohaaStatus(install.root, view.channel);
    if (token !== loadToken) return;
    view.openStatus = status;
  } catch (error) {
    if (token !== loadToken) return;
    view.openStatus = null; view.openError = errorText(error?.detail ?? error);
  }
  render();
}

/**
 * A deferred install is not a failure and is not a success either.
 *
 * `install_openmohaa` resolves with what it actually did. Replacement is refused while one of the
 * engine's programs is running or cannot be proved stopped, and that check happens after the
 * transfer, so the ordinary success path would otherwise report an install that wrote nothing.
 * Nothing changed on disk, so the engine choice is left where it was and only the release
 * details are re-read. Resolves true only when the folder now holds the offered build.
 */
async function runOpenInstall(install, render) {
  if (!view.openStatus?.package) return false;
  const version = view.openStatus.package.version;
  beginInstall("openmohaa", render);
  try {
    const result = await installOpenMohaa(install.root, view.openStatus.package.offer_id);
    view.result = { engine: "openmohaa", outcome: result.outcome, version };
    if (result.outcome?.outcome === "deferred") {
      view.installing = null; view.progress = null;
      await loadOpenStatus(install, render);
      return false;
    }
    await reloadAfterInstall(install, "openmohaa", render);
    return true;
  } catch (error) { view.error = errorText(error?.detail ?? error); finishInstall(render); return false; }
}

async function runRebornInstall(install, render) {
  beginInstall("reborn", render);
  try { await installReborn(install.root); view.result = { engine: "reborn" }; await reloadAfterInstall(install, "reborn", render); return true; }
  catch (error) { view.error = errorText(error); finishInstall(render); return false; }
}

function beginInstall(engine, render) { view.installing = engine; view.stopping = false; view.progress = null; view.error = null; view.result = null; render(); }

/**
 * The first run remembers an installed program at once, so a restart lands on it. The dialog
 * records nothing until the player confirms: Cancel must leave the next launch as it was.
 */
async function reloadAfterInstall(install, engine, render) {
  view.installing = null; view.progress = null;
  if (view.mode !== "change") rememberEngine(install.root, engine);
  view.overview = await engineOverview(install.root, engine); view.selected = engine;
  adoptCandidate((await detectInstall(install.root)) ?? install);
  // The row's installed-build line and its action are both read off this status, so a version
  // that has just changed on disk must not keep the reading taken before the install.
  if (engine === "openmohaa") await loadOpenStatus(install, render);
  render();
}
function finishInstall(render) { view.installing = null; view.stopping = false; view.progress = null; render(); }
async function stopInstall(render) {
  view.stopping = true; render();
  try { await (view.installing === "reborn" ? cancelRebornInstall() : cancelOpenMohaaInstall()); }
  catch (error) { view.error = errorText(error); view.stopping = false; render(); }
}

async function browse(render) {
  view.error = null; render();
  try { const folder = await pickInstallFolder(); if (folder) { view.manualPath = folder; await check(folder, render); } }
  catch (error) { view.error = errorText(error); render(); }
}

/** Read a folder the player chose. One that is not a game leaves any folder already found in place. */
async function check(path, render) {
  const previous = view.candidate;
  view.busy = true; view.error = null; render();
  try {
    const install = await detectInstall(path);
    if (install) {
      resetCandidate(); adoptCandidate(install); view.found = false;
      view.message = "Check the folder and pick how to run the game.";
      view.busy = false;
      await Promise.all([loadOverview(install, render), loadStorage(install, render)]);
    } else if (previous) view.error = "That folder holds no Medal of Honor game files.";
    else view.message = "That folder holds no Medal of Honor game files.";
  } catch (error) {
    view.error = errorText(error);
    if (!previous) view.message = "That folder could not be read.";
  } finally { view.busy = false; render(); }
}

/**
 * Find the game on launch, and skip the first run entirely when the remembered folder still
 * holds a playable program and can be written to.
 */
async function autoDetect(render) {
  view.mode = "first-run"; view.busy = true; view.error = null; resetCandidate(); render();
  try {
    const remembered = state.rememberedInstall;
    let install = remembered ? await safeDetect(remembered) : null;
    install ??= await detectInstall(null);
    if (install) {
      adoptCandidate(install); view.found = true; view.manualPath = displayPath(install.root);
      view.message = "Reveille found your game. Check the folder and pick how to run it.";
      await Promise.all([loadOverview(install, render), loadStorage(install, render)]);
      if (remembered && install.root === remembered && selectedAvailable() && view.storage?.status === "writable") await accept(render);
    } else view.message = "Nothing was found in the usual places. Show Reveille the folder once and it remembers it.";
  } catch (error) { view.error = errorText(error); view.message = "Detection failed. Pick the folder instead."; }
  finally { view.busy = false; render(); }
}

async function safeDetect(path) { try { return await detectInstall(path); } catch { return null; } }

/**
 * Commit the choice. The first run starts the session; the dialog hands the new folder, program
 * and game to the shell, which drops what belonged to the old session and searches again.
 */
async function accept(render) {
  const install = view.candidate;
  if (!install || !selectedAvailable()) return;
  view.busy = true; view.error = null; render();
  try {
    view.overview = await selectEngine(install.root, view.selected);
    const engine = view.selected;
    const game = view.mode === "change" && playableGames(install).includes(state.game) ? state.game : view.game ?? defaultGame(install);
    rememberInstall(install.root);
    rememberEngine(install.root, engine); rememberGame(install.root, game);
    if (view.mode === "change") {
      view.busy = false;
      closeChange();
      callbacks.onApply({ install, engine, game });
      return;
    }
    state.install = install; state.engine = engine; state.game = game;
    notify(); callbacks.onReady();
  } catch (error) { view.error = errorText(error); }
  finally { view.busy = false; redraw(); }
}

function resetCandidate() {
  loadToken += 1; view.candidate = null; view.missing = null; view.overview = null; view.selected = null; view.game = null;
  view.openStatus = null; view.openError = null; view.result = null;
  view.storage = null; view.copyDestination = null; view.copyProgress = null; view.copying = false;
  view.copyStopping = false;
}
