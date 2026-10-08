// SPDX-License-Identifier: GPL-3.0-only

// Commands (crates/reveille-app/src/main.rs), each taking the `session` described in
// `features/servers/api.js`:
//   preview_join(session, address, onProgress)                  -> JoinPreview
//   install_server_files(session, address, onPreviewProgress)   -> ServerFilesResult
//   install_and_launch(session, address, selectedCandidateIds, acceptIncomplete) -> JoinResult
//
// Channels:
//   preview_join.onProgress                 PreviewProgress  { address, index, of, map }
//   install_server_files.onPreviewProgress  PreviewProgress  (the preview it builds once the files land)
//
// Events:
//   reveille://install  InstallProgress  { map, filename, index, of, phase, ... }

import { invoke, invokeWithChannel, listen } from "../../lib/bridge.js";

/** `onProgress` hears this preview only, and nothing after it settles. */
export const previewJoin = (session, address, onProgress) =>
  invokeWithChannel("preview_join", { session, address }, "onProgress", onProgress);

/** `onPreviewProgress` hears the preview this call builds once the server files are in place. */
export const installServerFiles = (session, address, onPreviewProgress) =>
  invokeWithChannel("install_server_files", { session, address }, "onPreviewProgress", onPreviewProgress);

export const installAndLaunch = (session, address, selectedCandidateIds, acceptIncomplete) =>
  invoke("install_and_launch", { session, address, selectedCandidateIds, acceptIncomplete });

export const onInstallProgress = (handler) => listen("reveille://install", handler);
