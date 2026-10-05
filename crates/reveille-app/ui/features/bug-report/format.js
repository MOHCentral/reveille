// SPDX-License-Identifier: GPL-3.0-only

// The new issue a bug report opens: a template for the player to fill in, plus what Reveille
// knows about the moment it was opened.

export const ISSUE_TRACKER_URL = "https://github.com/MOHCentral/reveille/issues/new";

/** The new-issue link, prefilled with what Reveille knows about `state` and where its logs are. */
export function issueUrl(state, logs) {
  const params = new URLSearchParams({
    title: "bug: ",
    body: issueTemplate(state, logs),
  });
  return `${ISSUE_TRACKER_URL}?${params.toString()}`;
}

export function issueTemplate(state, logs) {
  const installRoot = state.install?.root ?? "(not selected)";
  const selectedServer = state.selected ?? "(none)";
  const browseError = state.browse.error
    ? `${state.browse.error.kind}: ${state.browse.error.detail}`
    : "(none)";
  const joinError = state.joinError ?? "(none)";
  const previewError = state.previewError ?? "(none)";
  return [
    "## What happened?",
    "",
    "<describe the problem>",
    "",
    "## What did you expect?",
    "",
    "<describe expected behavior>",
    "",
    "## Steps to reproduce",
    "",
    "1.",
    "2.",
    "3.",
    "",
    "## Reveille context",
    "",
    `- Game folder: ${installRoot}`,
    `- Game: ${state.game}`,
    `- Engine: ${state.engine}`,
    `- Selected server: ${selectedServer}`,
    `- Browse error: ${browseError}`,
    `- Preview error: ${previewError}`,
    `- Join error: ${joinError}`,
    "",
    "## Logs",
    "",
    logs
      ? `Attach \`${logs.current}\`. After a crash and restart, also attach \`${logs.previous}\`.`
      : "Attach the Reveille log from the app's local log folder.",
    "Set `RUST_LOG=reveille=debug` before starting Reveille for more detail.",
  ].join("\n");
}
