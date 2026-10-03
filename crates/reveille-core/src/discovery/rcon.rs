// SPDX-License-Identifier: GPL-3.0-only

//! Remote console (`rcon`) over MOHAA's connectionless packets.
//!
//! The request is `rcon <password> <command>` behind the five-byte client header. The server
//! runs the command with its console output redirected into `print` packets and sends them back
//! to the sender's address, so the exchange needs no connection and no join.

use std::fmt;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use serde::Serialize;
use thiserror::Error;
use tokio::net::UdpSocket;
use tokio::time::timeout;

use super::model::{GamePort, RoundTripMillis};
use super::protocol::{OOB_RECV_HEADER, OOB_SEND_HEADER, latin1};

// openmohaa `code/client/cl_main.cpp:1491` sizes the whole request at 1024 bytes. The five header
// bytes and the terminator come out of that, and `Q_strcat` refuses anything that would not fit.
const MAX_RCON_PAYLOAD: usize = 1024 - OOB_SEND_HEADER.len() - 1;
// A reply is never trusted to be small: openmohaa `code/server/sv_main.c:680` flushes every
// 8176 bytes, so a long listing arrives as several packets.
const MAX_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_UDP_PACKET: usize = 65_535;
// openmohaa `code/server/sv_main.c:713` and `:715`, the only two refusals the server prints.
const NO_PASSWORD_SET: &str = "No rconpassword set on the server.";
const WRONG_PASSWORD: &str = "Bad rconpassword.";

/// A password the engine can actually match.
///
/// The server compares `Cmd_Argv(1)` of a line it has already rewritten, so characters the
/// tokenizer or the line reader treats specially can never match. Refusing them here is kinder
/// than sending a request that is guaranteed to read as "wrong password". The value never
/// appears in `Debug` output or in an error.
#[derive(Clone, Eq, PartialEq)]
pub struct RconPassword(Vec<u8>);

impl RconPassword {
    /// Validate a password typed by a person.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty password, for spaces, quotes, percent signs or control
    /// characters, and for characters outside Latin-1.
    pub fn new(value: &str) -> Result<Self, RconInputError> {
        if value.is_empty() {
            return Err(RconInputError::EmptyPassword);
        }
        // openmohaa `code/qcommon/msg.cpp:860` rewrites '%' to '.' before the server tokenizes
        // the line, and `code/server/sv_main.c:727` ends the password at the first space.
        if value.chars().any(|character| {
            character.is_whitespace() || character.is_control() || matches!(character, '"' | '%')
        }) {
            return Err(RconInputError::UnusablePasswordCharacter);
        }
        Ok(Self(encode_latin1(value)?))
    }
}

impl fmt::Debug for RconPassword {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RconPassword(<redacted>)")
    }
}

/// One console command, checked so that it survives the trip as a single line.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RconCommand(Vec<u8>);

impl RconCommand {
    /// Validate a command typed by a person. Surrounding whitespace is dropped.
    ///
    /// A `%` is accepted but arrives as `.`: openmohaa `code/qcommon/msg.cpp:860` rewrites it
    /// while reading the line, so there is no way to send one.
    ///
    /// # Errors
    ///
    /// Returns an error for an empty command, for line breaks and other control characters
    /// (the server stops reading at the first one), and for characters outside Latin-1.
    pub fn new(value: &str) -> Result<Self, RconInputError> {
        let value = value.trim();
        if value.is_empty() {
            return Err(RconInputError::EmptyCommand);
        }
        if value.chars().any(char::is_control) {
            return Err(RconInputError::ControlCharacterInCommand);
        }
        Ok(Self(encode_latin1(value)?))
    }
}

/// Input that could never be sent, caught before any packet leaves.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum RconInputError {
    /// No password was given.
    #[error("the rcon password is empty")]
    EmptyPassword,
    /// The password holds a character the engine cannot match.
    #[error("an rcon password cannot contain spaces, quotes, percent signs or control characters")]
    UnusablePasswordCharacter,
    /// No command was given.
    #[error("the command is empty")]
    EmptyCommand,
    /// The command holds a line break or another control character.
    #[error("a command must be a single line without control characters")]
    ControlCharacterInCommand,
    /// The game reads text as Latin-1 and this character has no byte in it.
    #[error("the game cannot receive characters outside Latin-1")]
    UnencodableCharacter,
    /// Password and command together do not fit one request.
    #[error(
        "password and command are {actual} bytes together; one request holds at most {MAX_RCON_PAYLOAD}"
    )]
    TooLong {
        /// Bytes after the header, `rcon ` and the separating space included.
        actual: usize,
    },
}

/// Failure of one remote-console exchange.
#[derive(Debug, Error)]
pub enum RconError {
    /// The input could not be sent.
    #[error(transparent)]
    Input(#[from] RconInputError),
    /// The server did not answer before the deadline. The command may still have run.
    #[error("the server did not answer in time")]
    Timeout,
    /// Socket I/O failed.
    #[error("network request failed")]
    Network(#[source] io::Error),
}

/// How long to wait for the server.
#[derive(Clone, Copy, Debug)]
pub struct RconTiming {
    /// Wait for the first reply packet. A server runs the command before it answers, so a map
    /// change makes the reply late rather than lost.
    pub first_reply: Duration,
    /// Wait for a further packet once one has arrived. A long reply is sent back to back, so
    /// this only has to cover the gap between packets.
    pub settle: Duration,
}

impl Default for RconTiming {
    fn default() -> Self {
        Self {
            first_reply: Duration::from_secs(5),
            settle: Duration::from_millis(250),
        }
    }
}

/// What the server's own words say happened to the request.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RconVerdict {
    /// The server ran the command. Its output, possibly empty, is in the reply.
    Executed,
    /// The server has an rcon password and this was not it.
    WrongPassword,
    /// The server has no rcon password, so it accepts no remote commands at all.
    PasswordNotSet,
}

/// The server's answer to one command.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct RconReply {
    /// Console output with the `print` framing removed.
    pub output: String,
    /// Read from the first line the server printed, not from any status field: the protocol has
    /// none, and a command whose output happens to equal a refusal would be misread.
    pub verdict: RconVerdict,
    /// Reply packets received.
    pub packets: u32,
    /// Output was cut at a defensive size bound.
    pub truncated: bool,
    /// Send to first reply, which includes the time the command itself took.
    pub round_trip: RoundTripMillis,
}

/// Run one command on a server and collect what it prints.
///
/// `port` is the game port, the same one `getstatus` is sent to, not the `GameSpy` query port.
///
/// # Errors
///
/// Returns an error when the input cannot be encoded, when no reply arrives in time, or when the
/// socket fails. A wrong password is a reply, not an error: see [`RconVerdict`].
pub async fn send_rcon(
    address: Ipv4Addr,
    port: GamePort,
    password: &RconPassword,
    command: &RconCommand,
    timing: RconTiming,
) -> Result<RconReply, RconError> {
    let request = encode_request(password, command)?;
    let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
        .await
        .map_err(RconError::Network)?;
    socket
        .connect(SocketAddr::V4(SocketAddrV4::new(address, port.get())))
        .await
        .map_err(RconError::Network)?;

    let sent_at = Instant::now();
    timeout(timing.first_reply, socket.send(&request))
        .await
        .map_err(|_| RconError::Timeout)?
        .map_err(RconError::Network)?;

    let mut buffer = vec![0_u8; MAX_UDP_PACKET];
    let mut collected = Collected::default();
    loop {
        let wait = if collected.packets == 0 {
            timing.first_reply.saturating_sub(sent_at.elapsed())
        } else {
            timing.settle
        };
        let Ok(received) = timeout(wait, socket.recv(&mut buffer)).await else {
            if collected.packets == 0 {
                return Err(RconError::Timeout);
            }
            break;
        };
        let length = received.map_err(RconError::Network)?;
        // The socket is connected, so only the server's own address reaches this point; anything
        // that is not a `print` packet is skipped rather than ending the exchange.
        let Some(text) = parse_print_packet(&buffer[..length]) else {
            continue;
        };
        if collected.packets == 0 {
            collected.round_trip = Some(round_trip_millis(sent_at.elapsed()));
        }
        collected.push(&text);
        if collected.truncated {
            break;
        }
    }
    Ok(collected.into_reply())
}

#[derive(Default)]
struct Collected {
    output: String,
    first_text: Option<String>,
    packets: u32,
    truncated: bool,
    round_trip: Option<RoundTripMillis>,
}

impl Collected {
    fn push(&mut self, text: &str) {
        self.packets = self.packets.saturating_add(1);
        if self.first_text.is_none() {
            self.first_text = Some(text.to_owned());
        }
        let room = MAX_OUTPUT_BYTES.saturating_sub(self.output.len());
        // Decoded Latin-1 is one or two bytes per char, so measure in chars and cut on a boundary.
        let mut taken = 0;
        for character in text.chars() {
            if taken + character.len_utf8() > room {
                self.truncated = true;
                break;
            }
            taken += character.len_utf8();
        }
        self.output.push_str(&text[..taken]);
    }

    fn into_reply(self) -> RconReply {
        let verdict = self
            .first_text
            .as_deref()
            .map_or(RconVerdict::Executed, verdict_of);
        RconReply {
            output: self.output,
            verdict,
            packets: self.packets,
            truncated: self.truncated,
            round_trip: self.round_trip.unwrap_or(RoundTripMillis::new(0)),
        }
    }
}

fn verdict_of(first_text: &str) -> RconVerdict {
    match first_text.trim() {
        WRONG_PASSWORD => RconVerdict::WrongPassword,
        NO_PASSWORD_SET => RconVerdict::PasswordNotSet,
        _ => RconVerdict::Executed,
    }
}

/// The request exactly as `CL_Rcon_f` builds it: header, `rcon <password> <command>`, and the
/// terminating NUL it counts in the length it sends (openmohaa
/// `code/client/cl_main.cpp:1518-1542`).
fn encode_request(
    password: &RconPassword,
    command: &RconCommand,
) -> Result<Vec<u8>, RconInputError> {
    let mut payload = Vec::with_capacity(5 + password.0.len() + 1 + command.0.len());
    payload.extend_from_slice(b"rcon ");
    payload.extend_from_slice(&password.0);
    payload.push(b' ');
    payload.extend_from_slice(&command.0);
    if payload.len() > MAX_RCON_PAYLOAD {
        return Err(RconInputError::TooLong {
            actual: payload.len(),
        });
    }
    let mut packet = Vec::from(OOB_SEND_HEADER);
    packet.extend_from_slice(&payload);
    packet.push(0);
    Ok(packet)
}

/// The text of one `print` packet, or `None` for any other packet.
///
/// The server frames redirected output as `print\n<text>` behind the five-byte server header
/// (openmohaa `code/server/sv_main.c:663`).
fn parse_print_packet(packet: &[u8]) -> Option<String> {
    let body = packet.strip_prefix(&OOB_RECV_HEADER)?;
    let newline = body.iter().position(|byte| *byte == b'\n')?;
    if body[..newline].trim_ascii_end() != b"print" {
        return None;
    }
    let text = &body[newline + 1..];
    let end = text
        .iter()
        .rposition(|byte| *byte != 0)
        .map_or(0, |last| last + 1);
    Some(latin1(&text[..end]))
}

fn encode_latin1(value: &str) -> Result<Vec<u8>, RconInputError> {
    value
        .chars()
        .map(|character| {
            u8::try_from(u32::from(character)).map_err(|_| RconInputError::UnencodableCharacter)
        })
        .collect()
}

fn round_trip_millis(elapsed: Duration) -> RoundTripMillis {
    RoundTripMillis::new(u32::try_from(elapsed.as_millis()).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::time::Duration;

    use tokio::net::UdpSocket;

    use super::{
        MAX_RCON_PAYLOAD, RconCommand, RconError, RconInputError, RconPassword, RconTiming,
        RconVerdict, encode_request, parse_print_packet, send_rcon, verdict_of,
    };
    use crate::discovery::GamePort;

    fn password(value: &str) -> RconPassword {
        RconPassword::new(value).expect("test password is valid")
    }

    fn command(value: &str) -> RconCommand {
        RconCommand::new(value).expect("test command is valid")
    }

    fn print_packet(text: &str) -> Vec<u8> {
        let mut packet = vec![0xff, 0xff, 0xff, 0xff, 0x01];
        packet.extend_from_slice(b"print\n");
        packet.extend_from_slice(text.as_bytes());
        packet
    }

    const FAST: RconTiming = RconTiming {
        first_reply: Duration::from_millis(400),
        settle: Duration::from_millis(60),
    };

    #[test]
    fn the_request_matches_the_engine_client_byte_for_byte() {
        let request = encode_request(&password("hunter2"), &command("map dm/mohdm1")).unwrap();

        let mut expected = vec![0xff, 0xff, 0xff, 0xff, 0x02];
        expected.extend_from_slice(b"rcon hunter2 map dm/mohdm1");
        expected.push(0);
        assert_eq!(request, expected);
    }

    #[test]
    fn a_command_is_trimmed_but_keeps_its_inner_spacing() {
        let request = encode_request(&password("pw"), &command("  say  hello  ")).unwrap();

        assert!(request.ends_with(b"rcon pw say  hello\0"));
    }

    #[test]
    fn passwords_the_engine_could_never_match_are_refused_before_sending() {
        assert_eq!(
            RconPassword::new("").unwrap_err(),
            RconInputError::EmptyPassword
        );
        for bad in ["two words", "quo\"te", "50%off", "tab\there", "line\nbreak"] {
            assert_eq!(
                RconPassword::new(bad).unwrap_err(),
                RconInputError::UnusablePasswordCharacter,
                "{bad:?}"
            );
        }
        assert_eq!(
            RconPassword::new("pässword-€").unwrap_err(),
            RconInputError::UnencodableCharacter
        );
    }

    #[test]
    fn a_latin1_password_is_sent_as_single_bytes() {
        let request = encode_request(&password("pässword"), &command("status")).unwrap();

        assert!(request.windows(9).any(|window| window == b"p\xe4ssword "));
    }

    #[test]
    fn commands_that_would_stop_the_server_reading_early_are_refused() {
        assert_eq!(
            RconCommand::new("   ").unwrap_err(),
            RconInputError::EmptyCommand
        );
        assert_eq!(
            RconCommand::new("say a\nquit").unwrap_err(),
            RconInputError::ControlCharacterInCommand
        );
        assert_eq!(
            RconCommand::new("say ✓").unwrap_err(),
            RconInputError::UnencodableCharacter
        );
    }

    #[test]
    fn a_request_that_overflows_the_engine_buffer_is_refused_with_its_size() {
        let long = "x".repeat(MAX_RCON_PAYLOAD);

        let error = encode_request(&password("pw"), &command(&long)).unwrap_err();

        assert_eq!(
            error,
            RconInputError::TooLong {
                actual: "rcon pw ".len() + MAX_RCON_PAYLOAD
            }
        );
        let fits = "x".repeat(MAX_RCON_PAYLOAD - "rcon pw ".len());
        assert!(encode_request(&password("pw"), &command(&fits)).is_ok());
    }

    #[test]
    fn the_password_never_appears_in_debug_output() {
        let shown = format!("{:?}", password("hunter2"));

        assert!(!shown.contains("hunter2"));
    }

    #[test]
    fn print_packets_lose_their_framing_and_other_packets_are_ignored() {
        assert_eq!(
            parse_print_packet(&print_packet("hi\n")).as_deref(),
            Some("hi\n")
        );
        assert_eq!(parse_print_packet(&print_packet("")).as_deref(), Some(""));
        let mut padded = print_packet("tail");
        padded.push(0);
        assert_eq!(parse_print_packet(&padded).as_deref(), Some("tail"));

        let mut other = vec![0xff, 0xff, 0xff, 0xff, 0x01];
        other.extend_from_slice(b"statusResponse\n\\a\\b");
        assert_eq!(parse_print_packet(&other), None);
        assert_eq!(
            parse_print_packet(b"\xff\xff\xff\xffprint\nno direction byte"),
            None
        );
        assert_eq!(parse_print_packet(b"\xff\xff\xff\xff\x01print"), None);
    }

    #[test]
    fn the_servers_two_refusals_are_told_apart_from_a_command_that_ran() {
        assert_eq!(
            verdict_of("Bad rconpassword.\n"),
            RconVerdict::WrongPassword
        );
        assert_eq!(
            verdict_of("No rconpassword set on the server.\n"),
            RconVerdict::PasswordNotSet
        );
        assert_eq!(
            verdict_of("Bad rconpassword. Really.\n"),
            RconVerdict::Executed
        );
        assert_eq!(verdict_of(""), RconVerdict::Executed);
    }

    /// A one-shot server on loopback: checks the request, then answers with `replies`.
    async fn serve(expected: Vec<u8>, replies: Vec<Vec<u8>>) -> GamePort {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = GamePort::new(socket.local_addr().unwrap().port());
        tokio::spawn(async move {
            let mut buffer = vec![0_u8; 2048];
            let (length, from) = socket.recv_from(&mut buffer).await.unwrap();
            assert_eq!(&buffer[..length], expected.as_slice());
            for reply in replies {
                socket.send_to(&reply, from).await.unwrap();
            }
        });
        port
    }

    #[tokio::test]
    async fn a_reply_split_over_several_packets_is_joined_in_order() {
        let request = encode_request(&password("pw"), &command("status")).unwrap();
        let port = serve(
            request,
            vec![print_packet("map: mohdm1\n"), print_packet("players: 0\n")],
        )
        .await;

        let reply = send_rcon(
            Ipv4Addr::LOCALHOST,
            port,
            &password("pw"),
            &command("status"),
            FAST,
        )
        .await
        .unwrap();

        assert_eq!(reply.output, "map: mohdm1\nplayers: 0\n");
        assert_eq!(reply.packets, 2);
        assert_eq!(reply.verdict, RconVerdict::Executed);
        assert!(!reply.truncated);
    }

    #[tokio::test]
    async fn an_empty_reply_is_a_command_that_ran_and_printed_nothing() {
        let request = encode_request(&password("pw"), &command("say hi")).unwrap();
        let port = serve(request, vec![print_packet("")]).await;

        let reply = send_rcon(
            Ipv4Addr::LOCALHOST,
            port,
            &password("pw"),
            &command("say hi"),
            FAST,
        )
        .await
        .unwrap();

        assert_eq!(reply.verdict, RconVerdict::Executed);
        assert_eq!(reply.output, "");
        assert_eq!(reply.packets, 1);
    }

    #[tokio::test]
    async fn a_wrong_password_is_a_reply_not_an_error() {
        let request = encode_request(&password("nope"), &command("status")).unwrap();
        let port = serve(request, vec![print_packet("Bad rconpassword.\n")]).await;

        let reply = send_rcon(
            Ipv4Addr::LOCALHOST,
            port,
            &password("nope"),
            &command("status"),
            FAST,
        )
        .await
        .unwrap();

        assert_eq!(reply.verdict, RconVerdict::WrongPassword);
    }

    #[tokio::test]
    async fn output_beyond_the_defensive_bound_is_cut_and_flagged() {
        let request = encode_request(&password("pw"), &command("cvarlist")).unwrap();
        let chunk = "a".repeat(40 * 1024);
        let port = serve(request, vec![print_packet(&chunk), print_packet(&chunk)]).await;

        let reply = send_rcon(
            Ipv4Addr::LOCALHOST,
            port,
            &password("pw"),
            &command("cvarlist"),
            FAST,
        )
        .await
        .unwrap();

        assert!(reply.truncated);
        assert_eq!(reply.output.len(), 64 * 1024);
    }

    #[tokio::test]
    async fn silence_is_a_timeout() {
        let silent = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = GamePort::new(silent.local_addr().unwrap().port());

        let error = send_rcon(
            Ipv4Addr::LOCALHOST,
            port,
            &password("pw"),
            &command("status"),
            FAST,
        )
        .await
        .unwrap_err();

        assert!(matches!(error, RconError::Timeout), "{error:?}");
    }

    #[tokio::test]
    async fn an_unsendable_command_never_opens_a_socket() {
        let long = "x".repeat(MAX_RCON_PAYLOAD);

        let error = send_rcon(
            Ipv4Addr::LOCALHOST,
            GamePort::new(1),
            &password("pw"),
            &command(&long),
            FAST,
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error, RconError::Input(RconInputError::TooLong { .. })),
            "{error:?}"
        );
    }
}
