// SPDX-License-Identifier: GPL-3.0-only

//! Hermetic encoding and parsing for `GameSpy` v1 and MOHAA out-of-band packets.

use std::collections::BTreeMap;
use std::net::Ipv4Addr;

use thiserror::Error;

use super::model::{Deaths, Kills, MasterEndpoint, Player, PlayerPing, QueryPort, TargetGame};

/// Parsed backslash-delimited protocol fields.
pub type FieldMap = BTreeMap<String, String>;

/// A parsed MOHAA `getstatus` reply.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusResponse {
    /// Serverinfo fields.
    pub info: FieldMap,
    /// Player lines in the order the server sent them. This reply carries no kills or deaths.
    pub players: Vec<Player>,
}

// fake_client.py, verified against the engine's connectionless packet handling.
pub(crate) const OOB_SEND_HEADER: [u8; 5] = [0xff, 0xff, 0xff, 0xff, 0x02];
pub(crate) const OOB_RECV_HEADER: [u8; 5] = [0xff, 0xff, 0xff, 0xff, 0x01];

const MASTER_TERMINATOR: &[u8] = b"\\final\\";
const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Invalid input to the `GameSpy` encryption transform.
#[derive(Debug, Error)]
pub enum CryptoError {
    /// The RC4-variant key cannot be empty.
    #[error("GameSpy encryption key is empty")]
    EmptyKey,
}

/// A malformed master, `GameSpy`, or MOHAA reply.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ParseError {
    /// The master greeting did not carry the expected challenge field.
    #[error("master greeting has no secure challenge")]
    MissingChallenge,
    /// The master challenge did not have the six bytes expected by `GameSpy` v1.
    #[error("master challenge has length {actual}; expected 6")]
    InvalidChallengeLength {
        /// Actual challenge byte length.
        actual: usize,
    },
    /// A packed master reply had no final marker.
    #[error("master reply has no final marker")]
    MissingMasterTerminator,
    /// A packed master body was not made of six-byte records.
    #[error("master reply body has {length} bytes; expected a multiple of 6")]
    MisalignedMasterBody {
        /// Body byte length.
        length: usize,
    },
    /// A master record advertised UDP port zero.
    #[error("master reply contains query port zero")]
    ZeroQueryPort,
    /// Backslash-delimited key/value data ended after a key.
    #[error("backslash field {key:?} has no value")]
    MissingFieldValue {
        /// Key lacking a paired value.
        key: String,
    },
    /// A MOHAA reply did not use the five-byte server-to-client header.
    #[error("reply does not use the MOHAA five-byte server header")]
    InvalidOobHeader,
    /// A MOHAA reply had a different command marker.
    #[error("expected {expected} but received {actual:?}")]
    UnexpectedOobResponse {
        /// Expected response marker.
        expected: &'static str,
        /// Actual first payload line.
        actual: String,
    },
    /// A MOHAA reply omitted its serverinfo line.
    #[error("MOHAA reply has no serverinfo line")]
    MissingServerInfo,
}

/// Encrypt bytes with `GameSpy`'s stateful RC4 variant from `gutil.c:69`.
///
/// # Errors
///
/// Returns [`CryptoError::EmptyKey`] rather than panicking on an invalid key.
pub fn gs_encrypt(key: &[u8], input: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if key.is_empty() {
        return Err(CryptoError::EmptyKey);
    }

    let mut state = [0_u8; 256];
    for (value, slot) in (0_u8..=u8::MAX).zip(state.iter_mut()) {
        *slot = value;
    }

    let mut key_index = 0;
    let mut state_index = 0_u8;
    for counter in 0..256 {
        state_index = key[key_index]
            .wrapping_add(state[counter])
            .wrapping_add(state_index);
        key_index = (key_index + 1) % key.len();
        state.swap(counter, usize::from(state_index));
    }

    let mut output = input.to_vec();
    let mut x = 0_u8;
    let mut y = 0_u8;
    for byte in &mut output {
        x = x.wrapping_add(*byte).wrapping_add(1);
        y = state[usize::from(x)].wrapping_add(y);
        state.swap(usize::from(x), usize::from(y));
        let xor_index = state[usize::from(x)].wrapping_add(state[usize::from(y)]);
        *byte ^= state[usize::from(xor_index)];
    }
    Ok(output)
}

/// Encode `GameSpy` bytes as zero-padded base64 with no `=` characters (`gutil.c:48`).
#[must_use]
pub fn gs_encode(input: &[u8]) -> String {
    let mut encoded = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        let indices = [
            first >> 2,
            ((first & 0x03) << 4) | (second >> 4),
            ((second & 0x0f) << 2) | (third >> 6),
            third & 0x3f,
        ];
        for index in indices {
            encoded.push(char::from(BASE64_ALPHABET[usize::from(index)]));
        }
    }
    encoded
}

/// Extract the six-byte challenge from a `GameSpy` master greeting.
///
/// # Errors
///
/// Returns an error when `\\secure\\` is absent or its challenge is not six bytes.
pub fn parse_master_challenge(greeting: &[u8]) -> Result<Vec<u8>, ParseError> {
    let marker = b"\\secure\\";
    let start = find_bytes(greeting, marker)
        .map(|position| position + marker.len())
        .ok_or(ParseError::MissingChallenge)?;
    let remaining = &greeting[start..];
    let end = remaining
        .iter()
        .position(|byte| *byte == b'\\')
        .unwrap_or(remaining.len());
    if end != 6 {
        return Err(ParseError::InvalidChallengeLength { actual: end });
    }
    Ok(remaining[..end].to_vec())
}

/// Build the `GameSpy` v1 validation/list query for a target game.
///
/// # Errors
///
/// Returns an error only if the target's compile-time key is invalid.
pub fn build_master_query(target: TargetGame, challenge: &[u8]) -> Result<String, CryptoError> {
    let encrypted = gs_encrypt(target.secret_key(), challenge)?;
    let validation = gs_encode(&encrypted);
    let game_name = target.game_name();
    Ok(format!(
        "\\gamename\\{game_name}\\gamever\\1\\location\\0\\validate\\{validation}\\final\\\\queryid\\1.1\\list\\cmp\\gamename\\{game_name}\\final\\"
    ))
}

/// Parse a packed `GameSpy` master response into query endpoints.
///
/// # Errors
///
/// Returns an error for a missing terminator, a partial six-byte record, or port zero.
pub fn parse_master_response(response: &[u8]) -> Result<Vec<MasterEndpoint>, ParseError> {
    let end = find_bytes(response, MASTER_TERMINATOR).ok_or(ParseError::MissingMasterTerminator)?;
    let body = &response[..end];
    if !body.len().is_multiple_of(6) {
        return Err(ParseError::MisalignedMasterBody { length: body.len() });
    }

    // The length check above leaves no remainder, so `as_chunks` discards nothing.
    body.as_chunks::<6>()
        .0
        .iter()
        .map(|record| {
            let port = u16::from_be_bytes([record[4], record[5]]);
            if port == 0 {
                return Err(ParseError::ZeroQueryPort);
            }
            Ok(MasterEndpoint {
                address: Ipv4Addr::new(record[0], record[1], record[2], record[3]),
                query_port: QueryPort::new(port),
            })
        })
        .collect()
}

/// Parse a UDP `GameSpy` `\\status\\` reply.
///
/// # Errors
///
/// Returns an error when the backslash field sequence contains an unpaired key.
pub fn parse_gamespy_status(response: &[u8]) -> Result<FieldMap, ParseError> {
    parse_backslash_fields(response)
}

/// Read the player list carried in a `GameSpy` `\\status\\` reply's fields.
///
/// Indices follow the server's client slots and can have gaps, so every `player_N` key is read
/// rather than counting up from zero.
#[must_use]
pub fn gamespy_players(fields: &FieldMap) -> Vec<Player> {
    let mut indexed = fields
        .iter()
        .filter_map(|(key, name)| {
            let index = key.strip_prefix("player_")?.parse::<u32>().ok()?;
            Some((index, name))
        })
        .collect::<Vec<_>>();
    indexed.sort_unstable_by_key(|(index, _)| *index);
    // sv_gamespy.c:252 publishes player_N, frags_N (STAT_KILLS), deaths_N and ping_N.
    indexed
        .into_iter()
        .map(|(index, name)| Player {
            name: player_name(name),
            ping: indexed_field(fields, "ping", index).map(PlayerPing::new),
            kills: indexed_field(fields, "frags", index).map(Kills::new),
            deaths: indexed_field(fields, "deaths", index).map(Deaths::new),
        })
        .collect()
}

fn indexed_field<T: std::str::FromStr>(fields: &FieldMap, prefix: &str, index: u32) -> Option<T> {
    fields.get(&format!("{prefix}_{index}"))?.parse().ok()
}

/// Parse a five-byte MOHAA `getstatus` response.
///
/// # Errors
///
/// Returns an error for the wrong header/response marker or malformed serverinfo fields.
/// Malformed player lines are skipped rather than failing the reply.
pub fn parse_oob_getstatus(response: &[u8]) -> Result<StatusResponse, ParseError> {
    let payload = oob_payload(response, "statusResponse")?;
    let mut lines = payload.lines();
    let info = lines.next().ok_or(ParseError::MissingServerInfo)?;
    Ok(StatusResponse {
        info: parse_backslash_text(info)?,
        players: lines.filter_map(parse_status_player).collect(),
    })
}

/// Parse a five-byte MOHAA `getinfo` response.
///
/// # Errors
///
/// Returns an error for the wrong header/response marker or malformed serverinfo fields.
pub fn parse_oob_getinfo(response: &[u8]) -> Result<FieldMap, ParseError> {
    let payload = oob_payload(response, "infoResponse")?;
    let info = payload
        .lines()
        .next()
        .ok_or(ParseError::MissingServerInfo)?;
    parse_backslash_text(info)
}

/// Check the header and response marker, returning the text after the marker line.
fn oob_payload(response: &[u8], expected: &'static str) -> Result<String, ParseError> {
    if !response.starts_with(&OOB_RECV_HEADER) {
        return Err(ParseError::InvalidOobHeader);
    }
    let payload = latin1(&response[OOB_RECV_HEADER.len()..]);
    let (actual, rest) = payload.split_once('\n').unwrap_or((&payload, ""));
    let actual = actual.trim_end_matches('\r');
    if actual != expected {
        return Err(ParseError::UnexpectedOobResponse {
            expected,
            actual: actual.to_owned(),
        });
    }
    Ok(rest.to_owned())
}

/// One `getstatus` player line, `<ping> "<name>"` (`sv_main.c:545`).
///
/// Only the number just before the name is read as the ping, so a Quake III style
/// `<score> <ping> "<name>"` line still yields the right ping.
fn parse_status_player(line: &str) -> Option<Player> {
    let (head, quoted) = line.split_once('"')?;
    let name = quoted.rsplit_once('"').map_or(quoted, |(name, _)| name);
    let ping = head.split_whitespace().next_back()?.parse().ok()?;
    Some(Player {
        name: player_name(name),
        ping: Some(PlayerPing::new(ping)),
        kills: None,
        deaths: None,
    })
}

fn player_name(raw: &str) -> String {
    raw.chars()
        .filter(|character| !character.is_control())
        .collect::<String>()
        .trim()
        .to_owned()
}

fn parse_backslash_fields(response: &[u8]) -> Result<FieldMap, ParseError> {
    let text = latin1(response);
    parse_backslash_text(&text)
}

fn parse_backslash_text(text: &str) -> Result<FieldMap, ParseError> {
    let mut parts = text.split('\\');
    if text.starts_with('\\') {
        parts.next();
    }
    let mut fields = FieldMap::new();
    while let Some(key) = parts.next() {
        if key.is_empty() {
            continue;
        }
        if key == "final" {
            break;
        }
        let value = parts.next().ok_or_else(|| ParseError::MissingFieldValue {
            key: key.to_owned(),
        })?;
        fields.insert(key.to_owned(), value.to_owned());
    }
    Ok(fields)
}

fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| char::from(*byte)).collect()
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{
        TargetGame, build_master_query, gs_encode, gs_encrypt, parse_master_challenge,
        parse_master_response,
    };

    #[derive(Deserialize)]
    struct CryptoFixture {
        key: String,
        vectors: Vec<CryptoVector>,
    }

    #[derive(Deserialize)]
    struct CryptoVector {
        challenge: String,
        encrypted_hex: String,
        encoded: String,
    }

    #[test]
    fn matches_frozen_gamespy_crypto_vectors() {
        let fixture: CryptoFixture =
            serde_json::from_str(include_str!("../../tests/fixtures/gamespy_crypto.json"))
                .expect("valid crypto fixture");

        for vector in fixture.vectors {
            let encrypted = gs_encrypt(fixture.key.as_bytes(), vector.challenge.as_bytes())
                .expect("non-empty key");
            assert_eq!(hex(&encrypted), vector.encrypted_hex);
            assert_eq!(gs_encode(&encrypted), vector.encoded);
        }
    }

    #[test]
    fn builds_the_exact_master_query_shape() {
        let query = build_master_query(TargetGame::AlliedAssault, b"ABCDEF")
            .expect("compile-time key is valid");
        assert_eq!(
            query,
            "\\gamename\\mohaa\\gamever\\1\\location\\0\\validate\\iA2tel80\\final\\\\queryid\\1.1\\list\\cmp\\gamename\\mohaa\\final\\"
        );
    }

    #[test]
    fn parses_master_challenge_and_big_endian_query_ports() {
        assert_eq!(
            parse_master_challenge(b"\\basic\\\\secure\\ABCDEF\\").expect("challenge"),
            b"ABCDEF"
        );
        let response = [
            127, 0, 0, 1, 0x30, 0x0c, 173, 249, 214, 104, 0x30, 0x0d, b'\\', b'f', b'i', b'n',
            b'a', b'l', b'\\',
        ];
        let endpoints = parse_master_response(&response).expect("packed master response");
        assert_eq!(endpoints[0].query_port.get(), 12_300);
        assert_eq!(endpoints[1].query_port.get(), 12_301);
    }

    fn hex(bytes: &[u8]) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut output = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            output.push(char::from(DIGITS[usize::from(byte >> 4)]));
            output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
        }
        output
    }
}
