// SPDX-License-Identifier: GPL-3.0-only

//! The values an admin action carries, and the console lines each action becomes.
//!
//! The server reads one request line with `MSG_ReadStringLine` and splits it with
//! `Cmd_TokenizeString` (`sv_main.c:742-745`), which ends a token at whitespace or a quote and
//! drops everything after `//` or `/*`. Each newtype refuses exactly what would let its value
//! leave its argument that way. Command values also refuse `;`, which some engines read as a
//! command separator; the password is removed before command execution (`SVC_RemoteCommand`).

use std::fmt;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

/// Why a value cannot go into a console line.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum InvalidValue {
    /// Nothing was given.
    #[error("it is empty")]
    Empty,
    /// More characters than the field holds.
    #[error("it is longer than {limit} characters")]
    TooLong {
        /// Most characters accepted.
        limit: usize,
    },
    /// A character the server would read as the end of the value, or cannot show.
    #[error("it contains {0:?}, which the server cannot take here")]
    Character(char),
    /// `//` or `/*`, which the server's tokenizer reads as the start of a comment.
    #[error("it contains // or /*, which the server reads as the start of a comment")]
    Comment,
    /// A map path that steps out of its folder or starts at the root.
    #[error("it is not a map name")]
    NotAMapName,
}

fn bounded(value: &str, limit: usize) -> Result<(), InvalidValue> {
    if value.is_empty() {
        return Err(InvalidValue::Empty);
    }
    if value.chars().count() > limit {
        return Err(InvalidValue::TooLong { limit });
    }
    if value.contains("//") || value.contains("/*") {
        return Err(InvalidValue::Comment);
    }
    Ok(())
}

/// The server's RCON password.
///
/// It never prints: `Debug` is redacted and there is no `Display` or `Serialize`, so a log line or
/// an IPC payload cannot carry it by accident. Its memory is cleared when it is dropped.
pub struct RconPassword(String);

impl RconPassword {
    /// `sv_rconPassword` is compared against `Cmd_Argv(1)` (`sv_main.c:691`), one token, so it
    /// cannot hold a space or a quote.
    const LIMIT: usize = 128;

    /// Accept a password the server could have been given.
    ///
    /// # Errors
    ///
    /// Returns why the server could never match it.
    pub fn new(value: String) -> Result<Self, InvalidValue> {
        let password = Self(value);
        bounded(&password.0, Self::LIMIT)?;
        if let Some(bad) = password
            .0
            .chars()
            .find(|character| !character.is_ascii_graphic() || *character == '"')
        {
            return Err(InvalidValue::Character(bad));
        }
        Ok(password)
    }

    /// The password itself, for the request and for the operating system's credential store.
    #[must_use]
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RconPassword {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("RconPassword(<redacted>)")
    }
}

impl Drop for RconPassword {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// A client number as `status` lists it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct ClientSlot(u16);

impl ClientSlot {
    /// Wrap a client number.
    #[must_use]
    pub const fn new(value: u16) -> Self {
        Self(value)
    }

    /// The number the server uses.
    #[must_use]
    pub const fn get(self) -> u16 {
        self.0
    }
}

impl fmt::Display for ClientSlot {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// A map as `map` takes it: `dm/mohdm6`, `obj/obj_team2`, or a custom map's name.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MapName(String);

impl MapName {
    const LIMIT: usize = 64;

    /// Accept a map name.
    ///
    /// # Errors
    ///
    /// Returns why `value` is not a map name the server could load.
    pub fn new(value: &str) -> Result<Self, InvalidValue> {
        let value = value.trim();
        bounded(value, Self::LIMIT)?;
        if let Some(bad) = value.chars().find(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/'))
        }) {
            return Err(InvalidValue::Character(bad));
        }
        if value.starts_with('/')
            || value.ends_with('/')
            || value.split('/').any(|part| part == "..")
        {
            return Err(InvalidValue::NotAMapName);
        }
        Ok(Self(value.to_owned()))
    }

    /// The name as the server spells it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// What players read in their chat.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChatText(String);

impl ChatText {
    /// `MAX_SAY_TEXT` in the game module.
    const LIMIT: usize = 150;

    /// Accept a chat line.
    ///
    /// Plain ASCII only: the game draws its chat in a single-byte font, so an accented letter sent
    /// as UTF-8 would reach players as two wrong characters.
    ///
    /// # Errors
    ///
    /// Returns why the line cannot be sent as written.
    pub fn new(value: &str) -> Result<Self, InvalidValue> {
        let value = value.trim();
        bounded(value, Self::LIMIT)?;
        if let Some(bad) = value.chars().find(|character| {
            !(*character == ' ' || character.is_ascii_graphic()) || matches!(character, '"' | ';')
        }) {
            return Err(InvalidValue::Character(bad));
        }
        Ok(Self(value.to_owned()))
    }

    /// The line as players will read it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A console variable's name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CvarName(String);

impl CvarName {
    const LIMIT: usize = 64;

    /// Accept a cvar name.
    ///
    /// # Errors
    ///
    /// Returns why `value` is not a cvar name.
    pub fn new(value: &str) -> Result<Self, InvalidValue> {
        bounded(value, Self::LIMIT)?;
        if let Some(bad) = value
            .chars()
            .find(|character| !(character.is_ascii_alphanumeric() || *character == '_'))
        {
            return Err(InvalidValue::Character(bad));
        }
        Ok(Self(value.to_owned()))
    }

    /// The name as the server spells it.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A line typed into the console, sent as written.
///
/// The one free-form value: the admin asked for exactly this line. It still has to be one line,
/// because the server stops reading at the first newline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RawCommand(String);

impl RawCommand {
    /// The request buffer is `MAX_STRING_CHARS`, and `rcon`, the password and two spaces share it.
    const LIMIT: usize = 800;

    /// Accept a console line.
    ///
    /// # Errors
    ///
    /// Returns why the line cannot be sent.
    pub fn new(value: &str) -> Result<Self, InvalidValue> {
        let value = value.trim();
        if value.is_empty() {
            return Err(InvalidValue::Empty);
        }
        if value.chars().count() > Self::LIMIT {
            return Err(InvalidValue::TooLong { limit: Self::LIMIT });
        }
        if let Some(bad) = value
            .chars()
            .find(|character| !(*character == ' ' || character.is_ascii_graphic()))
        {
            return Err(InvalidValue::Character(bad));
        }
        Ok(Self(value.to_owned()))
    }

    /// The line as typed.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Which server program answers, as far as RCON is concerned.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RconEngine {
    /// The original 1.11, Spearhead or Breakthrough server, or a server that does not say.
    Original,
    /// `OpenMoHAA`.
    OpenMohaa,
}

impl RconEngine {
    /// Recognize the engine from the `version` serverinfo value.
    #[must_use]
    pub fn from_version(version: Option<&str>) -> Self {
        if version.is_some_and(crate::discovery::is_openmohaa_version) {
            Self::OpenMohaa
        } else {
            Self::Original
        }
    }

    /// Whether `tell` exists. `OpenMoHAA` registers it on dedicated servers (`sv_ccmds.c:1948`);
    /// the original servers' command list is not published, so it is not assumed there.
    #[must_use]
    pub const fn can_message_one_player(self) -> bool {
        matches!(self, Self::OpenMohaa)
    }

    /// Whether a ban by client number exists. `OpenMoHAA` has `banaddr` (`sv_ccmds.c:1955`); the
    /// original servers' `banClient` asks a `GameSpy` authorize server that no longer exists.
    #[must_use]
    pub const fn can_ban(self) -> bool {
        matches!(self, Self::OpenMohaa)
    }
}

/// A rotation for `sv_maplist`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rotation(Vec<MapName>);

impl Rotation {
    /// `sv_maplist` is one cvar value, so its whole length shares the request line.
    const LIMIT: usize = 700;

    /// Accept a rotation of at least one map.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidValue::Empty`] for no maps, or [`InvalidValue::TooLong`] when the list
    /// would not fit in one request.
    pub fn new(maps: Vec<MapName>) -> Result<Self, InvalidValue> {
        if maps.is_empty() {
            return Err(InvalidValue::Empty);
        }
        let length = maps.iter().map(|map| map.0.len() + 1).sum::<usize>();
        if length > Self::LIMIT {
            return Err(InvalidValue::TooLong { limit: Self::LIMIT });
        }
        Ok(Self(maps))
    }

    /// The maps in order.
    #[must_use]
    pub fn maps(&self) -> &[MapName] {
        &self.0
    }
}

/// One thing the admin asks the server to do.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RconAction {
    /// List the map and connected clients.
    Status,
    /// Drop a client from the server.
    Kick(ClientSlot),
    /// Ban a client's address, then drop them.
    Ban(ClientSlot),
    /// Write to one client's chat.
    Tell(ClientSlot, ChatText),
    /// Write to every client's chat.
    Say(ChatText),
    /// Load another map now.
    ChangeMap(MapName),
    /// Restart the current map.
    RestartRound,
    /// Read a cvar's value.
    ReadCvar(CvarName),
    /// Replace the map rotation.
    SetRotation(Rotation),
    /// A console line, as typed.
    Raw(RawCommand),
}

impl RconAction {
    /// The console lines this action sends, in order. Each goes in its own request.
    #[must_use]
    pub fn command_lines(&self) -> Vec<String> {
        match self {
            Self::Status => vec!["status".to_owned()],
            // `clientkick` is the original Quake III name; OpenMoHAA keeps it (`sv_ccmds.c:1923`).
            Self::Kick(slot) => vec![format!("clientkick {slot}")],
            // `banaddr` only records the address (`sv_ccmds.c:803`), so the client is kicked too.
            Self::Ban(slot) => vec![format!("banaddr {slot}"), format!("clientkick {slot}")],
            Self::Tell(slot, text) => vec![format!("tell {slot} {}", text.as_str())],
            Self::Say(text) => vec![format!("say {}", text.as_str())],
            Self::ChangeMap(map) => vec![format!("map {}", map.as_str())],
            Self::RestartRound => vec!["restart".to_owned()],
            Self::ReadCvar(name) => vec![name.as_str().to_owned()],
            Self::SetRotation(rotation) => {
                let maps = rotation
                    .maps()
                    .iter()
                    .map(MapName::as_str)
                    .collect::<Vec<_>>()
                    .join(" ");
                vec![format!("set sv_maplist \"{maps}\"")]
            }
            Self::Raw(line) => vec![line.as_str().to_owned()],
        }
    }

    /// Whether the reply waits on a map load. The server answers only after the command has run
    /// (`sv_main.c:747`), and loading a map takes seconds.
    #[must_use]
    pub const fn waits_on_map_load(&self) -> bool {
        matches!(self, Self::ChangeMap(_) | Self::RestartRound | Self::Raw(_))
    }

    /// Whether `engine` has the commands this action sends.
    #[must_use]
    pub const fn available_on(&self, engine: RconEngine) -> bool {
        match self {
            Self::Tell(..) => engine.can_message_one_player(),
            Self::Ban(_) => engine.can_ban(),
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_debug_never_shows_the_password() {
        let password = RconPassword::new("hunter2".to_owned()).expect("valid");
        assert_eq!(format!("{password:?}"), "RconPassword(<redacted>)");
        assert_eq!(password.expose(), "hunter2");
    }

    #[test]
    fn password_refuses_what_the_server_would_split() {
        for bad in ["", "two words", "quo\"te", "tab\there", "café"] {
            assert!(RconPassword::new(bad.to_owned()).is_err(), "{bad:?}");
        }
        assert_eq!(
            RconPassword::new("a//b".to_owned()).err(),
            Some(InvalidValue::Comment)
        );
        assert!(RconPassword::new("p;ss!#$%".to_owned()).is_ok());
    }

    #[test]
    fn map_names_keep_their_folder_and_refuse_paths_out() {
        assert_eq!(
            MapName::new(" dm/mohdm6 ").expect("valid").as_str(),
            "dm/mohdm6"
        );
        assert!(MapName::new("obj/obj_team2").is_ok());
        assert!(MapName::new("dm/my-map.v2").is_ok());
        for bad in [
            "",
            "dm/mohdm6; quit",
            "dm/../../x",
            "/dm/x",
            "dm/",
            "dm map",
            "a\"b",
        ] {
            assert!(MapName::new(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn chat_refuses_quotes_semicolons_and_line_breaks() {
        assert_eq!(
            ChatText::new("Next map in 5 minutes")
                .expect("valid")
                .as_str(),
            "Next map in 5 minutes"
        );
        assert_eq!(
            ChatText::new("say \"x\"").err(),
            Some(InvalidValue::Character('"'))
        );
        assert_eq!(
            ChatText::new("hi; quit").err(),
            Some(InvalidValue::Character(';'))
        );
        assert_eq!(
            ChatText::new("one\ntwo").err(),
            Some(InvalidValue::Character('\n'))
        );
        assert_eq!(
            ChatText::new("see http://x").err(),
            Some(InvalidValue::Comment)
        );
        assert_eq!(ChatText::new("   ").err(), Some(InvalidValue::Empty));
        assert_eq!(
            ChatText::new(&"x".repeat(151)).err(),
            Some(InvalidValue::TooLong { limit: 150 })
        );
    }

    #[test]
    fn each_action_becomes_its_console_lines() {
        let slot = ClientSlot::new(3);
        let text = ChatText::new("hello").expect("valid");
        let map = MapName::new("dm/mohdm2").expect("valid");
        let cases = [
            (RconAction::Status, vec!["status"]),
            (RconAction::Kick(slot), vec!["clientkick 3"]),
            (RconAction::Ban(slot), vec!["banaddr 3", "clientkick 3"]),
            (RconAction::Tell(slot, text.clone()), vec!["tell 3 hello"]),
            (RconAction::Say(text), vec!["say hello"]),
            (RconAction::ChangeMap(map.clone()), vec!["map dm/mohdm2"]),
            (RconAction::RestartRound, vec!["restart"]),
            (
                RconAction::ReadCvar(CvarName::new("sv_maplist").expect("valid")),
                vec!["sv_maplist"],
            ),
            (
                RconAction::SetRotation(
                    Rotation::new(vec![map, MapName::new("dm/mohdm6").expect("valid")])
                        .expect("valid"),
                ),
                vec!["set sv_maplist \"dm/mohdm2 dm/mohdm6\""],
            ),
            (
                RconAction::Raw(RawCommand::new(" g_gametype 2 ").expect("valid")),
                vec!["g_gametype 2"],
            ),
        ];
        for (action, lines) in cases {
            assert_eq!(action.command_lines(), lines, "{action:?}");
        }
    }

    #[test]
    fn original_servers_are_offered_neither_tell_nor_ban() {
        let original = RconEngine::from_version(Some("Medal of Honor Allied Assault 1.11"));
        let opm = RconEngine::from_version(Some("Medal of Honor Allied Assault 1.12+0.83.0 (OPM)"));
        assert_eq!(original, RconEngine::Original);
        assert_eq!(opm, RconEngine::OpenMohaa);
        assert_eq!(RconEngine::from_version(None), RconEngine::Original);
        let ban = RconAction::Ban(ClientSlot::new(1));
        assert!(!ban.available_on(original));
        assert!(ban.available_on(opm));
        assert!(RconAction::Kick(ClientSlot::new(1)).available_on(original));
    }

    #[test]
    fn a_rotation_holds_at_least_one_map_and_fits_one_request() {
        assert_eq!(Rotation::new(Vec::new()).err(), Some(InvalidValue::Empty));
        let long = vec![MapName::new(&"m".repeat(60)).expect("valid"); 12];
        assert_eq!(
            Rotation::new(long).err(),
            Some(InvalidValue::TooLong { limit: 700 })
        );
    }

    proptest::proptest! {
        #[test]
        fn accepted_values_never_leave_their_argument(value in "\\PC{0,200}") {
            let breaks_token = |text: &str| {
                text.contains(['"', '\n', '\r']) || text.contains("//") || text.contains("/*")
            };
            let breaks = |text: &str| breaks_token(text) || text.contains(';');
            if let Ok(text) = ChatText::new(&value) {
                proptest::prop_assert!(!breaks(text.as_str()));
            }
            if let Ok(map) = MapName::new(&value) {
                proptest::prop_assert!(!breaks(map.as_str()) && !map.as_str().contains(' '));
            }
            if let Ok(name) = CvarName::new(&value) {
                proptest::prop_assert!(!breaks(name.as_str()) && !name.as_str().contains(' '));
            }
            if let Ok(password) = RconPassword::new(value.clone()) {
                proptest::prop_assert!(!breaks_token(password.expose()) && !password.expose().contains(' '));
            }
            if let Ok(line) = RawCommand::new(&value) {
                proptest::prop_assert!(!line.as_str().contains(['\n', '\r']));
            }
        }

        #[test]
        fn a_chat_line_is_exactly_one_argument_tail(value in "[ -~]{1,150}") {
            if let Ok(text) = ChatText::new(&value) {
                let lines = RconAction::Say(text.clone()).command_lines();
                proptest::prop_assert_eq!(lines, vec![format!("say {}", text.as_str())]);
            }
        }
    }
}
