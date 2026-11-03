// SPDX-License-Identifier: GPL-3.0-only

//! A server address as a player pastes it: from a Discord message, a forum post, a console line.

use std::fmt;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use thiserror::Error;

use super::model::GamePort;

/// The game port a server listens on unless its admin chose another.
///
/// `OpenMoHAA` `code/qcommon/qcommon.h:395` defines `PORT_SERVER` as 12203.
pub const DEFAULT_GAME_PORT: GamePort = GamePort::new(12_203);

/// Longer than any address with a console command and a link prefix around it; a paste past this
/// is a message, not an address.
const MAX_INPUT: usize = 256;

/// DNS limits from RFC 1035 §2.3.4.
const MAX_HOSTNAME: usize = 253;
const MAX_LABEL: usize = 63;

/// Wrappers a pasted address arrives in. Discord adds backticks; forums add typographic quotes.
const QUOTES: &[char] = &[
    '"', '\'', '`', '\u{201C}', '\u{201D}', '\u{2018}', '\u{2019}',
];

/// Prefixes in front of the address, matched without regard to case. `+connect` is the launch
/// argument form, `/connect` and `connect` the console forms.
const COMMANDS: &[&str] = &["+connect", "/connect", "connect"];

/// Link forms a paste may carry. Reveille does not register the scheme yet; a player pasting one
/// still means the address inside it.
const LINK_PREFIXES: &[&str] = &["reveille://join/", "reveille://server/"];

/// What a pasted address could not be read as.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum AddressError {
    #[error("Enter the server's address.")]
    Empty,
    #[error("That is too long to be a server address.")]
    TooLong,
    #[error("Reveille could not read a server address in \u{201C}{0}\u{201D}.")]
    Unreadable(String),
    #[error("{0} is not a port number. Ports go from 1 to 65535.")]
    BadPort(String),
    #[error("Reveille could not find a server called {0}.")]
    NotFound(String),
}

/// The host half of a server address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Host {
    Ipv4(Ipv4Addr),
    /// Lower-cased, already checked against DNS name syntax.
    Name(String),
}

/// A server address read from a player's text, not yet looked up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerReference {
    pub host: Host,
    pub port: GamePort,
}

impl ServerReference {
    /// Read the address in `input`, forgiving the wrappers chat and consoles put around one.
    ///
    /// # Errors
    ///
    /// Returns why `input` holds no address this could read.
    pub fn parse(input: &str) -> Result<Self, AddressError> {
        let text = input.trim();
        if text.is_empty() {
            return Err(AddressError::Empty);
        }
        if text.len() > MAX_INPUT {
            return Err(AddressError::TooLong);
        }
        let text = strip_link(strip_command(text.trim_matches(QUOTES).trim()));
        let text = text.trim().trim_matches(QUOTES).trim();
        if text.is_empty() {
            return Err(AddressError::Empty);
        }
        let unreadable = || AddressError::Unreadable(input.trim().to_owned());
        if text.chars().any(char::is_whitespace) {
            return Err(unreadable());
        }
        let (host, port) = match text.rsplit_once(':') {
            Some((host, port)) => (host, parse_port(port)?),
            None => (text, DEFAULT_GAME_PORT),
        };
        let host = parse_host(host).ok_or_else(unreadable)?;
        Ok(Self { host, port })
    }

    /// The IPv4 game address this names, asking DNS for a hostname.
    ///
    /// # Errors
    ///
    /// Returns [`AddressError::NotFound`] when a hostname has no IPv4 address.
    pub async fn resolve(&self) -> Result<SocketAddrV4, AddressError> {
        let name = match &self.host {
            Host::Ipv4(address) => return Ok(SocketAddrV4::new(*address, self.port.get())),
            Host::Name(name) => name,
        };
        let not_found = || AddressError::NotFound(name.clone());
        tokio::net::lookup_host((name.as_str(), self.port.get()))
            .await
            .map_err(|_| not_found())?
            .find_map(|address| match address {
                SocketAddr::V4(address) => Some(address),
                SocketAddr::V6(_) => None,
            })
            .ok_or_else(not_found)
    }
}

impl fmt::Display for ServerReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.host {
            Host::Ipv4(address) => write!(formatter, "{address}:{}", self.port.get()),
            Host::Name(name) => write!(formatter, "{name}:{}", self.port.get()),
        }
    }
}

fn strip_command(text: &str) -> &str {
    for command in COMMANDS {
        let Some(head) = text.get(..command.len()) else {
            continue;
        };
        let rest = &text[command.len()..];
        if head.eq_ignore_ascii_case(command)
            && (rest.is_empty() || rest.starts_with(char::is_whitespace))
        {
            return rest.trim_start();
        }
    }
    text
}

fn strip_link(text: &str) -> &str {
    for prefix in LINK_PREFIXES {
        let Some(head) = text.get(..prefix.len()) else {
            continue;
        };
        if head.eq_ignore_ascii_case(prefix) {
            let rest = &text[prefix.len()..];
            let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
            return &rest[..end];
        }
    }
    text
}

fn parse_port(text: &str) -> Result<GamePort, AddressError> {
    text.parse::<u16>()
        .ok()
        .filter(|port| *port != 0)
        .map(GamePort::new)
        .ok_or_else(|| AddressError::BadPort(text.to_owned()))
}

fn parse_host(text: &str) -> Option<Host> {
    if let Ok(address) = text.parse::<Ipv4Addr>() {
        return Some(Host::Ipv4(address));
    }
    // `1.2.3` or `300.1.1.1` is a mistyped address, never a hostname; a name needs a letter.
    let named = text.len() <= MAX_HOSTNAME
        && text
            .chars()
            .any(|character| character.is_ascii_alphabetic())
        && text.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= MAX_LABEL
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '-')
        });
    named.then(|| Host::Name(text.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(input: &str) -> String {
        ServerReference::parse(input)
            .unwrap_or_else(|error| panic!("{input:?} should parse: {error}"))
            .to_string()
    }

    #[test]
    fn reads_the_forms_players_paste() {
        for (input, expected) in [
            ("203.0.113.4:12204", "203.0.113.4:12204"),
            ("  203.0.113.4:12204\n", "203.0.113.4:12204"),
            ("connect 203.0.113.4:12204", "203.0.113.4:12204"),
            ("CONNECT 203.0.113.4:12204", "203.0.113.4:12204"),
            ("/connect 203.0.113.4:12204", "203.0.113.4:12204"),
            ("+connect 203.0.113.4:12204", "203.0.113.4:12204"),
            ("`connect 203.0.113.4:12204`", "203.0.113.4:12204"),
            ("\u{201C}203.0.113.4:12204\u{201D}", "203.0.113.4:12204"),
            ("connect \"203.0.113.4:12204\"", "203.0.113.4:12204"),
            ("reveille://join/203.0.113.4:12204", "203.0.113.4:12204"),
            (
                "reveille://server/203.0.113.4:12204/?game=sh",
                "203.0.113.4:12204",
            ),
            ("MOH.Example.org:12210", "moh.example.org:12210"),
        ] {
            assert_eq!(read(input), expected, "{input:?}");
        }
    }

    #[test]
    fn an_address_without_a_port_takes_the_default_game_port() {
        assert_eq!(read("203.0.113.4"), "203.0.113.4:12203");
        assert_eq!(read("connect moh.example.org"), "moh.example.org:12203");
    }

    #[test]
    fn says_why_text_is_not_an_address() {
        let error = |input: &str| ServerReference::parse(input).expect_err(input);
        assert_eq!(error("   "), AddressError::Empty);
        assert_eq!(error("connect   "), AddressError::Empty);
        assert_eq!(error(&"1".repeat(300)), AddressError::TooLong);
        assert_eq!(
            error("203.0.113.4:0"),
            AddressError::BadPort("0".to_owned())
        );
        assert_eq!(
            error("203.0.113.4:99999"),
            AddressError::BadPort("99999".to_owned())
        );
        for input in [
            "join my server",
            "203.0.113",
            "300.1.1.1",
            "[2001:db8::1]:12203",
            "-bad.example.org",
            "under_score.example.org",
            "connectme.example.org:x",
        ] {
            assert!(
                matches!(
                    ServerReference::parse(input),
                    Err(AddressError::Unreadable(_) | AddressError::BadPort(_))
                ),
                "{input:?}"
            );
        }
    }

    #[test]
    fn a_hostname_that_starts_like_a_command_is_still_a_hostname() {
        assert_eq!(read("connect.example.org"), "connect.example.org:12203");
    }

    #[tokio::test]
    async fn an_ip_address_resolves_without_asking_dns() {
        let reference = ServerReference::parse("203.0.113.4").expect("address");
        assert_eq!(
            reference.resolve().await.expect("resolves"),
            SocketAddrV4::new(Ipv4Addr::new(203, 0, 113, 4), 12_203)
        );
    }
}
