// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/main.rs):
//   detect_install(selectedPath?)              -> Installation | null
//     Installation.products is what is on disk; Installation.playable is what can be run — an
//     expansion needs the base game underneath it. Offer `playable`.
//   identify_install(path)                     -> Installation; rejects when the folder no longer reads
//   openmohaa_status(path, channel)            -> OpenMohaaStatus
//   install_openmohaa(path, offerId)           -> OpenMohaaInstallResult
//   cancel_openmohaa_install()                 -> void
//   installation_storage(path)                 -> InstallationStorageStatus
//   pick_copy_destination(sourcePath)          -> string | null
//   copy_game_installation(sourcePath, destinationPath) -> InstallationCopyResult
//   cancel_game_installation_copy()            -> void
//   pick_install_folder()                      -> string | null
//   engine_overview(path)                      -> EngineOverview
//   select_engine(path, engine)                -> EngineOverview
//   install_reborn(path)                       -> RebornInstallResult
//
// Events:
//   reveille://openmohaa-install OpenMohaaInstallProgress { received, total }

import { errorText, invoke, listen } from "../../lib/bridge.js";

export { errorText };

export const detectInstall = (selectedPath = null) => invoke("detect_install", { selectedPath });
export const identifyInstall = (path) => invoke("identify_install", { path });

export const engineOverview = (path, savedEngine = null) =>
  invoke("engine_overview", { path, savedEngine });
export const selectEngine = (path, engine) => invoke("select_engine", { path, engine });
export const installReborn = (path) => invoke("install_reborn", { path });
export const cancelRebornInstall = () => invoke("cancel_reborn_install");

export const openMohaaStatus = (path, channel) =>
  invoke("openmohaa_status", { path, channel });

export const installOpenMohaa = (path, offerId) =>
  invoke("install_openmohaa", { path, offerId });

export const cancelOpenMohaaInstall = () => invoke("cancel_openmohaa_install");

export const installationStorage = (path) => invoke("installation_storage", { path });
export const pickCopyDestination = (sourcePath) =>
  invoke("pick_copy_destination", { sourcePath });
export const copyGameInstallation = (sourcePath, destinationPath) =>
  invoke("copy_game_installation", { sourcePath, destinationPath });
export const cancelGameInstallationCopy = () => invoke("cancel_game_installation_copy");

export const pickInstallFolder = () => invoke("pick_install_folder");

export const onOpenMohaaInstallProgress = (handler) =>
  listen("reveille://openmohaa-install", handler);
export const onRebornInstallProgress = (handler) => listen("reveille://reborn-install", handler);
export const onInstallationCopyProgress = (handler) =>
  listen("reveille://installation-copy", handler);
