// SPDX-License-Identifier: GPL-3.0-only

//! Anonymous product telemetry, on by default and turned off in Settings (issue #44).
//!
//! Every event the app can send is a variant of [`Event`], so what leaves the machine can be
//! reviewed in this one file. Properties are closed enums and counts: no paths, addresses, player
//! names, server names or error text. Builds made without `REVEILLE_TELEMETRY_KEY` never send.

use std::fs;
use std::io;
use std::panic::{self, PanicHookInfo};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reveille_core::discovery::TargetGame;
use reveille_core::engine::EngineChoice;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use thiserror::Error;
use tracing::{debug, warn};
use uuid::Uuid;

const CHOICE_FILENAME: &str = "telemetry.json";
const CRASH_FILENAME: &str = "telemetry-crash.json";
/// The EU region of `PostHog`, so events stay under EU data-protection law.
const DEFAULT_HOST: &str = "https://eu.i.posthog.com";
const CAPTURE_PATH: &str = "/i/v0/e/";
/// Short enough that a slow endpoint never holds a connection open behind the player's back.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// The session rules of `PostHog`: a new session after 30 idle minutes, and none may outlast
/// 24 hours, or its events drop out of session aggregations. A run kept in the tray can do both.
const SESSION_IDLE: Duration = Duration::from_mins(30);
const SESSION_MAX: Duration = Duration::from_hours(24);

/// Where events go. `None` when the build carries no project key.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Sink {
    api_key: String,
    endpoint: String,
}

impl Sink {
    /// The destination compiled into this build, if any.
    pub fn from_build() -> Option<Self> {
        Self::new(
            option_env!("REVEILLE_TELEMETRY_KEY"),
            option_env!("REVEILLE_TELEMETRY_HOST"),
        )
    }

    fn new(api_key: Option<&str>, host: Option<&str>) -> Option<Self> {
        let api_key = api_key.map(str::trim).filter(|key| !key.is_empty())?;
        let host = host
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .unwrap_or(DEFAULT_HOST)
            .trim_end_matches('/');
        Some(Self {
            api_key: api_key.to_owned(),
            endpoint: format!("{host}{CAPTURE_PATH}"),
        })
    }
}

/// Which download a batch belongs to.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadSource {
    /// Packages from the server's own download list.
    ServerFiles,
    /// Maps matched in the third-party catalogue.
    Catalogue,
}

/// Why a join did not end with the game starting. Low-cardinality on purpose: the player still
/// sees the full message, and only this code is sent.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinFailureReason {
    /// The server left the list between selecting it and joining.
    ServerGone,
    /// The server's own files still have to be installed first.
    ServerFilesPending,
    /// The game folder no longer holds the selected game.
    GameInstallMissing,
    /// The selected engine program is not usable in that folder.
    EngineMissing,
    /// No folder Reveille may write maps into.
    NoWritableFolder,
    /// A map download or install failed outright.
    DownloadFailed,
    /// The map the server is running now is not on disk, so the game would be dropped at once.
    CurrentMapMissing,
    /// The join was not fully checked and the player did not confirm it.
    Unconfirmed,
    /// The game program could not be started.
    LaunchFailed,
    /// Anything not classified above.
    Unknown,
}

/// A panic in the shape of `PostHog`'s manual exception capture, with its source position as the
/// only frame.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PanicReport {
    #[serde(rename = "type")]
    kind: &'static str,
    value: String,
    mechanism: Mechanism,
    stacktrace: Stacktrace,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Mechanism {
    handled: bool,
    synthetic: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Stacktrace {
    #[serde(rename = "type")]
    kind: &'static str,
    frames: [Frame; 1],
}

#[derive(Clone, Debug, PartialEq, Serialize)]
struct Frame {
    platform: &'static str,
    lang: &'static str,
    function: &'static str,
    filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    lineno: Option<u32>,
    resolved: bool,
    in_app: bool,
}

impl PanicReport {
    /// `location` is `file:line` as the panic hook recorded it, or `unknown`.
    fn at(location: &str) -> Self {
        let (filename, lineno) = match location.rsplit_once(':') {
            Some((file, line)) => match line.parse() {
                Ok(line) => (file, Some(line)),
                Err(_) => (location, None),
            },
            None => (location, None),
        };
        Self {
            kind: "panic",
            value: format!("Reveille stopped at {location}"),
            mechanism: Mechanism {
                handled: false,
                synthetic: false,
            },
            stacktrace: Stacktrace {
                kind: "raw",
                frames: [Frame {
                    platform: "custom",
                    lang: "rust",
                    // A panic location carries no function name, and PostHog requires one.
                    function: "panic",
                    filename: filename.to_owned(),
                    lineno,
                    resolved: true,
                    in_app: filename.starts_with("crates/"),
                }],
            },
        }
    }
}

/// Every event Reveille can send. Adding one here is the whole change needed to send it.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    AppStarted,
    /// The previous run panicked. Sent under `PostHog`'s own exception event so it appears in Error
    /// Tracking; the only detail is the panic's source position, never its message.
    #[serde(rename = "$exception")]
    AppCrashed {
        #[serde(rename = "$exception_list")]
        exceptions: [PanicReport; 1],
        crashed_version: String,
    },
    GameInstallDetected {
        games: Vec<reveille_core::install::Product>,
    },
    FirstRunCompleted {
        game: TargetGame,
        engine: EngineChoice,
    },
    ServerListLoaded {
        game: TargetGame,
        engine: EngineChoice,
        server_count: usize,
        cancelled: bool,
    },
    ServerListFailed {
        game: TargetGame,
        reason: crate::BrowseFailureKind,
    },
    ServerSelected {
        ready: bool,
    },
    MapDownloadStarted {
        source: DownloadSource,
        count: usize,
    },
    MapDownloadCompleted {
        source: DownloadSource,
        installed: usize,
    },
    MapDownloadFailed {
        source: DownloadSource,
        failed: usize,
    },
    JoinClicked {
        game: TargetGame,
        engine: EngineChoice,
        accept_incomplete: bool,
    },
    GameLaunched {
        game: TargetGame,
        engine: EngineChoice,
    },
    JoinFailed {
        game: TargetGame,
        engine: EngineChoice,
        reason: JoinFailureReason,
    },
}

/// The events the frontend may ask for. Everything else is sent from the command that observes
/// it, so the webview cannot name an event or a property of its own.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum UiEvent {
    FirstRunCompleted {
        game: TargetGame,
        engine: EngineChoice,
    },
    ServerSelected {
        ready: bool,
    },
}

/// Whether this installation shares statistics.
#[derive(Clone, Debug, Eq, PartialEq)]
enum Choice {
    Declined,
    Shared { installation_id: Uuid },
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct StoredChoice {
    shared: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installation_id: Option<Uuid>,
}

/// What the frontend needs to draw the Settings toggle.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct TelemetryStatus {
    /// Whether this build can send anything at all.
    pub available: bool,
    pub shared: bool,
}

#[derive(Debug, Error)]
pub enum TelemetryError {
    #[error("could not save the telemetry choice at {path}")]
    Save {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Managed Tauri state.
pub struct Telemetry {
    sink: Option<Sink>,
    directory: PathBuf,
    app_version: String,
    session: Mutex<Session>,
    choice: Mutex<Choice>,
    /// Read by the panic hook, which cannot take the lock.
    sharing: Arc<AtomicBool>,
    server_selected_sent: AtomicBool,
    client: reqwest::Client,
    /// False when there is no config directory to write the choice, crash marker or ID into.
    persist: bool,
}

impl Telemetry {
    /// Read the saved choice from `directory`. With no saved choice, a build that can send starts
    /// sharing under a new installation ID; an unreadable file shares nothing and is left alone.
    pub fn load(directory: PathBuf, app_version: String, sink: Option<Sink>) -> Self {
        let choice = match read_choice(&directory.join(CHOICE_FILENAME)) {
            Some(choice) => choice,
            None if sink.is_some() => {
                let choice = Choice::Shared {
                    installation_id: Uuid::new_v4(),
                };
                if let Err(error) = write_choice(&directory, &choice) {
                    warn!(%error, "could not save the installation ID");
                }
                choice
            }
            None => Choice::Declined,
        };
        Self::new(directory, app_version, sink, choice, true)
    }

    /// Telemetry that never sends, with nowhere to keep a choice.
    pub fn unavailable(app_version: String) -> Self {
        Self::new(PathBuf::new(), app_version, None, Choice::Declined, false)
    }

    fn new(
        directory: PathBuf,
        app_version: String,
        sink: Option<Sink>,
        choice: Choice,
        persist: bool,
    ) -> Self {
        let sharing = Arc::new(AtomicBool::new(matches!(choice, Choice::Shared { .. })));
        let client = reqwest::Client::builder()
            .timeout(SEND_TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            sink,
            directory,
            app_version,
            session: Mutex::new(Session::begin(SystemTime::now())),
            choice: Mutex::new(choice),
            sharing,
            server_selected_sent: AtomicBool::new(false),
            client,
            persist,
        }
    }

    pub fn status(&self) -> TelemetryStatus {
        TelemetryStatus {
            available: self.sink.is_some(),
            shared: matches!(*self.lock(), Choice::Shared { .. }),
        }
    }

    /// Record the player's answer. Turning sharing on counts this run; turning it off forgets
    /// the installation ID, so opting in again later starts a new one.
    pub fn set_shared(&self, shared: bool) -> Result<TelemetryStatus, TelemetryError> {
        if !self.persist {
            return Ok(self.status());
        }
        let newly_shared = {
            let mut choice = self.lock();
            let next = match (&*choice, shared) {
                (Choice::Shared { .. }, true) => choice.clone(),
                (_, true) => Choice::Shared {
                    installation_id: Uuid::new_v4(),
                },
                (_, false) => Choice::Declined,
            };
            write_choice(&self.directory, &next)?;
            let newly_shared =
                !matches!(*choice, Choice::Shared { .. }) && matches!(next, Choice::Shared { .. });
            *choice = next;
            newly_shared
        };
        self.sharing.store(shared, Ordering::SeqCst);
        if !shared {
            remove_if_present(&self.directory.join(CRASH_FILENAME));
        }
        if newly_shared {
            self.track(&Event::AppStarted);
        }
        Ok(self.status())
    }

    /// Send the start-of-run events: a crash left by the previous run, then this start.
    pub fn start(&self) {
        if !self.persist {
            return;
        }
        let marker = self.directory.join(CRASH_FILENAME);
        if let Some(crash) = read_crash(&marker) {
            self.track(&Event::AppCrashed {
                exceptions: [PanicReport::at(&crash.location)],
                crashed_version: crash.version,
            });
        }
        remove_if_present(&marker);
        self.track(&Event::AppStarted);
    }

    pub fn track_ui(&self, event: UiEvent) {
        match event {
            UiEvent::FirstRunCompleted { game, engine } => {
                self.track(&Event::FirstRunCompleted { game, engine });
            }
            UiEvent::ServerSelected { ready } => {
                // Once per run: selection follows the arrow keys, and the funnel only needs to
                // know that a player got this far.
                if !self.server_selected_sent.swap(true, Ordering::SeqCst) {
                    self.track(&Event::ServerSelected { ready });
                }
            }
        }
    }

    /// Queue `event` if the player shares and the build has a destination. Never blocks and never
    /// fails the caller: a lost event costs a data point, not a join.
    pub fn track(&self, event: &Event) {
        let Some(sink) = &self.sink else { return };
        let Choice::Shared { installation_id } = *self.lock() else {
            return;
        };
        let now = SystemTime::now();
        let session_id = self
            .session
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .touch(now);
        let body = payload(
            sink,
            event,
            installation_id,
            session_id,
            &self.app_version,
            now,
        );
        let request = self.client.post(&sink.endpoint).json(&body);
        tauri::async_runtime::spawn(async move {
            match request
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
            {
                Ok(_) => {}
                Err(error) => debug!(%error, "telemetry event was not delivered"),
            }
        });
    }

    /// Leave a marker for the next run when the process panics, if the player shares.
    pub fn install_panic_hook(&self) {
        if !self.persist {
            return;
        }
        let sharing = Arc::clone(&self.sharing);
        let marker = self.directory.join(CRASH_FILENAME);
        let version = self.app_version.clone();
        let previous = panic::take_hook();
        panic::set_hook(Box::new(move |info| {
            if sharing.load(Ordering::SeqCst) {
                write_crash(&marker, &version, info);
            }
            previous(info);
        }));
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Choice> {
        self.choice.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The `$session_id` `PostHog` expects from a backend: a `UUIDv7` whose time part is the session's
/// start.
#[derive(Clone, Copy, Debug)]
struct Session {
    id: Uuid,
    started: SystemTime,
    last: SystemTime,
}

impl Session {
    fn begin(now: SystemTime) -> Self {
        Self {
            id: uuid_v7_at(now),
            started: now,
            last: now,
        }
    }

    /// The session `now` belongs to, starting a new one when the current one has gone idle or
    /// grown too old.
    fn touch(&mut self, now: SystemTime) -> Uuid {
        let elapsed = |since: SystemTime| now.duration_since(since).unwrap_or_default();
        if elapsed(self.last) >= SESSION_IDLE || elapsed(self.started) >= SESSION_MAX {
            *self = Self::begin(now);
        }
        self.last = now;
        self.id
    }
}

fn uuid_v7_at(time: SystemTime) -> Uuid {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    Uuid::new_v7(uuid::Timestamp::from_unix(
        uuid::NoContext,
        since.as_secs(),
        since.subsec_nanos(),
    ))
}

fn payload(
    sink: &Sink,
    event: &Event,
    installation_id: Uuid,
    session_id: Uuid,
    app_version: &str,
    now: SystemTime,
) -> Value {
    let mut properties = match serde_json::to_value(event) {
        Ok(Value::Object(map)) => map,
        _ => Map::new(),
    };
    let name = properties
        .remove("event")
        .and_then(|name| name.as_str().map(str::to_owned))
        .unwrap_or_default();
    properties.insert("$session_id".to_owned(), json!(session_id));
    properties.insert("$lib".to_owned(), json!("reveille"));
    properties.insert("$lib_version".to_owned(), json!(app_version));
    properties.insert("app_version".to_owned(), json!(app_version));
    properties.insert("os".to_owned(), json!(std::env::consts::OS));
    // No GeoIP lookup and no person profile: the provider keeps an anonymous event stream only.
    properties.insert("$geoip_disable".to_owned(), json!(true));
    properties.insert("$process_person_profile".to_owned(), json!(false));
    json!({
        "api_key": sink.api_key,
        // Lets PostHog drop the duplicate if a retried request was in fact delivered.
        "uuid": uuid_v7_at(now),
        "event": name,
        "distinct_id": installation_id,
        "properties": properties,
        "timestamp": rfc3339(now),
    })
}

/// `None` when nothing has been saved yet.
fn read_choice(path: &Path) -> Option<Choice> {
    let stored = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<StoredChoice>(&bytes),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
        Err(error) => {
            warn!(%error, "could not read the telemetry choice");
            return Some(Choice::Declined);
        }
    };
    Some(match stored {
        Ok(StoredChoice {
            shared: true,
            installation_id: Some(installation_id),
        }) => Choice::Shared { installation_id },
        Ok(_) => Choice::Declined,
        // A player who turned sharing off must not be turned back on by a damaged file.
        Err(error) => {
            warn!(%error, "the saved telemetry choice is unreadable");
            Choice::Declined
        }
    })
}

fn write_choice(directory: &Path, choice: &Choice) -> Result<(), TelemetryError> {
    let stored = match choice {
        Choice::Shared { installation_id } => StoredChoice {
            shared: true,
            installation_id: Some(*installation_id),
        },
        Choice::Declined => StoredChoice::default(),
    };
    let path = directory.join(CHOICE_FILENAME);
    let save = |source| TelemetryError::Save {
        path: path.clone(),
        source,
    };
    fs::create_dir_all(directory).map_err(save)?;
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|error| save(error.into()))?;
    fs::write(&path, bytes).map_err(save)
}

#[derive(Debug, Deserialize, Serialize)]
struct CrashMarker {
    version: String,
    location: String,
}

fn write_crash(path: &Path, version: &str, info: &PanicHookInfo<'_>) {
    let location = info.location().map_or_else(
        || "unknown".to_owned(),
        |location| format!("{}:{}", source_relative(location.file()), location.line()),
    );
    let marker = CrashMarker {
        version: version.to_owned(),
        location,
    };
    if let Ok(bytes) = serde_json::to_vec(&marker) {
        // Nothing useful can be done with a failure while the process is already panicking.
        let _ = fs::write(path, bytes);
    }
}

fn read_crash(path: &Path) -> Option<CrashMarker> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn remove_if_present(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => warn!(%error, "could not remove a telemetry file"),
    }
}

/// Keep only the tail of a panic's source path. Workspace files are already relative; a
/// dependency's path is absolute on the machine that built the release, and only the crate and
/// file matter.
fn source_relative(file: &str) -> String {
    let normalized = file.replace('\\', "/");
    let drive_letter = normalized.as_bytes().get(1) == Some(&b':');
    if !Path::new(file).is_absolute() && !normalized.starts_with('/') && !drive_letter {
        return normalized;
    }
    let parts = normalized
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    parts[parts.len().saturating_sub(3)..].join("/")
}

/// UTC in RFC 3339 with millisecond precision.
fn rfc3339(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs();
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    let of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60,
        since.subsec_millis(),
    )
}

/// Howard Hinnant's days-to-civil conversion, for the proleptic Gregorian calendar.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use serde_json::json;
    use tempfile::TempDir;
    use uuid::Uuid;

    use super::{
        CHOICE_FILENAME, CRASH_FILENAME, Event, JoinFailureReason, PanicReport, Session, Sink,
        Telemetry, UiEvent, payload, rfc3339, source_relative,
    };
    use reveille_core::discovery::TargetGame;
    use reveille_core::engine::EngineChoice;

    fn sink() -> Sink {
        Sink::new(Some("phc_test"), None).expect("configured sink")
    }

    fn loaded(directory: &TempDir, sink: Option<Sink>) -> Telemetry {
        Telemetry::load(directory.path().to_path_buf(), "0.4.0".to_owned(), sink)
    }

    #[test]
    fn a_build_without_a_key_has_no_destination() {
        assert_eq!(Sink::new(None, None), None);
        assert_eq!(Sink::new(Some("  "), None), None);
    }

    #[test]
    fn the_default_destination_is_the_eu_region() {
        assert_eq!(sink().endpoint, "https://eu.i.posthog.com/i/v0/e/");
        let custom = Sink::new(Some("phc_test"), Some("https://example.test/")).expect("sink");
        assert_eq!(custom.endpoint, "https://example.test/i/v0/e/");
    }

    #[test]
    fn a_new_installation_shares_under_a_saved_random_id() {
        let directory = TempDir::new().expect("directory");
        let status = loaded(&directory, Some(sink())).status();
        assert!(status.available);
        assert!(status.shared);
        let saved: serde_json::Value = serde_json::from_slice(
            &std::fs::read(directory.path().join(CHOICE_FILENAME)).expect("read"),
        )
        .expect("json");
        let id = saved["installation_id"].as_str().expect("id").to_owned();
        assert!(Uuid::parse_str(&id).is_ok());

        let reloaded: serde_json::Value = {
            loaded(&directory, Some(sink()));
            serde_json::from_slice(
                &std::fs::read(directory.path().join(CHOICE_FILENAME)).expect("read"),
            )
            .expect("json")
        };
        assert_eq!(reloaded["installation_id"].as_str(), Some(id.as_str()));
    }

    #[test]
    fn a_build_without_a_key_writes_nothing_and_shares_nothing() {
        let directory = TempDir::new().expect("directory");
        let status = loaded(&directory, None).status();
        assert!(!status.available);
        assert!(!status.shared);
        assert!(!directory.path().join(CHOICE_FILENAME).exists());
    }

    #[test]
    fn sharing_persists_a_random_installation_id_and_declining_forgets_it() {
        let directory = TempDir::new().expect("directory");
        let path = directory.path().join(CHOICE_FILENAME);
        let telemetry = loaded(&directory, None);

        telemetry.set_shared(true).expect("share");
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        let first = saved["installation_id"].as_str().expect("id").to_owned();
        assert!(Uuid::parse_str(&first).is_ok());
        assert!(loaded(&directory, None).status().shared);

        telemetry.set_shared(false).expect("decline");
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        assert_eq!(saved, json!({ "shared": false }));
        assert!(!loaded(&directory, None).status().shared);

        telemetry.set_shared(true).expect("share again");
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        assert_ne!(saved["installation_id"].as_str().expect("id"), first);
    }

    #[test]
    fn a_corrupt_choice_file_is_never_read_as_consent() {
        let directory = TempDir::new().expect("directory");
        std::fs::write(directory.path().join(CHOICE_FILENAME), b"{not json").expect("write");
        assert!(!loaded(&directory, Some(sink())).status().shared);
        assert_eq!(
            std::fs::read(directory.path().join(CHOICE_FILENAME)).expect("read"),
            b"{not json"
        );
    }

    #[test]
    fn declining_discards_a_pending_crash_marker() {
        let directory = TempDir::new().expect("directory");
        let marker = directory.path().join(CRASH_FILENAME);
        std::fs::write(
            &marker,
            br#"{"version":"0.4.0","location":"src/main.rs:1"}"#,
        )
        .expect("write marker");
        loaded(&directory, None).set_shared(false).expect("decline");
        assert!(!marker.exists());
    }

    #[test]
    fn events_carry_ids_version_and_timestamp_but_no_ip_lookup() {
        let installation = Uuid::new_v4();
        let session = super::uuid_v7_at(UNIX_EPOCH + Duration::from_hours(488_650));
        let body = payload(
            &sink(),
            &Event::JoinFailed {
                game: TargetGame::Spearhead,
                engine: EngineChoice::Openmohaa,
                reason: JoinFailureReason::EngineMissing,
            },
            installation,
            session,
            "0.4.0",
            UNIX_EPOCH + Duration::from_millis(1_759_140_488_123),
        );
        assert_eq!(body["api_key"], "phc_test");
        assert_eq!(body["event"], "join_failed");
        assert_eq!(body["distinct_id"], json!(installation));
        assert_eq!(body["timestamp"], "2025-09-29T10:08:08.123Z");
        let properties = &body["properties"];
        assert_eq!(properties["$session_id"], json!(session));
        assert_eq!(properties["$lib"], "reveille");
        assert_eq!(properties["$lib_version"], "0.4.0");
        let event_id = Uuid::parse_str(body["uuid"].as_str().expect("uuid")).expect("uuid");
        assert_eq!(event_id.get_version_num(), 7);
        assert_eq!(properties["app_version"], "0.4.0");
        assert_eq!(properties["game"], "spearhead");
        assert_eq!(properties["engine"], "openmohaa");
        assert_eq!(properties["reason"], "engine_missing");
        assert_eq!(properties["$geoip_disable"], true);
        assert_eq!(properties["$process_person_profile"], false);
        assert!(properties.get("event").is_none());
    }

    #[test]
    fn a_crash_is_sent_as_a_posthog_exception_without_its_message() {
        let body = payload(
            &sink(),
            &Event::AppCrashed {
                exceptions: [PanicReport::at("crates/reveille-app/src/main.rs:42")],
                crashed_version: "0.3.0".to_owned(),
            },
            Uuid::new_v4(),
            Uuid::now_v7(),
            "0.4.0",
            UNIX_EPOCH,
        );
        assert_eq!(body["event"], "$exception");
        let properties = &body["properties"];
        assert_eq!(properties["crashed_version"], "0.3.0");
        assert_eq!(
            properties["$exception_list"],
            json!([{
                "type": "panic",
                "value": "Reveille stopped at crates/reveille-app/src/main.rs:42",
                "mechanism": { "handled": false, "synthetic": false },
                "stacktrace": {
                    "type": "raw",
                    "frames": [{
                        "platform": "custom",
                        "lang": "rust",
                        "function": "panic",
                        "filename": "crates/reveille-app/src/main.rs",
                        "lineno": 42,
                        "resolved": true,
                        "in_app": true,
                    }],
                },
            }])
        );
    }

    #[test]
    fn a_crash_outside_the_workspace_or_without_a_line_still_has_a_frame() {
        let dependency =
            serde_json::to_value(PanicReport::at("tokio-1.50.0/src/lib.rs:7")).expect("json");
        assert_eq!(dependency["stacktrace"]["frames"][0]["in_app"], false);
        assert_eq!(dependency["stacktrace"]["frames"][0]["lineno"], 7);

        let unknown = serde_json::to_value(PanicReport::at("unknown")).expect("json");
        assert_eq!(unknown["stacktrace"]["frames"][0]["filename"], "unknown");
        assert!(unknown["stacktrace"]["frames"][0].get("lineno").is_none());
    }

    #[test]
    fn the_frontend_can_only_name_its_own_events() {
        let parsed: UiEvent =
            serde_json::from_value(json!({ "event": "server_selected", "ready": true }))
                .expect("known event");
        assert_eq!(parsed, UiEvent::ServerSelected { ready: true });
        assert!(serde_json::from_value::<UiEvent>(json!({ "event": "game_launched" })).is_err());
        assert!(serde_json::from_value::<UiEvent>(json!({ "event": "anything" })).is_err());
    }

    #[test]
    fn crash_locations_drop_the_build_machine_path() {
        assert_eq!(
            source_relative("crates/reveille-app/src/main.rs"),
            "crates/reveille-app/src/main.rs"
        );
        assert_eq!(
            source_relative("/home/runner/.cargo/registry/src/index-1/tokio-1.50.0/src/lib.rs"),
            "tokio-1.50.0/src/lib.rs"
        );
        assert_eq!(
            source_relative(r"C:\Users\runneradmin\.cargo\registry\src\x\serde-1.0.0\src\de.rs"),
            "serde-1.0.0/src/de.rs"
        );
    }

    #[test]
    fn a_session_follows_posthogs_idle_and_age_limits() {
        let start = UNIX_EPOCH + Duration::from_hours(488_650);
        let mut session = Session::begin(start);
        let first = session.id;
        assert_eq!(first.get_version_num(), 7);
        let (seconds, _) = first.get_timestamp().expect("v7 timestamp").to_unix();
        assert_eq!(seconds, 488_650 * 3_600);

        // Busy for 23 hours: one session.
        for minute in (0..23 * 60).step_by(20) {
            assert_eq!(session.touch(start + Duration::from_mins(minute)), first);
        }
        // Past 24 hours since it began: a new one, even though the player never went idle.
        let renewed = session.touch(start + Duration::from_hours(24));
        assert_ne!(renewed, first);

        // Half an hour idle: another.
        let later = start + Duration::from_hours(24) + Duration::from_mins(30);
        assert_ne!(session.touch(later), renewed);
    }

    #[test]
    fn timestamps_are_utc_rfc3339() {
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        assert_eq!(
            rfc3339(UNIX_EPOCH + Duration::from_hours(264_384)),
            "2000-02-29T00:00:00.000Z"
        );
    }
}
