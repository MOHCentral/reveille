// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/main.rs), each taking the `session` described in
// `features/servers/api.js`:
//   preview_join(session, address)             -> JoinPreview
//   install_server_files(session, address)     -> ServerFilesResult
//   install_and_launch(session, address, selectedCandidateIds, acceptIncomplete) -> JoinResult
//
// Events:
//   reveille://preview  PreviewProgress  { address, index, of, map }
//   reveille://install  InstallProgress  { map, filename, index, of, phase, ... }

import { invoke, listen } from "../../lib/bridge.js";

export const previewJoin = (session, address) => invoke("preview_join", { session, address });

export const installServerFiles = (session, address) =>
  invoke("install_server_files", { session, address });

export const installAndLaunch = (session, address, selectedCandidateIds, acceptIncomplete) =>
  invoke("install_and_launch", { session, address, selectedCandidateIds, acceptIncomplete });

export const onPreviewProgress = (handler) => listen("reveille://preview", handler);
export const onInstallProgress = (handler) => listen("reveille://install", handler);
