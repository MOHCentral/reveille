// SPDX-License-Identifier: GPL-3.0-only

// Reporting a bug: a prefilled GitHub issue opened through the scoped system opener.

import { openDialog } from "../../lib/dialog.js";
import { el } from "../../lib/dom.js";
import { openExternalUrl } from "../../lib/shell.js";
import { state } from "../../lib/store.js";
import { appLogFiles } from "./api.js";
import { issueUrl } from "./format.js";

/** Open a prefilled issue in the browser, or show its link when no browser can be opened. */
export async function openBugReport() {
  const logs = await appLogFiles().catch(() => null);
  const url = issueUrl(state, logs);
  try {
    await openExternalUrl(url);
    return;
  } catch {
    // The URL remains usable even when Windows has no registered browser or opening it is denied.
  }
  openDialog(
    "Report a bug",
    el("p", null, "Reveille could not open your browser from this window."),
    el("p", null, "Use this link to open a new issue:"),
    el("p", { className: "quiet data" }, url),
    el(
      "button",
      {
        type: "button",
        className: "btn btn--sm btn--primary",
        onclick: () => navigator.clipboard?.writeText(url).catch(() => {}),
      },
      "Copy link",
    ),
  );
}
