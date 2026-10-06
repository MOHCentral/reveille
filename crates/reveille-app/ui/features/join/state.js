// SPDX-License-Identifier: GPL-3.0-only

// The keys the join pane owns: the selected server's preview, the player's source choices and the
// join command's run.
//
// The server list reads `joining` to hold its controls, and clears the preview when the row beneath
// it goes away; `selected` stays the server list's, because its sweep, its checks and its table all
// move the selection too.

export function initial() {
  return {
    /** The join preview for the selected row, once it arrives. */
    preview: null,
    previewProgress: null,
    previewError: null,

    /** Candidate ids the player picked for ambiguous maps, keyed by map name. */
    choices: new Map(),

    /** Install run in progress, or null. Downloads only — see `joining` for the whole command. */
    installRun: null,
    /**
     * Whether a server-file install or `install_and_launch` is running.
     *
     * Wider than `installRun`, which is null when a compatible server has nothing to fetch. The join
     * command owns the detail pane for its whole length, downloads or not, so this is what the pane
     * and the one-server check read.
     */
    joining: false,
    joinResult: null,
    joinError: null,
  };
}
