// SPDX-License-Identifier: GPL-3.0-only

//! Reading what `status` and `fdir` print through the remote console.
//!
//! Both are console output meant for a person, not a protocol, so everything here is lenient about
//! what it skips and strict about what it returns: a line that does not parse is dropped rather
//! than guessed at, and a returned map name is always one that is safe to put in a command.

use std::net::SocketAddr;

use serde::Serialize;

/// Where a client is in connecting, as `status` prints it in the ping column.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RconPlayerState {
    /// In the game, with a ping.
    Playing,
    /// Printed as `CNCT`: still loading.
    Connecting,
    /// Printed as `ZMBI`: dropped but not yet cleared.
    Zombie,
}

/// One client line of `status`.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RconPlayer {
    /// The client number `clientkick` and `banaddr` take.
    pub slot: u32,
    /// Kills, which is all the score column holds in MOHAA.
    pub score: i32,
    /// Round trip in milliseconds, absent while connecting.
    pub ping: Option<u32>,
    /// Whether the client is playing, loading or a leftover.
    pub state: RconPlayerState,
    /// The name with control characters removed. Empty when the player has none.
    pub name: String,
    /// The address as the server printed it, `ip:port`, or `bot` and `loopback` for local ones.
    pub address: String,
    /// The address is a network address `banaddr` can ban. Bots and the local host are not.
    pub bannable: bool,
}

/// The clients in `status` output.
///
/// The columns are `num score ping name lastmsg address qport rate`. openmohaa
/// `code/server/sv_ccmds.c:1217-1380` pads each to a width that grows with the longest address, so
/// positions cannot be trusted. A name is free text with spaces, so the three numbers are read from
/// the left and the four fields after the name from the right, and what is left is the name.
#[must_use]
pub fn parse_status_players(output: &str) -> Vec<RconPlayer> {
    let mut lines = output.lines();
    let in_table = lines
        .by_ref()
        .skip_while(|line| !is_rule(line))
        .skip(1)
        .take_while(|line| !line.trim().is_empty());
    in_table.filter_map(parse_player_line).collect()
}

/// The `-- ---- ----` line under the header: dashes and spaces only, with at least two groups.
fn is_rule(line: &str) -> bool {
    let line = line.trim();
    line.contains(' ') && line.chars().all(|character| matches!(character, '-' | ' '))
}

fn parse_player_line(line: &str) -> Option<RconPlayer> {
    let (slot, rest) = take_token(line)?;
    let (score, rest) = take_token(rest)?;
    let (ping, rest) = take_token(rest)?;
    let slot = slot.parse::<u32>().ok()?;
    let score = score.parse::<i32>().ok()?;
    let (ping, state) = match ping {
        "CNCT" => (None, RconPlayerState::Connecting),
        "ZMBI" => (None, RconPlayerState::Zombie),
        number => (Some(number.parse::<u32>().ok()?), RconPlayerState::Playing),
    };

    let (rest, _rate) = pop_token(rest)?;
    let (rest, _qport) = pop_token(rest)?;
    let (rest, address) = pop_token(rest)?;
    let (name, lastmsg) = pop_token(rest)?;
    lastmsg.parse::<u32>().ok()?;
    Some(RconPlayer {
        slot,
        score,
        ping,
        state,
        name: clean_name(name),
        address: address.to_owned(),
        bannable: address.parse::<SocketAddr>().is_ok(),
    })
}

fn take_token(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_start();
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    (end > 0).then(|| (&text[..end], &text[end..]))
}

/// The last whitespace-separated token and what precedes it.
fn pop_token(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_end();
    let start = text.rfind(char::is_whitespace).map_or(0, |at| {
        at + text[at..].chars().next().map_or(1, char::len_utf8)
    });
    let token = &text[start..];
    (!token.is_empty()).then(|| (&text[..start], token))
}

fn clean_name(raw: &str) -> String {
    raw.chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .trim()
        .to_owned()
}

/// A name that is one token of letters, digits and `_-./`, with no empty or relative segment.
#[must_use]
pub fn is_safe_map_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/')
        })
        && name
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
}

#[cfg(test)]
mod tests {
    use super::{RconPlayerState, is_safe_map_name, parse_status_players};

    // Shaped like openmohaa's own output: right-aligned numbers, a name padded to 15, an address
    // column as wide as the longest address.
    const STATUS: &str = "\
map: dm/mohdm1
num score ping name            lastmsg address               qport rate
--- ----- ---- --------------- ------- --------------------- ----- -----
  0     7   42 Goat                  0 198.51.100.7:12203    53211 25000
  1    -2   61 Raven                 3 203.0.113.9:12203     41022 25000
  2     0 CNCT Newcomer             12 192.0.2.44:12203      1337 25000

";

    #[test]
    fn reads_every_client_with_its_slot_and_numbers() {
        let players = parse_status_players(STATUS);

        assert_eq!(players.len(), 3);
        assert_eq!(players[0].slot, 0);
        assert_eq!(players[0].name, "Goat");
        assert_eq!(players[0].score, 7);
        assert_eq!(players[0].ping, Some(42));
        assert_eq!(players[0].address, "198.51.100.7:12203");
        assert_eq!(players[1].score, -2, "a score can be negative");
        assert_eq!(players[1].slot, 1);
    }

    #[test]
    fn a_client_still_loading_has_no_ping_and_says_so() {
        let players = parse_status_players(STATUS);

        assert_eq!(players[2].state, RconPlayerState::Connecting);
        assert_eq!(players[2].ping, None);
        assert_eq!(players[0].state, RconPlayerState::Playing);
    }

    #[test]
    fn a_name_with_spaces_and_numbers_is_kept_whole() {
        let status = "\
num score ping name            lastmsg address               qport rate
--- ----- ---- --------------- ------- --------------------- ----- -----
  4    11   30 =|LuV|= Bob 5         0 198.51.100.7:12203    53211 25000
";

        let players = parse_status_players(status);

        assert_eq!(players.len(), 1);
        assert_eq!(players[0].name, "=|LuV|= Bob 5");
        assert_eq!(players[0].slot, 4);
    }

    #[test]
    fn a_name_longer_than_its_column_still_parses() {
        let status = "\
num score ping name            lastmsg address               qport rate
--- ----- ---- --------------- ------- --------------------- ----- -----
  9     1   20 A name much longer than fifteen characters 0 198.51.100.7:12203 5 25000
";

        let players = parse_status_players(status);

        assert_eq!(
            players[0].name,
            "A name much longer than fifteen characters"
        );
        assert_eq!(players[0].address, "198.51.100.7:12203");
    }

    #[test]
    fn bots_and_the_local_host_are_not_bannable_but_real_addresses_are() {
        let status = "\
num score ping name            lastmsg address               qport rate
--- ----- ---- --------------- ------- --------------------- ----- -----
  0     0   10 Host                  0 loopback                 0 25000
  1     0    0 Bot Karl              0 bot                      0 25000
  2     0   50 Real                  0 198.51.100.7:12203    53211 25000
  3     0   50 Six                   0 [2001:db8::1]:12203   53212 25000
";

        let players = parse_status_players(status);

        let bannable: Vec<bool> = players.iter().map(|player| player.bannable).collect();
        assert_eq!(bannable, [false, false, true, true]);
    }

    #[test]
    fn control_characters_never_reach_a_name() {
        let status = "\
num score ping name            lastmsg address               qport rate
--- ----- ---- --------------- ------- --------------------- ----- -----
  0     0   50 Ev\u{1b}il\u{7}                0 198.51.100.7:12203    53211 25000
";

        assert_eq!(parse_status_players(status)[0].name, "Evil");
    }

    #[test]
    fn a_server_that_is_not_running_or_a_refusal_lists_nobody() {
        for output in [
            "Server is not running.\n",
            "Bad rconpassword.\n",
            "",
            "map: dm/mohdm1\nnum score ping name lastmsg address qport rate\n--- ----- ---- ---- ------- ------- ----- ----\n\n",
        ] {
            assert!(parse_status_players(output).is_empty(), "{output:?}");
        }
    }

    #[test]
    fn a_malformed_line_is_skipped_and_the_rest_still_read() {
        let status = "\
num score ping name            lastmsg address               qport rate
--- ----- ---- --------------- ------- --------------------- ----- -----
  0     7   42 Goat                  0 198.51.100.7:12203    53211 25000
this is not a client line
  2     1   50 Fine                  0 198.51.100.8:12203    53212 25000
";

        let players = parse_status_players(status);

        assert_eq!(players.iter().map(|p| p.slot).collect::<Vec<_>>(), [0, 2]);
    }

    #[test]
    fn a_name_is_safe_only_as_one_plain_token() {
        for good in ["dm/mohdm1", "obj_team1", "lib/stalingrad-v2.1"] {
            assert!(is_safe_map_name(good), "{good}");
        }
        for bad in [
            "", "a b", "a;b", "../x", "dm//x", "/dm/x", "dm/", "dm/x\n", "dm/ü",
        ] {
            assert!(!is_safe_map_name(bad), "{bad:?}");
        }
        assert!(!is_safe_map_name(&"a".repeat(64)));
    }
}
