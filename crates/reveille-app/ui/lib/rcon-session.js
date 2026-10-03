// SPDX-License-Identifier: GPL-3.0-only

// What the remote console remembers while Reveille runs, and how it words what a server said.
//
// The command history lives in this module's memory and goes when the process does: a command can
// be `set rconpassword …`, which has no business on disk. The password itself is not kept here
// at all. The Rust side keeps it in the system credential store, and this side never receives it.

const HISTORY_LIMIT = 50;

export function createRconMemory() {
  const history = [];

  return {
    remember(command) {
      if (!command || history.at(-1) === command) return;
      history.push(command);
      if (history.length > HISTORY_LIMIT) history.shift();
    },

    /**
     * Walk the history the way a shell does. `cursor` is where the player is now, with `null`
     * meaning the empty line below the newest command; `direction` is -1 for older, 1 for newer.
     * `text` is `null` when nothing should change.
     */
    step(cursor, direction) {
      if (direction < 0) {
        if (!history.length) return { cursor, text: null };
        const next = Math.max((cursor ?? history.length) - 1, 0);
        return { cursor: next, text: history[next] };
      }
      if (cursor === null) return { cursor, text: null };
      const next = cursor + 1;
      return next >= history.length
        ? { cursor: null, text: "" }
        : { cursor: next, text: history[next] };
    },
  };
}

export const rconMemory = createRconMemory();

const NO_ANSWER =
  "No answer. The command may still have run: a server replies after it has finished, " +
  "and a map change takes longer than Reveille waits.";

/**
 * One server answer as a console line.
 *
 * `tone` is `output`, `notice` or `error`. `password` says what the answer proves about the
 * password that was sent — `accepted`, `rejected` or `unknown` — so the console keeps one that
 * worked and drops one that did not, and never decides from a silence.
 */
export function describeOutcome(outcome) {
  switch (outcome?.status) {
    case "reply":
      return describeReply(outcome);
    case "refused":
      return { tone: "error", text: sentence(outcome.reason), password: "unknown" };
    case "no_answer":
      return { tone: "notice", text: NO_ANSWER, password: "unknown" };
    case "failed":
      return {
        tone: "error",
        text: `The network failed: ${String(outcome.detail ?? "").trim() || "no detail given"}.`,
        password: "unknown",
      };
    default:
      return { tone: "error", text: "Reveille got an answer it does not understand.", password: "unknown" };
  }
}

function describeReply(reply) {
  if (reply.verdict === "wrong_password") {
    return { tone: "error", text: "The server refused the password.", password: "rejected" };
  }
  if (reply.verdict === "password_not_set") {
    return {
      tone: "error",
      text: "This server has no rcon password, so it accepts no remote commands.",
      password: "rejected",
    };
  }
  const output = String(reply.output ?? "").replace(/\s+$/u, "");
  const cut = reply.truncated ? "\n… The server printed more than Reveille shows." : "";
  return output
    ? { tone: "output", text: output + cut, password: "accepted" }
    : { tone: "notice", text: `(no output)${cut}`, password: "accepted" };
}

const NOTES = {
  saved: "Password saved in the system credential store.",
  not_saved: "The command worked, but the system credential store would not keep the password.",
  forgotten: "The saved password was refused by the server, so it was removed.",
};

/** What became of the saved password, as a console line; `null` when nothing changed. */
export function describePasswordNote(note) {
  return NOTES[note] ?? null;
}

/** The map a console command may name: what the server's own file listing can produce. */
export function isSafeMapName(name) {
  return /^[A-Za-z0-9_\-./]{1,63}$/u.test(name) && !name.split("/").some((part) => part === "" || part === "." || part === "..");
}

/** How one client appears in the player list. */
export function playerLabel(player) {
  const state = player.state === "connecting" ? " · connecting" : player.state === "zombie" ? " · dropping" : "";
  const ping = player.ping === null || player.ping === undefined ? "" : ` · ${player.ping} ms`;
  return `#${player.slot} ${player.name || "(no name)"}${ping}${state}`;
}

/** A reason from the Rust side, which is lower-case and unpunctuated, read as a sentence. */
function sentence(reason) {
  const text = String(reason ?? "").trim();
  if (!text) return "Reveille could not send that.";
  const capital = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/u.test(capital) ? capital : `${capital}.`;
}
