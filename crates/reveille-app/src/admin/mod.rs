// SPDX-License-Identifier: GPL-3.0-only

//! Admin: the remote console of servers the player runs.
//!
//! The first slice shaped as an extension (issue #63): it owns its commands, its state and its
//! file. The password goes from the
//! add dialog to the server and the credential store and never comes back to the page; commands
//! and their output are never logged.

mod list;
mod vault;

use std::collections::HashMap;
use std::net::SocketAddrV4;
use std::sync::{Arc, Mutex, PoisonError};

use reveille_core::discovery::{GamePort, query_getstatus};
use reveille_core::rcon::{
    ChatText, ClientSlot, CvarName, InvalidValue, MapName, RawCommand, RconAction, RconClient,
    RconEngine, RconError, RconPassword, RconPlayer, ReplyError, Rotation,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use tracing::warn;

use crate::servers::PROBE_TIMEOUT;
use list::{AdminList, AdminServer};
use vault::VaultKind;

/// The port a MOHAA server listens on when none is given (`net_ip.c`'s `PORT_SERVER`).
const DEFAULT_PORT: u16 = 12203;

/// The servers added, and a console for each one whose password this run has.
pub struct Admin {
    list: Option<AdminList>,
    consoles: Mutex<HashMap<SocketAddrV4, Arc<RconClient>>>,
    engines: Mutex<HashMap<SocketAddrV4, RconEngine>>,
}

pub fn register(app: &mut tauri::App) {
    let list = match app.path().app_data_dir() {
        Ok(directory) => Some(AdminList::new(&directory)),
        Err(error) => {
            warn!(%error, "no app data directory; servers added to Admin will not be kept");
            None
        }
    };
    app.manage(Admin {
        list,
        consoles: Mutex::default(),
        engines: Mutex::default(),
    });
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Why an admin command did nothing. `reason` is for the page to branch on; `message` is shown.
#[derive(Debug, Eq, PartialEq, Serialize)]
pub struct AdminFailure {
    reason: FailureReason,
    message: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FailureReason {
    /// Reveille has no password for this server in this run or in the credential store.
    NeedsPassword,
    /// The server refused the password.
    BadPassword,
    /// The server has no RCON password set.
    NotEnabled,
    /// Nothing came back.
    NoAnswer,
    /// A value the server could not take.
    Invalid,
    /// This server's program has no such command.
    Unavailable,
    /// The address is not one Admin knows, or cannot be reached.
    UnknownServer,
}

impl AdminFailure {
    fn new(reason: FailureReason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }

    fn invalid(what: &str, error: InvalidValue) -> Self {
        Self::new(
            FailureReason::Invalid,
            format!("The {what} cannot be sent: {error}."),
        )
    }
}

impl From<RconError> for AdminFailure {
    fn from(error: RconError) -> Self {
        match error {
            RconError::Reply(ReplyError::BadPassword) => Self::new(
                FailureReason::BadPassword,
                "The server did not accept this RCON password.",
            ),
            RconError::Reply(ReplyError::NotEnabled) => Self::new(
                FailureReason::NotEnabled,
                "This server has no RCON password set, so it takes no remote commands.",
            ),
            RconError::Timeout => Self::new(
                FailureReason::NoAnswer,
                "The server did not answer. It may be down, or busy loading a map.",
            ),
            RconError::Network(error) => Self::new(
                FailureReason::NoAnswer,
                format!("Reveille could not reach the server: {error}."),
            ),
            RconError::Reply(_) | RconError::TooLarge => Self::new(
                FailureReason::NoAnswer,
                format!("The server's answer could not be read: {error}."),
            ),
        }
    }
}

/// One server in Admin, as the page lists it.
#[derive(Serialize)]
pub struct AdminServerView {
    address: String,
    name: String,
}

impl From<AdminServer> for AdminServerView {
    fn from(server: AdminServer) -> Self {
        Self {
            address: server.address,
            name: server.name,
        }
    }
}

#[derive(Serialize)]
pub struct AdminOverview {
    servers: Vec<AdminServerView>,
    /// Where passwords are kept, so the page can say so.
    vault: VaultKind,
}

/// The servers added to Admin.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn admin_servers(admin: tauri::State<'_, Admin>) -> AdminOverview {
    AdminOverview {
        servers: admin
            .list
            .as_ref()
            .map(AdminList::servers)
            .unwrap_or_default()
            .into_iter()
            .map(AdminServerView::from)
            .collect(),
        vault: vault::KIND,
    }
}

/// Add a server the player runs, or give a known one a new password.
///
/// The server is asked for `status` with the password first, and nothing is kept unless it
/// answers: a typo is caught here, not at the first kick.
#[tauri::command]
pub async fn add_admin_server(
    address: String,
    password: String,
    admin: tauri::State<'_, Admin>,
) -> Result<AdminServerView, AdminFailure> {
    let address = resolve(&address).await?;
    let password = RconPassword::new(password).map_err(|error| {
        AdminFailure::new(
            FailureReason::BadPassword,
            format!("A server could not have this password: {error}."),
        )
    })?;
    let console = Arc::new(RconClient::new(address, password));
    console.status().await?;
    let info = query_getstatus(*address.ip(), GamePort::new(address.port()), PROBE_TIMEOUT)
        .await
        .ok();
    let server = AdminServer {
        address: address.to_string(),
        name: info
            .as_ref()
            .and_then(|info| info.get("sv_hostname"))
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| address.to_string()),
    };
    if let Err(error) = vault::save(&server.address, console.password()) {
        warn!(%error, "could not keep an RCON password; it lasts until Reveille closes");
    }
    if let Some(list) = &admin.list {
        list.add(server.clone()).map_err(|error| {
            AdminFailure::new(
                FailureReason::UnknownServer,
                format!("Reveille could not save its list of servers: {error}."),
            )
        })?;
    }
    if let Some(info) = &info {
        let engine = RconEngine::from_version(info.get("version").map(String::as_str));
        lock(&admin.engines).insert(address, engine);
    }
    lock(&admin.consoles).insert(address, console);
    Ok(server.into())
}

/// Take a server out of Admin and forget its password.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn remove_admin_server(address: String, admin: tauri::State<'_, Admin>) -> Result<(), String> {
    if let Some(list) = &admin.list {
        list.remove(&address)
            .map_err(|error| format!("Reveille could not save its list of servers: {error}."))?;
    }
    if let Ok(parsed) = address.parse::<SocketAddrV4>() {
        lock(&admin.consoles).remove(&parsed);
        lock(&admin.engines).remove(&parsed);
    }
    vault::forget(&address).map_err(|error| {
        format!("The server is out of Admin, but its password could not be forgotten: {error}.")
    })
}

/// What a server's console shows: its map and players, and which actions its program has.
#[derive(Serialize)]
pub struct AdminStatus {
    name: Option<String>,
    map: Option<String>,
    game_type: Option<String>,
    game_type_number: Option<u8>,
    capacity: Option<u32>,
    players: Vec<RconPlayer>,
    rotation: Vec<String>,
    engine: RconEngine,
    can_message: bool,
    can_ban: bool,
}

#[tauri::command]
pub async fn admin_status(
    address: String,
    admin: tauri::State<'_, Admin>,
) -> Result<AdminStatus, AdminFailure> {
    let (address, console) = admin.console(&address)?;
    let status = console.status().await?;
    // Public serverinfo: the name, mode, slots and rotation, and which program answers.
    let info = query_getstatus(*address.ip(), GamePort::new(address.port()), PROBE_TIMEOUT)
        .await
        .ok()
        .unwrap_or_default();
    let field = |key: &str| {
        info.get(key)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let engine = RconEngine::from_version(info.get("version").map(String::as_str));
    if !info.is_empty() {
        lock(&admin.engines).insert(address, engine);
    }
    Ok(AdminStatus {
        name: field("sv_hostname"),
        map: status.map.or_else(|| field("mapname")),
        game_type: field("g_gametypestring"),
        game_type_number: field("g_gametype").and_then(|value| value.parse().ok()),
        capacity: field("sv_maxclients").and_then(|value| value.parse().ok()),
        players: status.players,
        rotation: field("sv_maplist")
            .map(|list| list.split_whitespace().map(str::to_owned).collect())
            .unwrap_or_default(),
        engine,
        can_message: engine.can_message_one_player(),
        can_ban: engine.can_ban(),
    })
}

/// One action from the page. Every value is checked here, in Rust, before it becomes a command.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActionRequest {
    Kick { slot: u16 },
    Ban { slot: u16 },
    Message { slot: u16, text: String },
    Say { text: String },
    ChangeMap { map: String },
    RestartRound,
    SetRotation { maps: Vec<String> },
    SetGameType { game_type: u8 },
    ReadCvar { name: String },
    Console { line: String },
}

impl ActionRequest {
    fn action(self) -> Result<RconAction, AdminFailure> {
        let text = |text: &str| {
            ChatText::new(text).map_err(|error| AdminFailure::invalid("message", error))
        };
        let map =
            |map: &str| MapName::new(map).map_err(|error| AdminFailure::invalid("map name", error));
        Ok(match self {
            Self::Kick { slot } => RconAction::Kick(ClientSlot::new(slot)),
            Self::Ban { slot } => RconAction::Ban(ClientSlot::new(slot)),
            Self::Message { slot, text: line } => {
                RconAction::Tell(ClientSlot::new(slot), text(&line)?)
            }
            Self::Say { text: line } => RconAction::Say(text(&line)?),
            Self::ChangeMap { map: name } => RconAction::ChangeMap(map(&name)?),
            Self::RestartRound => RconAction::RestartRound,
            Self::SetGameType { game_type } => {
                // OpenMoHAA code/fgame/bg_public.h:112-123: FFA, Team, Team Rounds, Objective.
                if !(1..=4).contains(&game_type) {
                    return Err(AdminFailure::new(
                        FailureReason::Invalid,
                        "Choose a game type from 1 to 4.",
                    ));
                }
                RconAction::Raw(
                    RawCommand::new(&format!("set g_gametype {game_type}"))
                        .map_err(|error| AdminFailure::invalid("game type", error))?,
                )
            }
            Self::SetRotation { maps } => RconAction::SetRotation(
                Rotation::new(
                    maps.iter()
                        .map(|name| map(name))
                        .collect::<Result<_, _>>()?,
                )
                .map_err(|error| AdminFailure::invalid("rotation", error))?,
            ),
            Self::ReadCvar { name } => RconAction::ReadCvar(
                CvarName::new(&name)
                    .map_err(|error| AdminFailure::invalid("setting name", error))?,
            ),
            Self::Console { line } => RconAction::Raw(
                RawCommand::new(&line).map_err(|error| AdminFailure::invalid("command", error))?,
            ),
        })
    }
}

/// Run one action and return what the server printed.
#[tauri::command]
pub async fn admin_action(
    address: String,
    action: ActionRequest,
    admin: tauri::State<'_, Admin>,
) -> Result<String, AdminFailure> {
    let action = action.action()?;
    let (address, console) = admin.console(&address)?;
    if matches!(action, RconAction::Tell(..) | RconAction::Ban(_)) {
        let engine = lock(&admin.engines).get(&address).copied();
        if !engine.is_some_and(|engine| action.available_on(engine)) {
            return Err(AdminFailure::new(
                FailureReason::Unavailable,
                "This server's program has no such command.",
            ));
        }
    }
    Ok(console.run(&action).await?)
}

impl Admin {
    /// The console for `address`: this run's, or one opened with the stored password.
    fn console(&self, address: &str) -> Result<(SocketAddrV4, Arc<RconClient>), AdminFailure> {
        let known = self.list.as_ref().is_none_or(|list| {
            list.servers()
                .iter()
                .any(|server| server.address == address)
        });
        let parsed = address
            .parse::<SocketAddrV4>()
            .ok()
            .filter(|_| known)
            .ok_or_else(|| {
                AdminFailure::new(FailureReason::UnknownServer, "This server is not in Admin.")
            })?;
        let mut consoles = lock(&self.consoles);
        if let Some(console) = consoles.get(&parsed) {
            return Ok((parsed, Arc::clone(console)));
        }
        let password = vault::load(address).ok_or_else(|| {
            AdminFailure::new(
                FailureReason::NeedsPassword,
                "Reveille needs this server's RCON password again.",
            )
        })?;
        let console = Arc::new(RconClient::new(parsed, password));
        consoles.insert(parsed, Arc::clone(&console));
        Ok((parsed, console))
    }
}

/// `ip`, `ip:port`, `host` or `host:port`, as the player would type it, to one IPv4 address.
async fn resolve(input: &str) -> Result<SocketAddrV4, AdminFailure> {
    let input = input.trim();
    let unknown = || {
        AdminFailure::new(
            FailureReason::UnknownServer,
            format!("Reveille could not find a server at {input}."),
        )
    };
    if input.is_empty() {
        return Err(AdminFailure::new(
            FailureReason::UnknownServer,
            "Enter the server's address.",
        ));
    }
    let with_port = if input
        .rsplit_once(':')
        .is_some_and(|(_, port)| port.parse::<u16>().is_ok())
    {
        input.to_owned()
    } else {
        format!("{input}:{DEFAULT_PORT}")
    };
    if let Ok(address) = with_port.parse::<SocketAddrV4>() {
        return Ok(address);
    }
    tokio::net::lookup_host(&with_port)
        .await
        .map_err(|_| unknown())?
        .find_map(|address| match address {
            std::net::SocketAddr::V4(address) => Some(address),
            std::net::SocketAddr::V6(_) => None,
        })
        .ok_or_else(unknown)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn addresses_take_the_default_port_when_none_is_given() {
        assert_eq!(
            resolve(" 203.0.113.4 ").await.expect("address"),
            "203.0.113.4:12203"
                .parse::<SocketAddrV4>()
                .expect("literal")
        );
        assert_eq!(
            resolve("203.0.113.4:12204").await.expect("address"),
            "203.0.113.4:12204"
                .parse::<SocketAddrV4>()
                .expect("literal")
        );
        assert_eq!(
            resolve("").await.expect_err("empty").reason,
            FailureReason::UnknownServer
        );
    }

    #[test]
    fn requests_from_the_page_are_checked_before_they_become_commands() {
        let parse = |json: &str| {
            serde_json::from_str::<ActionRequest>(json)
                .expect("shape")
                .action()
        };
        assert_eq!(
            parse(r#"{"kind":"kick","slot":3}"#)
                .expect("kick")
                .command_lines(),
            ["clientkick 3"]
        );
        assert_eq!(
            parse(r#"{"kind":"say","text":"Next map in 5 minutes"}"#)
                .expect("say")
                .command_lines(),
            ["say Next map in 5 minutes"]
        );
        assert_eq!(
            parse(r#"{"kind":"set_rotation","maps":["dm/mohdm1","dm/mohdm2"]}"#)
                .expect("rotation")
                .command_lines(),
            ["set sv_maplist \"dm/mohdm1 dm/mohdm2\""]
        );
        for smuggled in [
            r#"{"kind":"say","text":"hi; rcon_password x"}"#,
            r#"{"kind":"change_map","map":"dm/mohdm6; quit"}"#,
            r#"{"kind":"message","slot":1,"text":"a\nquit"}"#,
            r#"{"kind":"set_rotation","maps":["dm/mohdm1\" quit"]}"#,
            r#"{"kind":"read_cvar","name":"sv_maplist;quit"}"#,
        ] {
            assert_eq!(
                parse(smuggled).expect_err(smuggled).reason,
                FailureReason::Invalid,
                "{smuggled}"
            );
        }
    }

    #[test]
    fn game_type_actions_accept_only_modes_one_through_four() {
        for mode in 1..=4 {
            let json = format!(r#"{{"kind":"set_game_type","game_type":{mode}}}"#);
            let action = serde_json::from_str::<ActionRequest>(&json)
                .expect("shape")
                .action()
                .expect("supported mode");
            assert_eq!(action.command_lines(), [format!("set g_gametype {mode}")]);
        }
        for mode in [0, 5, 255] {
            let json = format!(r#"{{"kind":"set_game_type","game_type":{mode}}}"#);
            let failure = serde_json::from_str::<ActionRequest>(&json)
                .expect("shape")
                .action()
                .expect_err("unsupported mode");
            assert_eq!(failure.reason, FailureReason::Invalid);
        }
    }

    #[test]
    fn a_refused_password_reads_as_such_not_as_a_dead_server() {
        let failure = AdminFailure::from(RconError::Reply(ReplyError::BadPassword));
        assert_eq!(failure.reason, FailureReason::BadPassword);
        assert_eq!(
            AdminFailure::from(RconError::Timeout).reason,
            FailureReason::NoAnswer
        );
    }
}
