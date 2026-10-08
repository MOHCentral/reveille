// SPDX-License-Identifier: GPL-3.0-only

//! What a server prints back: the `print` packets, `status`, and a cvar's value.

use thiserror::Error;

use super::command::ClientSlot;
use crate::discovery::OOB_RECV_HEADER;

// `SV_FlushRedirect` sends each buffer of console output as `print\n<text>` (`sv_main.c:662`).
const PRINT: &[u8] = b"print\n";
// `sv_main.c:713-715`.
const BAD_PASSWORD: &str = "Bad rconpassword.";
const NO_PASSWORD: &str = "No rconpassword set on the server.";

/// A reply that is not console output, or console output refusing the request.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ReplyError {
    /// The packet does not start with the connectionless marker.
    #[error("reply is not a connectionless packet")]
    InvalidHeader,
    /// A connectionless packet that is not `print`.
    #[error("reply is not console output")]
    NotPrint,
    /// The server rejected the password.
    #[error("the server did not accept this RCON password")]
    BadPassword,
    /// The server has no RCON password, so it accepts no remote commands.
    #[error("this server has no RCON password set, so it accepts no remote commands")]
    NotEnabled,
}

/// The console text one `print` packet carries.
///
/// Decoded as Latin-1, the game's own single-byte text, so a player name never fails to decode.
///
/// # Errors
///
/// Returns [`ReplyError::InvalidHeader`] or [`ReplyError::NotPrint`] for any other packet.
pub fn parse_print_packet(packet: &[u8]) -> Result<String, ReplyError> {
    let body = packet
        .strip_prefix(&OOB_RECV_HEADER[..4])
        .ok_or(ReplyError::InvalidHeader)?;
    // The direction byte is MOHAA's (`net_chan.c:797`); a server that leaves it out is still read.
    let body = body.strip_prefix(&OOB_RECV_HEADER[4..]).unwrap_or(body);
    let text = body.strip_prefix(PRINT).ok_or(ReplyError::NotPrint)?;
    Ok(text.iter().copied().map(char::from).collect())
}

/// Whether the server ran the command or refused the request.
///
/// # Errors
///
/// Returns [`ReplyError::BadPassword`] or [`ReplyError::NotEnabled`] when the server says so.
pub fn reply_outcome(text: &str) -> Result<(), ReplyError> {
    let first = text.lines().next().unwrap_or_default().trim();
    if first == BAD_PASSWORD {
        Err(ReplyError::BadPassword)
    } else if first == NO_PASSWORD {
        Err(ReplyError::NotEnabled)
    } else {
        Ok(())
    }
}

/// One client in a `status` reply.
#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
pub struct RconPlayer {
    /// The number every per-client command takes.
    pub slot: ClientSlot,
    /// The score column. `OpenMoHAA` fills it with kills (`sv_ccmds.c:1336`).
    pub score: i32,
    /// Ping in milliseconds, or none while the client is still connecting.
    pub ping: Option<u32>,
    /// Name with control characters removed.
    pub name: String,
}

/// A parsed `status` reply.
#[derive(Clone, Debug, Default, Eq, PartialEq, serde::Serialize)]
pub struct RconStatus {
    /// The map loaded now.
    pub map: Option<String>,
    /// Connected clients in slot order.
    pub players: Vec<RconPlayer>,
}

/// Read `status` as `SV_Status_f` prints it (`sv_ccmds.c:1217`): a `map:` line, a header, a rule
/// of dashes, then one line per client.
///
/// A client line is `num score ping name lastmsg address qport rate`. The name may hold spaces,
/// so it is what lies between the first three columns and the last four. A line that does not
/// have that shape is skipped rather than guessed at.
#[must_use]
pub fn parse_status(text: &str) -> RconStatus {
    let mut status = RconStatus::default();
    let mut rows = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(map) = trimmed.strip_prefix("map:") {
            status.map = Some(map.trim().to_owned()).filter(|map| !map.is_empty());
        } else if trimmed.starts_with("---") {
            rows = true;
        } else if rows
            && !trimmed.is_empty()
            && let Some(player) = parse_status_row(line)
        {
            status.players.push(player);
        }
    }
    status
}

fn parse_status_row(line: &str) -> Option<RconPlayer> {
    let spans = token_spans(line);
    if spans.len() < 8 {
        return None;
    }
    let word = |index: usize| &line[spans[index].0..spans[index].1];
    let slot = ClientSlot::new(word(0).parse().ok()?);
    let score = word(1).parse().ok()?;
    // `CNCT` and `ZMBI` stand in for the ping of a client that is not fully in (`sv_ccmds.c:1339`).
    let ping = match word(2) {
        "CNCT" | "ZMBI" => None,
        value => Some(value.parse().ok()?),
    };
    let tail = spans.len() - 4;
    // lastmsg and qport are numbers; checking them keeps a name that ends in digits from being
    // read as columns.
    word(tail).parse::<u64>().ok()?;
    word(tail + 2).parse::<u64>().ok()?;
    let name: String = line[spans[3].0..spans[tail - 1].1]
        .chars()
        .filter(|character| !character.is_control())
        .collect();
    Some(RconPlayer {
        slot,
        score,
        ping,
        name: name.trim().to_owned(),
    })
}

fn token_spans(line: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut start = None;
    for (index, character) in line.char_indices() {
        match (character.is_whitespace(), start) {
            (true, Some(begin)) => {
                spans.push((begin, index));
                start = None;
            }
            (false, None) => start = Some(index),
            _ => {}
        }
    }
    if let Some(begin) = start {
        spans.push((begin, line.len()));
    }
    spans
}

/// Read a cvar's value from the line `Cvar_Print` writes: `"name" is:"value^7" …`
/// (`cvar.c:555`). The trailing `^7` is the colour reset the engine appends, not part of the value.
#[must_use]
pub fn parse_cvar(text: &str, name: &str) -> Option<String> {
    let marker = format!("\"{name}\" is:\"");
    text.lines().find_map(|line| {
        let start = line
            .to_ascii_lowercase()
            .find(&marker.to_ascii_lowercase())?
            + marker.len();
        let rest = line.get(start..)?;
        let value = &rest[..rest.find('"')?];
        Some(value.strip_suffix("^7").unwrap_or(value).to_owned())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(text: &str) -> Vec<u8> {
        let mut bytes = OOB_RECV_HEADER.to_vec();
        bytes.extend_from_slice(PRINT);
        bytes.extend_from_slice(text.as_bytes());
        bytes
    }

    #[test]
    fn print_packets_are_read_with_or_without_the_direction_byte() {
        assert_eq!(
            parse_print_packet(&packet("hello\n")).as_deref(),
            Ok("hello\n")
        );
        let mut bare = vec![0xff; 4];
        bare.extend_from_slice(b"print\nhi");
        assert_eq!(parse_print_packet(&bare).as_deref(), Ok("hi"));
        assert_eq!(
            parse_print_packet(b"print\nhi"),
            Err(ReplyError::InvalidHeader)
        );
        let mut other = OOB_RECV_HEADER.to_vec();
        other.extend_from_slice(b"statusResponse\n");
        assert_eq!(parse_print_packet(&other), Err(ReplyError::NotPrint));
    }

    #[test]
    fn latin1_names_survive_decoding() {
        let mut bytes = OOB_RECV_HEADER.to_vec();
        bytes.extend_from_slice(PRINT);
        bytes.extend_from_slice(&[b'J', 0xe9, b'r', 0xf4, b'm', b'e']);
        assert_eq!(parse_print_packet(&bytes).as_deref(), Ok("Jérôme"));
    }

    #[test]
    fn a_refused_password_is_told_apart_from_output() {
        assert_eq!(
            reply_outcome("Bad rconpassword.\n"),
            Err(ReplyError::BadPassword)
        );
        assert_eq!(
            reply_outcome("No rconpassword set on the server.\n"),
            Err(ReplyError::NotEnabled)
        );
        assert_eq!(reply_outcome("map: dm/mohdm6\n"), Ok(()));
        assert_eq!(reply_outcome(""), Ok(()));
    }

    #[test]
    fn status_rows_keep_names_with_spaces_and_connecting_clients() {
        let text = "map: dm/mohdm6\n\
num score ping name            lastmsg address               qport rate \n\
--- ----- ---- --------------- ------- --------------------- ----- ----- \n\
  0    41   55 =|LuV|=Hawk           0 203.0.113.4:12203     1234 25000\n\
  3     0 CNCT Unknown Soldier       50 203.0.113.9:12203    40123  5000\n\
  7    -2  173 {UK} Tommy 42          0 bot                       0 16384\n\
\n";
        let status = parse_status(text);
        assert_eq!(status.map.as_deref(), Some("dm/mohdm6"));
        assert_eq!(
            status.players,
            vec![
                RconPlayer {
                    slot: ClientSlot::new(0),
                    score: 41,
                    ping: Some(55),
                    name: "=|LuV|=Hawk".to_owned()
                },
                RconPlayer {
                    slot: ClientSlot::new(3),
                    score: 0,
                    ping: None,
                    name: "Unknown Soldier".to_owned()
                },
                RconPlayer {
                    slot: ClientSlot::new(7),
                    score: -2,
                    ping: Some(173),
                    name: "{UK} Tommy 42".to_owned()
                },
            ]
        );
    }

    #[test]
    fn status_without_clients_or_with_noise_is_empty_not_wrong() {
        let empty = parse_status("map: obj/obj_team2\nnum score ping name\n--- -----\n\n");
        assert_eq!(empty.map.as_deref(), Some("obj/obj_team2"));
        assert!(empty.players.is_empty());
        assert_eq!(
            parse_status("Server is not running.\n"),
            RconStatus::default()
        );
        let torn = parse_status("map: x\n---\n  0 41 55 cut off\n");
        assert!(torn.players.is_empty());
    }

    #[test]
    fn cvar_values_drop_the_colour_reset() {
        let text = "\"sv_maplist\" is:\"dm/mohdm6 dm/mohdm2^7\" default:\"^7\"\n";
        assert_eq!(
            parse_cvar(text, "sv_maplist").as_deref(),
            Some("dm/mohdm6 dm/mohdm2")
        );
        assert_eq!(
            parse_cvar("\"g_gametype\" is:\"1^7\", the default\n", "g_gametype").as_deref(),
            Some("1")
        );
        assert_eq!(parse_cvar("Cvar nope does not exist.\n", "nope"), None);
    }

    proptest::proptest! {
        #[test]
        fn any_packet_parses_or_is_refused_without_panicking(bytes in proptest::collection::vec(proptest::num::u8::ANY, 0..2048)) {
            let _ = parse_print_packet(&bytes);
        }

        #[test]
        fn any_text_reads_as_some_status(text in "\\PC{0,2048}") {
            let status = parse_status(&text);
            for player in status.players {
                proptest::prop_assert!(!player.name.chars().any(char::is_control));
            }
            let _ = parse_cvar(&text, "sv_maplist");
            let _ = reply_outcome(&text);
        }
    }
}
