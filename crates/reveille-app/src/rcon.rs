// SPDX-License-Identifier: GPL-3.0-only

//! The remote console commands.
//!
//! The password and the command are secrets in the same breath — a command can be
//! `set rconpassword …` — so neither is logged, counted in telemetry, or sent anywhere but the
//! server the player chose. Only the address and the shape of the outcome are written to the log.
//!
//! A remembered password lives in the operating system's credential store (the Windows Credential
//! Manager, the macOS Keychain), keyed by the server's address. It is read back here, in Rust, and
//! never returned to the interface: the interface only learns whether one exists.

use std::net::SocketAddrV4;
use std::sync::{Arc, OnceLock};

use reveille_core::discovery::{
    self, GamePort, RconCommand, RconError, RconPassword, RconPlayer, RconReply, RconTiming,
    RconVerdict,
};
use reveille_core::mapindex::MapIndex;
use serde::Serialize;
use thiserror::Error;
use tracing::{info, warn};

// openmohaa `code/qcommon/files.cpp:2910`: `fdir <filter>` lists matching files in every pak and
// directory the server has, which `dir` does not — `dir` reads one folder and never descends.
// openmohaa `code/server/sv_ccmds.c:1217`.
const LIST_PLAYERS: &str = "status";
const CREDENTIAL_SERVICE: &str = "Reveille remote console";

/// What the console shows for one command. Always returned as data: a wrong password and a
/// silent server are things the player is told about, not failures of the app.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum RconOutcome {
    /// The server answered. A refused password is still an answer; see `verdict`.
    Reply(RconReply),
    /// The password or command could not be sent, and nothing left this machine.
    Refused {
        /// Why, in words fit to show.
        reason: String,
    },
    /// The server said nothing in time. The command may still have run: a server answers after
    /// it has finished, and a map change takes seconds.
    NoAnswer,
    /// The network failed before an answer could arrive.
    Failed {
        /// The operating system's description.
        detail: String,
    },
}

/// What happened to the remembered password because of this command.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PasswordNote {
    /// Nothing changed.
    Unchanged,
    /// The server accepted the password and it is now remembered.
    Saved,
    /// The server accepted the password but the credential store would not keep it.
    NotSaved,
    /// The server refused the remembered password, so it was removed.
    Forgotten,
}

/// One answer, for all three commands.
#[derive(Debug, Serialize)]
pub struct RconResponse {
    /// What the server said, or why nothing was sent.
    pub outcome: RconOutcome,
    /// What became of the remembered password.
    pub password: PasswordNote,
    /// The clients, for the player list. Empty for anything else.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub players: Vec<RconPlayer>,
}

/// The credential store failed.
#[derive(Debug, Error)]
#[error("the system credential store failed: {0}")]
pub struct StoreError(String);

/// Where a remembered password is kept.
pub trait PasswordStore: Send + Sync + 'static {
    /// The password for a server, if one is remembered.
    fn load(&self, address: SocketAddrV4) -> Result<Option<String>, StoreError>;
    /// Remember a password for a server, replacing any earlier one.
    fn save(&self, address: SocketAddrV4, password: &str) -> Result<(), StoreError>;
    /// Remove the remembered password. Removing none is not an error.
    fn forget(&self, address: SocketAddrV4) -> Result<(), StoreError>;
}

/// The operating system's credential store.
pub struct SystemStore;

impl SystemStore {
    fn entry(address: SocketAddrV4) -> Result<keyring_core::Entry, StoreError> {
        static READY: OnceLock<Result<(), String>> = OnceLock::new();
        READY
            .get_or_init(install_credential_store)
            .clone()
            .map_err(StoreError)?;
        keyring_core::Entry::new(CREDENTIAL_SERVICE, &address.to_string())
            .map_err(|error| StoreError(error.to_string()))
    }
}

#[cfg(target_os = "windows")]
fn install_credential_store() -> Result<(), String> {
    let store = windows_native_keyring_store::Store::new().map_err(|error| error.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

#[cfg(target_os = "macos")]
fn install_credential_store() -> Result<(), String> {
    let store =
        apple_native_keyring_store::keychain::Store::new().map_err(|error| error.to_string())?;
    keyring_core::set_default_store(store);
    Ok(())
}

// Reveille ships for Windows and macOS only. Elsewhere there is no store, and saying so is the
// honest answer: a password is then simply asked for each time.
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn install_credential_store() -> Result<(), String> {
    Err("this system has no supported credential store".to_owned())
}

impl PasswordStore for SystemStore {
    fn load(&self, address: SocketAddrV4) -> Result<Option<String>, StoreError> {
        match Self::entry(address)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(error) => Err(StoreError(error.to_string())),
        }
    }

    fn save(&self, address: SocketAddrV4, password: &str) -> Result<(), StoreError> {
        Self::entry(address)?
            .set_password(password)
            .map_err(|error| StoreError(error.to_string()))
    }

    fn forget(&self, address: SocketAddrV4) -> Result<(), StoreError> {
        match Self::entry(address)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(error) => Err(StoreError(error.to_string())),
        }
    }
}

/// One command to send, as the interface asked for it.
struct Request {
    address: SocketAddrV4,
    /// What the player typed. `None` or empty means: use the remembered one.
    password: Option<String>,
    command: String,
    /// Keep the password once the server has accepted it.
    remember: bool,
}

/// Run one command: pick the password, send, and look after the remembered password afterwards.
async fn exchange(
    store: &Arc<dyn PasswordStore>,
    request: Request,
    timing: RconTiming,
) -> (RconOutcome, PasswordNote) {
    let typed = request.password.filter(|password| !password.is_empty());
    let from_store = typed.is_none();
    let secret = match typed {
        Some(password) => password,
        None => match blocking(store, move |store| store.load(request.address)).await {
            Ok(Some(password)) => password,
            Ok(None) => {
                return (
                    refused("enter the rcon password first".to_owned()),
                    PasswordNote::Unchanged,
                );
            }
            Err(error) => {
                return (
                    refused(format!(
                        "the remembered password could not be read: {error}"
                    )),
                    PasswordNote::Unchanged,
                );
            }
        },
    };

    let (password, command) = match (
        RconPassword::new(&secret),
        RconCommand::new(&request.command),
    ) {
        (Ok(password), Ok(command)) => (password, command),
        (Err(error), _) | (_, Err(error)) => {
            return (refused(error.to_string()), PasswordNote::Unchanged);
        }
    };

    let outcome = outcome(
        discovery::send_rcon(
            *request.address.ip(),
            GamePort::new(request.address.port()),
            &password,
            &command,
            timing,
        )
        .await,
    );
    info!(address = %request.address, outcome = outcome_label(&outcome), "remote console command");

    let verdict = match &outcome {
        RconOutcome::Reply(reply) => Some(reply.verdict),
        _ => None,
    };
    let note = match verdict {
        Some(RconVerdict::Executed) if !from_store && request.remember => {
            match blocking(store, move |store| store.save(request.address, &secret)).await {
                Ok(()) => PasswordNote::Saved,
                Err(error) => {
                    warn!(address = %request.address, %error, "could not remember the rcon password");
                    PasswordNote::NotSaved
                }
            }
        }
        Some(RconVerdict::WrongPassword | RconVerdict::PasswordNotSet) if from_store => {
            match blocking(store, move |store| store.forget(request.address)).await {
                Ok(()) => PasswordNote::Forgotten,
                Err(error) => {
                    warn!(address = %request.address, %error, "could not forget the rcon password");
                    PasswordNote::Unchanged
                }
            }
        }
        _ => PasswordNote::Unchanged,
    };
    (outcome, note)
}

/// Credential stores block, and macOS may stop to ask the player, so they never run on the
/// async executor.
async fn blocking<T, F>(store: &Arc<dyn PasswordStore>, work: F) -> Result<T, StoreError>
where
    T: Send + 'static,
    F: FnOnce(&dyn PasswordStore) -> Result<T, StoreError> + Send + 'static,
{
    let store = Arc::clone(store);
    tokio::task::spawn_blocking(move || work(store.as_ref()))
        .await
        .map_err(|error| StoreError(error.to_string()))?
}

fn parse_address(address: &str) -> Result<SocketAddrV4, String> {
    let parsed = address
        .parse::<SocketAddrV4>()
        .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
    if parsed.port() == 0 {
        return Err(format!("{parsed} has no game port to send a command to."));
    }
    Ok(parsed)
}

fn system_store() -> Arc<dyn PasswordStore> {
    Arc::new(SystemStore)
}

/// Send one console command to a server's game port and return what it printed.
///
/// `address` is the server's `ip:port` as the list shows it, the game port rather than the query
/// port. Leave `password` out to use the remembered one.
#[tauri::command]
pub async fn send_rcon_command(
    address: String,
    password: Option<String>,
    command: String,
    remember: bool,
) -> Result<RconResponse, String> {
    let address = parse_address(&address)?;
    let request = Request {
        address,
        password,
        command,
        remember,
    };
    let (outcome, password) = exchange(&system_store(), request, RconTiming::default()).await;
    Ok(RconResponse {
        outcome,
        password,
        players: Vec::new(),
    })
}

/// The clients on a server, read from its `status`.
#[tauri::command]
pub async fn rcon_list_players(
    address: String,
    password: Option<String>,
    remember: bool,
) -> Result<RconResponse, String> {
    let address = parse_address(&address)?;
    let request = Request {
        address,
        password,
        command: LIST_PLAYERS.to_owned(),
        remember,
    };
    let (outcome, password) = exchange(&system_store(), request, RconTiming::default()).await;
    let players = executed_output(&outcome).map(discovery::parse_status_players);
    Ok(RconResponse {
        outcome,
        password,
        players: players.unwrap_or_default(),
    })
}

/// The maps this computer has, custom ones included, as the names `map` takes.
///
/// A stock 1.11 server cannot list its own maps over rcon, and `fdir` only sees one folder level,
/// so the multiplayer maps under `maps/dm` and `maps/obj` never appear in it. A player needs the
/// same files to join, which makes the local game folder the list that is both complete and safe.
#[tauri::command]
pub async fn rcon_local_maps(session: crate::Session) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        crate::installed_maps(&session).map(|index| local_map_names(&index))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn local_map_names(index: &MapIndex) -> Vec<String> {
    let mut names: Vec<String> = index
        .maps()
        .map(|map| map.name.as_str().to_owned())
        .filter(|name| !name.ends_with("_sml") && discovery::is_safe_map_name(name))
        .collect();
    names.sort();
    names
}

/// Whether a password is remembered for this server. A store that cannot be read says no.
#[tauri::command]
pub async fn rcon_password_saved(address: String) -> bool {
    let Ok(address) = parse_address(&address) else {
        return false;
    };
    blocking(&system_store(), move |store| store.load(address))
        .await
        .is_ok_and(|saved| saved.is_some())
}

/// Remove the remembered password for this server. Returns whether the store accepted that.
#[tauri::command]
pub async fn rcon_forget_password(address: String) -> bool {
    let Ok(address) = parse_address(&address) else {
        return false;
    };
    blocking(&system_store(), move |store| store.forget(address))
        .await
        .is_ok()
}

fn executed_output(outcome: &RconOutcome) -> Option<&str> {
    match outcome {
        RconOutcome::Reply(reply) if reply.verdict == RconVerdict::Executed => {
            Some(reply.output.as_str())
        }
        _ => None,
    }
}

fn refused(reason: String) -> RconOutcome {
    RconOutcome::Refused { reason }
}

fn outcome(result: Result<RconReply, RconError>) -> RconOutcome {
    match result {
        Ok(reply) => RconOutcome::Reply(reply),
        Err(RconError::Input(error)) => refused(error.to_string()),
        Err(RconError::Timeout) => RconOutcome::NoAnswer,
        Err(RconError::Network(source)) => RconOutcome::Failed {
            detail: source.to_string(),
        },
    }
}

fn outcome_label(outcome: &RconOutcome) -> &'static str {
    match outcome {
        RconOutcome::Reply(_) => "reply",
        RconOutcome::Refused { .. } => "refused",
        RconOutcome::NoAnswer => "no_answer",
        RconOutcome::Failed { .. } => "failed",
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::io;
    use std::net::{Ipv4Addr, SocketAddrV4};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use reveille_core::discovery::{
        RconError, RconInputError, RconReply, RconTiming, RconVerdict, RoundTripMillis,
    };
    use serde_json::json;
    use tokio::net::UdpSocket;

    use super::{
        PasswordNote, PasswordStore, RconOutcome, Request, StoreError, exchange, local_map_names,
        outcome,
    };

    #[derive(Default)]
    struct MemoryStore {
        saved: Mutex<HashMap<SocketAddrV4, String>>,
        broken: bool,
    }

    impl MemoryStore {
        fn holding(address: SocketAddrV4, password: &str) -> Arc<Self> {
            let store = Self::default();
            store
                .saved
                .lock()
                .unwrap()
                .insert(address, password.to_owned());
            Arc::new(store)
        }

        fn broken() -> Arc<Self> {
            Arc::new(Self {
                broken: true,
                ..Self::default()
            })
        }

        fn password(&self, address: SocketAddrV4) -> Option<String> {
            self.saved.lock().unwrap().get(&address).cloned()
        }
    }

    impl PasswordStore for MemoryStore {
        fn load(&self, address: SocketAddrV4) -> Result<Option<String>, StoreError> {
            if self.broken {
                return Err(StoreError("locked".to_owned()));
            }
            Ok(self.password(address))
        }

        fn save(&self, address: SocketAddrV4, password: &str) -> Result<(), StoreError> {
            if self.broken {
                return Err(StoreError("locked".to_owned()));
            }
            self.saved
                .lock()
                .unwrap()
                .insert(address, password.to_owned());
            Ok(())
        }

        fn forget(&self, address: SocketAddrV4) -> Result<(), StoreError> {
            self.saved.lock().unwrap().remove(&address);
            Ok(())
        }
    }

    const FAST: RconTiming = RconTiming {
        first_reply: Duration::from_millis(400),
        settle: Duration::from_millis(60),
    };

    fn print_packet(text: &str) -> Vec<u8> {
        let mut packet = vec![0xff, 0xff, 0xff, 0xff, 0x01];
        packet.extend_from_slice(b"print\n");
        packet.extend_from_slice(text.as_bytes());
        packet
    }

    /// A server on loopback that expects `rcon <password> <command>` and answers with `reply`.
    async fn server(password: &str, command: &str, reply: &str) -> SocketAddrV4 {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, socket.local_addr().unwrap().port());
        let expected = format!("rcon {password} {command}");
        let reply = reply.to_owned();
        tokio::spawn(async move {
            let mut buffer = vec![0_u8; 2048];
            let (length, from) = socket.recv_from(&mut buffer).await.unwrap();
            let text = String::from_utf8_lossy(&buffer[5..length - 1]).into_owned();
            let answer = if text == expected {
                print_packet(&reply)
            } else {
                print_packet("Bad rconpassword.\n")
            };
            socket.send_to(&answer, from).await.unwrap();
        });
        address
    }

    fn request(address: SocketAddrV4, password: Option<&str>, remember: bool) -> Request {
        Request {
            address,
            password: password.map(str::to_owned),
            command: "status".to_owned(),
            remember,
        }
    }

    fn store_of(store: &Arc<MemoryStore>) -> Arc<dyn PasswordStore> {
        Arc::clone(store) as Arc<dyn PasswordStore>
    }

    #[tokio::test]
    async fn an_accepted_typed_password_is_remembered_when_asked() {
        let address = server("hunter2", "status", "ok\n").await;
        let store = Arc::new(MemoryStore::default());

        let (outcome, note) = exchange(
            &store_of(&store),
            request(address, Some("hunter2"), true),
            FAST,
        )
        .await;

        assert!(matches!(outcome, RconOutcome::Reply(_)));
        assert_eq!(note, PasswordNote::Saved);
        assert_eq!(store.password(address).as_deref(), Some("hunter2"));
    }

    #[tokio::test]
    async fn a_typed_password_is_not_remembered_unless_asked() {
        let address = server("hunter2", "status", "ok\n").await;
        let store = Arc::new(MemoryStore::default());

        let (_, note) = exchange(
            &store_of(&store),
            request(address, Some("hunter2"), false),
            FAST,
        )
        .await;

        assert_eq!(note, PasswordNote::Unchanged);
        assert_eq!(store.password(address), None);
    }

    #[tokio::test]
    async fn a_refused_typed_password_is_never_remembered() {
        let address = server("hunter2", "status", "ok\n").await;
        let store = Arc::new(MemoryStore::default());

        let (outcome, note) = exchange(
            &store_of(&store),
            request(address, Some("wrong"), true),
            FAST,
        )
        .await;

        let RconOutcome::Reply(reply) = outcome else {
            panic!("expected a reply");
        };
        assert_eq!(reply.verdict, RconVerdict::WrongPassword);
        assert_eq!(note, PasswordNote::Unchanged);
        assert_eq!(store.password(address), None);
    }

    #[tokio::test]
    async fn the_remembered_password_is_used_when_none_is_typed() {
        let address = server("hunter2", "status", "ok\n").await;
        let store = MemoryStore::holding(address, "hunter2");

        let (outcome, note) = exchange(&store_of(&store), request(address, None, true), FAST).await;

        let RconOutcome::Reply(reply) = outcome else {
            panic!("expected a reply");
        };
        assert_eq!(reply.verdict, RconVerdict::Executed);
        assert_eq!(note, PasswordNote::Unchanged);
    }

    #[tokio::test]
    async fn an_empty_typed_password_means_use_the_remembered_one() {
        let address = server("hunter2", "status", "ok\n").await;
        let store = MemoryStore::holding(address, "hunter2");

        let (outcome, _) =
            exchange(&store_of(&store), request(address, Some(""), false), FAST).await;

        assert!(matches!(outcome, RconOutcome::Reply(r) if r.verdict == RconVerdict::Executed));
    }

    #[tokio::test]
    async fn a_remembered_password_the_server_refuses_is_forgotten() {
        let address = server("hunter2", "status", "ok\n").await;
        let store = MemoryStore::holding(address, "changed-since");

        let (_, note) = exchange(&store_of(&store), request(address, None, true), FAST).await;

        assert_eq!(note, PasswordNote::Forgotten);
        assert_eq!(store.password(address), None);
    }

    #[tokio::test]
    async fn a_silent_server_does_not_cost_the_remembered_password() {
        let silent = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, silent.local_addr().unwrap().port());
        let store = MemoryStore::holding(address, "hunter2");

        let (outcome, note) = exchange(&store_of(&store), request(address, None, true), FAST).await;

        assert!(matches!(outcome, RconOutcome::NoAnswer));
        assert_eq!(note, PasswordNote::Unchanged);
        assert_eq!(store.password(address).as_deref(), Some("hunter2"));
    }

    #[tokio::test]
    async fn no_password_anywhere_is_a_refusal_before_any_packet() {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 1);
        let store = Arc::new(MemoryStore::default());

        let (outcome, _) = exchange(&store_of(&store), request(address, None, true), FAST).await;

        assert!(
            matches!(&outcome, RconOutcome::Refused { reason } if reason.contains("password")),
            "{outcome:?}"
        );
    }

    #[tokio::test]
    async fn a_store_that_cannot_keep_the_password_does_not_fail_the_command() {
        let address = server("hunter2", "status", "ok\n").await;
        let store = MemoryStore::broken();

        let (outcome, note) = exchange(
            &store_of(&store),
            request(address, Some("hunter2"), true),
            FAST,
        )
        .await;

        assert!(matches!(outcome, RconOutcome::Reply(r) if r.verdict == RconVerdict::Executed));
        assert_eq!(note, PasswordNote::NotSaved);
    }

    #[tokio::test]
    async fn a_store_that_cannot_be_read_says_so_instead_of_guessing() {
        let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, 1);
        let store = MemoryStore::broken();

        let (outcome, _) = exchange(&store_of(&store), request(address, None, true), FAST).await;

        assert!(
            matches!(&outcome, RconOutcome::Refused { reason } if reason.contains("could not be read")),
            "{outcome:?}"
        );
    }

    fn reply(output: &str, verdict: RconVerdict) -> RconReply {
        RconReply {
            output: output.to_owned(),
            verdict,
            packets: 1,
            truncated: false,
            round_trip: RoundTripMillis::new(42),
        }
    }

    #[test]
    fn a_reply_reaches_the_shell_flat_with_its_verdict() {
        let shown = serde_json::to_value(outcome(Ok(reply("ok\n", RconVerdict::WrongPassword))))
            .expect("outcome serializes");

        assert_eq!(
            shown,
            json!({
                "status": "reply",
                "output": "ok\n",
                "verdict": "wrong_password",
                "packets": 1,
                "truncated": false,
                "round_trip": 42,
            })
        );
    }

    #[test]
    fn silence_is_not_an_error_the_shell_has_to_catch() {
        let shown = serde_json::to_value(outcome(Err(RconError::Timeout))).expect("serializes");

        assert_eq!(shown, json!({ "status": "no_answer" }));
    }

    #[test]
    fn an_unsendable_input_says_why() {
        let shown =
            serde_json::to_value(outcome(Err(RconError::Input(RconInputError::EmptyCommand))))
                .expect("serializes");

        assert_eq!(
            shown,
            json!({ "status": "refused", "reason": "the command is empty" })
        );
    }

    #[test]
    fn a_socket_failure_carries_the_systems_own_words() {
        let failed = outcome(Err(RconError::Network(io::Error::other("unreachable"))));

        assert!(
            matches!(&failed, RconOutcome::Failed { detail } if detail == "unreachable"),
            "{failed:?}"
        );
    }

    #[test]
    fn the_response_leaves_out_lists_it_does_not_carry() {
        let shown = serde_json::to_value(super::RconResponse {
            outcome: RconOutcome::NoAnswer,
            password: PasswordNote::Forgotten,
            players: Vec::new(),
        })
        .expect("serializes");

        assert_eq!(
            shown,
            json!({ "outcome": { "status": "no_answer" }, "password": "forgotten" })
        );
    }

    #[test]
    fn local_maps_include_the_multiplayer_folders_and_drop_the_small_variants() {
        let temporary = tempfile::TempDir::new().expect("temporary directory");
        let maps = temporary.path().join("maps");
        let header = [
            b"2015".as_slice(),
            &19_i32.to_le_bytes(),
            &42_i32.to_le_bytes(),
        ]
        .concat();
        for name in ["dm/mohdm1", "dm/mohdm1_sml", "obj/obj_team1", "m1l1"] {
            let path = maps.join(format!("{name}.bsp"));
            std::fs::create_dir_all(path.parent().expect("parent")).expect("directory");
            std::fs::write(path, &header).expect("map");
        }
        let index = reveille_core::mapindex::MapIndex::scan(temporary.path()).expect("index");

        assert_eq!(
            local_map_names(&index),
            ["dm/mohdm1", "m1l1", "obj/obj_team1"]
        );
    }
}
