// SPDX-License-Identifier: GPL-3.0-only

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
// The boundaries AGENTS.md states, made mechanical (issue #9). `cfg_attr(not(test), …)` rather
// than a bare `deny`: `cargo clippy --all-targets` compiles this crate twice, once plain and once
// with `cfg(test)`. The plain build still denies every production site, so nothing is weakened —
// but unit tests keep `unwrap`/`expect` with explicit messages, in one line here instead of an
// `#[allow]` on every `mod tests`. Integration tests are separate crates and are untouched.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::dbg_macro,
        clippy::todo,
        clippy::unimplemented,
        clippy::print_stdout,
        clippy::print_stderr,
    )
)]

//! Tauri shell. This layer owns presentation policy: it turns the pipeline's typed results into
//! payloads and progress events, and decides nothing the core has not already established.

#[cfg(windows)]
mod app_icon;
mod autostart;
mod engines;
mod installation;
mod logs;
mod notice;
mod popup;
mod self_update;
mod session;
mod telemetry;
mod tray;

use std::collections::HashSet;
use std::io;
use std::net::SocketAddrV4;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use reveille_core::content::{
    self, CatalogueCandidate, CatalogueNonResultReason, CatalogueResolutionPass, DownloadProgress,
    PakRadarDownloadProgress, PakRadarEntry, PakRadarPackageStatus, ResolutionOutcome, WantedMap,
};
use reveille_core::discovery::{
    self, BrowseConfig, BrowseEvent, BrowseSummary, DiscoveryError, MasterEndpoint, NonResult,
    NonResultReason, ProbeStage, QueryPort, RequestError, Server, TargetGame,
};
use reveille_core::engine::EngineChoice;
use reveille_core::install;
use reveille_core::join::{
    CompatibilityAssessment, CompatibilityState, CurrentMapReadiness, FsGame, LaunchCommand,
    LaunchProfile,
};
use reveille_core::mapindex::{MapIndex, MapKey};
use reveille_platform as platform;
use serde::Serialize;
use session::{Session, SessionError, installed_maps, session_installation, session_search_path};
use tauri::{Emitter, Manager};
use telemetry::{BrowseFailureKind, DownloadSource, Event, JoinFailureReason, Telemetry};
use tokio::sync::{Notify, mpsc};
use tracing::{info, warn};

/// Events the frontend listens for, kept together so the contract reads in one place.
const BROWSE_EVENT: &str = "reveille://browse";
const PREVIEW_EVENT: &str = "reveille://preview";
const INSTALL_EVENT: &str = "reveille://install";

/// Deadline for one per-server UDP probe.
///
/// The sweep and the single-server check share it deliberately: a remembered server checked on a
/// gentler deadline than the sweep uses would be listed on terms the list itself never offered.
const PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);

/// Bytes between download progress emissions. A 24 MB shopping list produces a few hundred events
/// rather than tens of thousands.
const DOWNLOAD_EVENT_STRIDE: u64 = 256 * 1024;

#[derive(Default)]
struct AppState {
    /// The servers behind the current list, keyed on by address when a join is prepared.
    servers: Mutex<Vec<Server>>,
    /// Raised to stop an in-flight sweep.
    cancel_browse: Notify,
    /// The most recent join preview, reused so a launch does not repeat the catalogue pass.
    preview: Mutex<Option<CachedPreview>>,
}

struct CachedPreview {
    install_root: PathBuf,
    engine: EngineChoice,
    game: TargetGame,
    preview: JoinPreview,
}

#[derive(Serialize)]
struct BrowserPayload {
    servers: Vec<BrowserServer>,
    summary: BrowseSummary,
    non_results: Vec<NonResultGroup>,
    cancelled: bool,
}

#[derive(Clone, Serialize)]
struct BrowserServer {
    address: SocketAddrV4,
    server: Server,
    compatibility: CompatibilityAssessment,
}

/// What checking one remembered server found.
///
/// Never an error and never an empty success: either the server answered and is now joinable, or
/// the reason it did not is recorded.
#[derive(Serialize)]
struct CheckResult {
    row: Option<BrowserServer>,
    non_result: Option<NonResultGroup>,
    /// The server answered, but for another of the three games.
    other_game: Option<TargetGame>,
}

/// Recorded non-results grouped for display. Individual reasons stay distinguishable; only the
/// repetition is collapsed.
#[derive(Serialize)]
struct NonResultGroup {
    stage: ProbeStage,
    reason: &'static str,
    detail: Option<String>,
    count: usize,
}

#[derive(Clone, Serialize)]
struct BrowseProgress {
    registered: usize,
    inspected: usize,
    probed: usize,
    answered: usize,
    non_results: usize,
    row: Option<BrowserServer>,
}

#[derive(Clone, Serialize)]
struct PreviewProgress {
    address: SocketAddrV4,
    index: usize,
    of: usize,
    map: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
enum InstallPhase {
    Downloading { received: u64, total: Option<u64> },
    Confirming,
    Installed,
    Failed { reason: String },
}

#[derive(Clone, Serialize)]
struct InstallProgress {
    map: String,
    filename: String,
    index: usize,
    of: usize,
    #[serde(flatten)]
    phase: InstallPhase,
}

#[derive(Clone, Serialize)]
struct JoinPreview {
    address: SocketAddrV4,
    server: Server,
    assessment: CompatibilityAssessment,
    pakradar: Option<PakRadarPreview>,
    catalogue: Option<CatalogueResolutionPass>,
    engine: EngineChoice,
    game: TargetGame,
}

/// Server-owned packages advertised through `pr_downloads`.
///
/// The manifest is fetched during preview, but its packages are installed only by the player's
/// separate first-stage action. A manifest failure is retained as a recorded non-result and keeps
/// the later moh-db decision gated until the server list can be checked.
#[derive(Clone, Serialize)]
struct PakRadarPreview {
    url: String,
    entries: Vec<PakRadarEntry>,
    pending: usize,
    non_result: Option<String>,
}

#[derive(Serialize)]
struct ServerFilesResult {
    preview: JoinPreview,
    failures: Vec<InstallFailure>,
}

/// One map that could not be installed. Structured rather than pre-formatted prose, so the
/// interface decides how to say it.
#[derive(Serialize)]
struct InstallFailure {
    map: String,
    reason: String,
}

/// What happened at the launch gate. A refusal always carries its reason.
#[derive(Serialize)]
#[serde(tag = "launch", rename_all = "snake_case")]
enum LaunchOutcome {
    Launched { process_id: u32 },
    Refused { reason: String },
}

#[derive(Serialize)]
struct JoinResult {
    assessment: CompatibilityAssessment,
    installed: Vec<PathBuf>,
    install_directories: Vec<PathBuf>,
    failures: Vec<InstallFailure>,
    game_directory: Option<PathBuf>,
    used_home_fallback: bool,
    engine: EngineChoice,
    game: TargetGame,
    outcome: LaunchOutcome,
}

#[derive(Clone, Debug, Serialize)]
struct BrowseFailure {
    kind: BrowseFailureKind,
    detail: String,
}

/// Separate I/O failures that establish a local networking problem from failures that can be the
/// remote master's doing. `RequestError::Network` is shared by TCP connect/read/write and the
/// per-server UDP path, so treating the whole variant as "this PC is offline" invents a cause.
fn classify_master_network_error(error: &io::Error) -> BrowseFailureKind {
    use io::ErrorKind;

    match error.kind() {
        ErrorKind::PermissionDenied
        | ErrorKind::AddrNotAvailable
        | ErrorKind::NetworkUnreachable
        | ErrorKind::HostUnreachable => BrowseFailureKind::NoNetwork,
        _ => BrowseFailureKind::MasterUnreachable,
    }
}

impl From<DiscoveryError> for BrowseFailure {
    fn from(error: DiscoveryError) -> Self {
        use BrowseFailureKind as Kind;

        let kind = match &error {
            DiscoveryError::Master { source, .. } => match source {
                RequestError::Network(source) => classify_master_network_error(source),
                RequestError::Timeout => Kind::MasterUnreachable,
                RequestError::Parse(_)
                | RequestError::EmptyMasterGreeting
                | RequestError::MasterResponseTooLarge => Kind::MasterUnreadable,
                // Encoding the validation cannot fail on any input this crate supplies, so a
                // failure here is a bug in Reveille and not a fact about the network.
                RequestError::Crypto(_) => Kind::Internal,
            },
            DiscoveryError::Task(_) => Kind::Internal,
        };
        Self {
            kind,
            detail: error.to_string(),
        }
    }
}

impl From<SessionError> for BrowseFailure {
    fn from(error: SessionError) -> Self {
        let kind = match &error {
            SessionError::Folder(_) | SessionError::GameMissing(_) => {
                BrowseFailureKind::GameUnavailable
            }
            SessionError::Engine(_) => BrowseFailureKind::EngineUnavailable,
            SessionError::Maps(_) => BrowseFailureKind::MapsUnreadable,
        };
        Self {
            kind,
            detail: error.to_string(),
        }
    }
}

/// Every other way `browse_servers` can stop: a poisoned lock or a sweep that did not finish. These
/// carry their own message and are not classified as anything about the network.
impl From<String> for BrowseFailure {
    fn from(detail: String) -> Self {
        Self {
            kind: BrowseFailureKind::Internal,
            detail,
        }
    }
}

/// Stop the sweep currently running, if any. Servers already probed are kept.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
fn cancel_browse(state: tauri::State<'_, AppState>) {
    info!("browse cancellation requested");
    state.cancel_browse.notify_one();
}

#[tauri::command]
async fn browse_servers(
    session: Session,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<BrowserPayload, BrowseFailure> {
    let (game, engine) = (session.game, session.engine);
    let result = sweep_servers(session, app, state).await;
    telemetry.track(&match &result {
        Ok(payload) => Event::ServerListLoaded {
            game,
            engine,
            server_count: payload.servers.len(),
            cancelled: payload.cancelled,
        },
        Err(failure) => Event::ServerListFailed {
            game,
            engine,
            reason: failure.kind,
        },
    });
    result
}

async fn sweep_servers(
    session: Session,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<BrowserPayload, BrowseFailure> {
    info!(game = ?session.game, "starting server browse");
    let index = installed_maps(&session)?;

    // A stop pressed just as the previous sweep ended leaves a permit behind, which would cancel
    // this one before it probed anything. Consume it: polling `notified` once resolves immediately
    // when a permit is stored and times out otherwise.
    drop(tokio::time::timeout(Duration::ZERO, state.cancel_browse.notified()).await);
    // Rows are offered to the player as they stream, so a join prepared mid-sweep must be able to
    // find its server. The list is rebuilt from the authoritative report when the sweep ends.
    state
        .servers
        .lock()
        .map_err(|_| "server list state is unavailable".to_owned())?
        .clear();

    let (sink, mut events) = mpsc::channel(64);
    let sweep = tokio::spawn(discovery::browse_streaming(
        BrowseConfig {
            target: session.game,
            limit: None,
            concurrency: 16,
            master_timeout: Duration::from_secs(15),
            probe_timeout: PROBE_TIMEOUT,
        },
        sink,
    ));

    let cancelled = stream_sweep(&app, &state, &index, &mut events).await?;
    // Dropping the receiver is what stops the sweep. It returns what it already inspected.
    drop(events);

    let report = sweep
        .await
        .map_err(|error| BrowseFailure::from(format!("the server sweep did not finish: {error}")))?
        .map_err(BrowseFailure::from)?;
    info!(
        registered = report.summary().registered,
        inspected = report.summary().inspected,
        non_results = report.summary().non_results,
        cancelled,
        "server browse finished"
    );
    let servers = report
        .outcomes
        .iter()
        .filter_map(|outcome| outcome.server.clone())
        .collect::<Vec<_>>();
    let mut rows = servers
        .iter()
        .map(|server| classified(server, &index))
        .collect::<Vec<_>>();
    // Ordered by the only quantity a server actually reports about its population.
    rows.sort_by_key(|row| {
        std::cmp::Reverse(
            row.server
                .occupancy
                .clients_reported
                .map_or(0, discovery::ClientsReported::get),
        )
    });
    *state
        .servers
        .lock()
        .map_err(|_| "server list state is unavailable".to_owned())? = servers;

    Ok(BrowserPayload {
        servers: rows,
        summary: report.summary(),
        non_results: group_non_results(
            report
                .outcomes
                .iter()
                .filter_map(|outcome| outcome.non_result.as_ref()),
        ),
        cancelled,
    })
}

/// Relay sweep events to the frontend until the sweep ends or the player stops it.
///
/// Answered servers land in the shared list as they arrive, because a player can select a row while
/// the sweep is still running and preparing that join has to be able to find the server.
///
/// Returns whether the sweep was stopped early.
async fn stream_sweep(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    index: &MapIndex,
    events: &mut mpsc::Receiver<BrowseEvent>,
) -> Result<bool, String> {
    let mut progress = BrowseProgress {
        registered: 0,
        inspected: 0,
        probed: 0,
        answered: 0,
        non_results: 0,
        row: None,
    };
    loop {
        let event = tokio::select! {
            event = events.recv() => event,
            () = state.cancel_browse.notified() => {
                info!("stopped streaming browse events after cancellation");
                return Ok(true);
            },
        };
        let Some(event) = event else {
            info!("finished streaming browse events");
            return Ok(false);
        };
        match event {
            BrowseEvent::Registered {
                registered,
                inspected,
            } => {
                progress.registered = registered;
                progress.inspected = inspected;
                progress.row = None;
            }
            BrowseEvent::Outcome(outcome) => {
                progress.probed += 1;
                progress.row = outcome
                    .server
                    .as_ref()
                    .map(|server| classified(server, index));
                if let Some(server) = outcome.server {
                    progress.answered += 1;
                    state
                        .servers
                        .lock()
                        .map_err(|_| "server list state is unavailable".to_owned())?
                        .push(server);
                } else {
                    progress.non_results += 1;
                }
            }
        }
        // A frontend that stopped listening is not an error; the sweep result is still worth having.
        drop(app.emit(BROWSE_EVENT, progress.clone()));
    }
}

/// Check one remembered server directly, with no master list involved.
///
/// A favorite is often not in the current sweep — the master never registered it, or it did not
/// answer in time. Without this the bookmark would be a dead row: `install_and_launch` resolves
/// its target out of the sweep's list, so a server missing from that list cannot be joined at all.
/// A server that answers here is merged into the same list and becomes joinable like any other.
#[tauri::command]
async fn check_server(
    session: Session,
    address: String,
    query_port: u16,
    state: tauri::State<'_, AppState>,
) -> Result<CheckResult, String> {
    info!(%address, query_port, game = ?session.game, "checking saved server");
    let address = address
        .parse::<SocketAddrV4>()
        .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
    let index = installed_maps(&session)?;
    let endpoint = MasterEndpoint {
        address: *address.ip(),
        query_port: QueryPort::new(query_port),
    };
    let outcome = discovery::inspect_endpoint(endpoint, PROBE_TIMEOUT).await;

    let Some(server) = outcome.server else {
        // Not an error. Why it did not answer is what the player asked for.
        //
        // The entry goes with it. This list is what `find_server` prepares a join from, and a check
        // that ran and got no answer is evidence about now that outranks whatever the sweep saw —
        // the same reason the shell drops the row. Leaving it would keep a join
        // preparable from figures the interface has already withdrawn.
        forget_checked_server(&state, address)?;
        return Ok(CheckResult {
            row: None,
            non_result: outcome
                .non_result
                .as_ref()
                .and_then(|non_result| group_non_results(std::iter::once(non_result)).pop()),
            other_game: None,
        });
    };
    if let Some(published) = answered_for_another_game(&server, session.game) {
        info!(published_game = ?published, "checked server answered for another game");
        // It answered, for a game this session's client cannot join. Not a joinable entry either.
        forget_checked_server(&state, address)?;
        return Ok(CheckResult {
            row: None,
            non_result: None,
            other_game: Some(published),
        });
    }
    // The server publishes its own `hostport`, so a server that moved answers at an address other
    // than the remembered one. The row carries the address it actually answered at; repointing the
    // bookmark at it would be a guess about whether it is the same server.
    let row = classified(&server, &index);
    let mut servers = state
        .servers
        .lock()
        .map_err(|_| "server list state is unavailable".to_owned())?;
    merge_checked_server(&mut servers, server);
    drop(servers);
    info!("checked server answered and was merged into active list");
    Ok(CheckResult {
        row: Some(row),
        non_result: None,
        other_game: None,
    })
}

/// Whether a game client is running now; null when the process list cannot be read.
#[tauri::command]
async fn game_client_running() -> Option<bool> {
    tokio::task::spawn_blocking(platform::game_client_running)
        .await
        .ok()
        .flatten()
}

/// What one probe of a watched server saw: enough to decide an alert and to word its toast.
#[derive(Serialize)]
struct WatchReading {
    clients: Option<u32>,
    bots: Option<u32>,
    map: Option<String>,
    mode: Option<String>,
    round_trip: u32,
}

/// Read a watched endpoint's occupancy and current round. Unlike `check_server`, this does not
/// index maps or alter the browse list behind a pending join.
#[tauri::command]
async fn read_watched_server(
    address: String,
    query_port: u16,
    game: TargetGame,
) -> Option<WatchReading> {
    let address = address.parse::<SocketAddrV4>().ok()?;
    if query_port == 0 {
        return None;
    }
    let endpoint = MasterEndpoint {
        address: *address.ip(),
        query_port: QueryPort::new(query_port),
    };
    let server = discovery::inspect_endpoint(endpoint, PROBE_TIMEOUT)
        .await
        .server?;
    if answered_for_another_game(&server, game).is_some()
        || SocketAddrV4::new(server.endpoint.address, server.game_port.get()) != address
    {
        return None;
    }
    Some(WatchReading {
        clients: server
            .occupancy
            .clients_reported
            .map(discovery::ClientsReported::get),
        bots: server
            .occupancy
            .bots_reported
            .map(discovery::BotsReported::get),
        map: server.current_map,
        mode: server.game_type,
        round_trip: server.status_round_trip.get(),
    })
}

/// The family a checked server belongs to, when it is not this session's.
///
/// A bookmark is an address, so it outlives the game it was starred under. A server that answers
/// for another family is real and reachable and still cannot be joined from this session: the
/// client this session launches speaks a different protocol and would be dropped at connect. A
/// server that publishes no family at all is not guessed about — it is listed, exactly as the
/// sweep would have listed it.
fn answered_for_another_game(server: &Server, game: TargetGame) -> Option<TargetGame> {
    server
        .game_name
        .as_deref()
        .and_then(TargetGame::from_game_name)
        .filter(|published| *published != game)
}

/// Merge a freshly checked server into the current list, replacing any entry for the same game
/// endpoint.
///
/// Appending would leave `find_server` resolving whichever copy it reached first, so a join could
/// be prepared from figures this check has already superseded.
fn merge_checked_server(servers: &mut Vec<Server>, server: Server) {
    let endpoint = (server.endpoint.address, server.game_port);
    servers.retain(|existing| (existing.endpoint.address, existing.game_port) != endpoint);
    servers.push(server);
}

/// Drop the entry for a game endpoint a check has just found nothing at.
///
/// Deliberately keyed on the game address the check was asked about, not on the query port: the
/// caller asked about one join target and learned that it is not there.
fn forget_checked_server(
    state: &tauri::State<'_, AppState>,
    address: SocketAddrV4,
) -> Result<(), String> {
    let mut servers = state
        .servers
        .lock()
        .map_err(|_| "server list state is unavailable".to_owned())?;
    servers.retain(|existing| {
        (existing.endpoint.address, existing.game_port.get()) != (*address.ip(), address.port())
    });
    Ok(())
}

/// Resolve where downloaded content goes for this session, and nothing else.
///
/// Called exactly once, and only after a shopping list proves this join will write a file. The
/// returned destination is retained through installation and reporting.
fn install_destination(session: &Session) -> Result<platform::InstallTarget, String> {
    let installation = session_installation(session)?;
    platform::resolve_install_target(
        &installation.root,
        LaunchProfile::new(session.game).data_directory(),
        platform::ClientKind::from(session.engine),
    )
    .map_err(|error| error.to_string())
}

fn classified(server: &Server, index: &MapIndex) -> BrowserServer {
    BrowserServer {
        address: SocketAddrV4::new(server.endpoint.address, server.game_port.get()),
        compatibility: reveille_core::join::classify_server(index, server, None),
        server: server.clone(),
    }
}

fn group_non_results<'a>(non_results: impl Iterator<Item = &'a NonResult>) -> Vec<NonResultGroup> {
    let mut groups: Vec<NonResultGroup> = Vec::new();
    for non_result in non_results {
        let (reason, detail) = describe_non_result(&non_result.reason);
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.stage == non_result.stage && group.reason == reason)
        {
            group.count += 1;
            continue;
        }
        groups.push(NonResultGroup {
            stage: non_result.stage,
            reason,
            detail,
            count: 1,
        });
    }
    groups.sort_by_key(|group| std::cmp::Reverse(group.count));
    groups
}

fn describe_non_result(reason: &NonResultReason) -> (&'static str, Option<String>) {
    match reason {
        NonResultReason::Timeout => ("timeout", None),
        NonResultReason::Network { message } => ("network", Some(message.clone())),
        NonResultReason::Malformed { message } => ("malformed", Some(message.clone())),
        NonResultReason::MissingHostPort => ("missing_host_port", None),
        NonResultReason::DuplicateEndpoint { game_port } => {
            ("duplicate_endpoint", Some(game_port.get().to_string()))
        }
    }
}

#[tauri::command]
async fn preview_join(
    session: Session,
    address: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<JoinPreview, String> {
    info!(%address, game = ?session.game, engine = ?session.engine, "building join preview");
    let server = find_server(&state, &address)?;
    let preview = build_preview(&session, server, Some(&app)).await?;
    cache_preview(&state, &session, preview.clone());
    Ok(preview)
}

#[tauri::command]
async fn install_server_files(
    session: Session,
    address: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<ServerFilesResult, String> {
    info!(%address, game = ?session.game, engine = ?session.engine, "installing server files");
    let server = find_server(&state, &address)?;
    let search_path = session_search_path(&session)?;
    let pakradar = build_pakradar_preview(&server, &search_path)
        .await
        .ok_or_else(|| "This server does not publish a server download list.".to_owned())?;
    let install_target = (pakradar.pending > 0)
        .then(|| install_destination(&session))
        .transpose()?;
    let (_, failures) = match &install_target {
        Some(target) => {
            telemetry.track(&Event::MapDownloadStarted {
                source: DownloadSource::ServerFiles,
                count: pakradar.pending,
            });
            let result =
                install_pakradar_manifest(&pakradar, &search_path, &target.game_directory, &app)
                    .await;
            track_download(
                &telemetry,
                DownloadSource::ServerFiles,
                &result,
                pakradar.pending,
            );
            result?
        }
        None => (
            Vec::new(),
            pakradar
                .non_result
                .as_ref()
                .map(|reason| {
                    vec![InstallFailure {
                        map: "Server download list".to_owned(),
                        reason: reason.clone(),
                    }]
                })
                .unwrap_or_default(),
        ),
    };

    // This is the stage boundary issue #6 requires: only the search path after the server files
    // have been applied is allowed to produce a moh-db price.
    let preview = build_preview(&session, server, Some(&app)).await?;
    cache_preview(&state, &session, preview.clone());
    Ok(ServerFilesResult { preview, failures })
}

#[tauri::command]
async fn install_and_launch(
    session: Session,
    address: String,
    selected_candidate_ids: Vec<u64>,
    accept_incomplete: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<JoinResult, String> {
    let (game, engine) = (session.game, session.engine);
    telemetry.track(&Event::JoinClicked {
        game,
        engine,
        accept_incomplete,
    });
    let result = join_and_launch(
        session,
        address,
        selected_candidate_ids,
        accept_incomplete,
        &app,
        &state,
        &telemetry,
    )
    .await;
    telemetry.track(&match &result {
        Ok(JoinResult {
            outcome: LaunchOutcome::Launched { .. },
            ..
        }) => Event::GameLaunched { game, engine },
        Ok(JoinResult {
            outcome: LaunchOutcome::Refused { .. },
            assessment,
            ..
        }) => Event::JoinFailed {
            game,
            engine,
            reason: refusal_reason(assessment),
        },
        Err(failure) => Event::JoinFailed {
            game,
            engine,
            reason: failure.reason,
        },
    });
    result.map_err(|failure| failure.message)
}

/// A join that stopped before the game started: the sentence the player reads, and the code the
/// telemetry sends instead of that sentence.
#[derive(Debug)]
struct JoinFailure {
    reason: JoinFailureReason,
    message: String,
}

/// Tag an error from a join step with the reason it stands for.
fn failed<E: ToString>(reason: JoinFailureReason) -> impl FnOnce(E) -> JoinFailure {
    move |error| JoinFailure {
        reason,
        message: error.to_string(),
    }
}

async fn join_and_launch(
    session: Session,
    address: String,
    selected_candidate_ids: Vec<u64>,
    accept_incomplete: bool,
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    telemetry: &Telemetry,
) -> Result<JoinResult, JoinFailure> {
    info!(
        %address,
        selected_candidates = selected_candidate_ids.len(),
        accept_incomplete,
        game = ?session.game,
        engine = ?session.engine,
        "starting install-and-launch flow"
    );
    let server = find_server(state, &address).map_err(failed(JoinFailureReason::ServerGone))?;
    let preview = match take_cached_preview(state, &session, &address) {
        Some(preview) => preview,
        None => build_preview(&session, server.clone(), Some(app))
            .await
            .map_err(failed(JoinFailureReason::Unknown))?,
    };
    let search_path =
        session_search_path(&session).map_err(failed(JoinFailureReason::GameInstallMissing))?;
    let current_pakradar = build_pakradar_preview(&server, &search_path).await;
    if current_pakradar
        .as_ref()
        .is_some_and(|pakradar| pakradar.pending > 0 || pakradar.non_result.is_some())
    {
        return Err(JoinFailure {
            reason: JoinFailureReason::ServerFilesPending,
            message:
                "Install and verify the server files before deciding whether to download anything else."
                    .to_owned(),
        });
    }
    let selected = selected_candidate_ids.into_iter().collect::<HashSet<_>>();
    let catalogue = preview.catalogue.clone();
    let install_target = catalogue
        .as_ref()
        .filter(|catalogue| shopping_list_will_write(catalogue, &selected))
        .map(|_| install_destination(&session))
        .transpose()
        .map_err(failed(JoinFailureReason::NoWritableFolder))?;
    let (installed, failures) = if let (Some(catalogue), Some(target)) =
        (&catalogue, &install_target)
    {
        telemetry.track(&Event::MapDownloadStarted {
            source: DownloadSource::Catalogue,
            count: selected.len(),
        });
        let result =
            install_shopping_list(catalogue, &selected, &server, &target.game_directory, app).await;
        track_download(
            telemetry,
            DownloadSource::Catalogue,
            &result,
            selected.len(),
        );
        result.map_err(failed(JoinFailureReason::DownloadFailed))?
    } else {
        (Vec::new(), Vec::new())
    };
    // Re-index the whole search path, not just the directory written to: the gate below asks
    // whether the engine can now find the map, and the engine reads all of it. The destination is
    // the preview's, not a fresh probe — the files went where the download put them, and that is
    // what gets reported.
    let index = installed_maps(&session).map_err(failed(JoinFailureReason::GameInstallMissing))?;
    let assessment = reveille_core::join::classify_server(&index, &server, catalogue.as_ref());
    let outcome = if let Some(reason) = launch_refusal(&assessment, accept_incomplete) {
        LaunchOutcome::Refused { reason }
    } else {
        launch(&session, preview.address)?
    };
    let install_directories = unique_parent_directories(&installed);
    info!(assessment_state = ?assessment.state, "install-and-launch flow completed");
    Ok(JoinResult {
        assessment,
        installed,
        install_directories,
        failures,
        game_directory: install_target
            .as_ref()
            .map(|target| target.game_directory.clone()),
        used_home_fallback: install_target
            .as_ref()
            .is_some_and(|target| target.used_home_fallback),
        engine: session.engine,
        game: session.game,
        outcome,
    })
}

/// Close a download batch opened with `MapDownloadStarted`.
fn track_download(
    telemetry: &Telemetry,
    source: DownloadSource,
    result: &Result<(Vec<PathBuf>, Vec<InstallFailure>), String>,
    attempted: usize,
) {
    telemetry.track(&match result {
        Ok((_, failures)) if !failures.is_empty() => Event::MapDownloadFailed {
            source,
            failed: failures.len(),
        },
        Ok((installed, _)) => Event::MapDownloadCompleted {
            source,
            installed: installed.len(),
        },
        Err(_) => Event::MapDownloadFailed {
            source,
            failed: attempted,
        },
    });
}

/// Install every missing or outdated package from the server's `pr_downloads` manifest.
///
/// Each package is checked against the engine-visible copy before downloading. Server-published
/// MD5 evidence permits an atomic replacement; one failed package is recorded and does not stop
/// the remaining packages. The caller rescans before deciding whether moh-db is needed.
#[expect(
    clippy::too_many_lines,
    reason = "per-package validation, progress, installation, and recorded failure stay in one loop"
)]
async fn install_pakradar_manifest(
    pakradar: &PakRadarPreview,
    search_path: &[PathBuf],
    game_directory: &Path,
    app: &tauri::AppHandle,
) -> Result<(Vec<PathBuf>, Vec<InstallFailure>), String> {
    let mut failures = Vec::new();
    if let Some(reason) = &pakradar.non_result {
        failures.push(InstallFailure {
            map: "Server download list".to_owned(),
            reason: reason.clone(),
        });
        return Ok((Vec::new(), failures));
    }
    let mut filenames = HashSet::new();
    let mut pending = Vec::new();
    for entry in &pakradar.entries {
        let filename = match entry.filename() {
            Ok(filename) => filename,
            Err(error) => {
                failures.push(InstallFailure {
                    map: entry.alias.clone(),
                    reason: error.to_string(),
                });
                continue;
            }
        };
        if !filenames.insert(filename.to_ascii_lowercase()) {
            continue;
        }
        match content::pakradar_entry_status(entry, search_path).await {
            Ok(PakRadarPackageStatus::Current { .. }) => {}
            Ok(PakRadarPackageStatus::Missing) => {
                pending.push((entry, filename, game_directory.to_path_buf()));
            }
            Ok(PakRadarPackageStatus::Outdated { path }) => pending.push((
                entry,
                filename,
                platform::effective_package_install_directory(&path, game_directory, search_path),
            )),
            Err(error) => failures.push(InstallFailure {
                map: entry.alias.clone(),
                reason: error.to_string(),
            }),
        }
    }
    let client =
        content::pakradar_client(Duration::from_secs(30)).map_err(|error| error.to_string())?;
    let staging = tempfile::TempDir::new().map_err(|error| error.to_string())?;
    let planned = pending.len();
    let mut installed = Vec::new();
    for (position, (entry, filename, destination)) in pending.into_iter().enumerate() {
        let progress = InstallProgress {
            map: entry.alias.clone(),
            filename,
            index: position,
            of: planned,
            phase: InstallPhase::Downloading {
                received: 0,
                total: None,
            },
        };
        let mut announced = 0_u64;
        let result: Result<PathBuf, String> = async {
            let archive = content::download_pakradar_archive_reporting(
                &client,
                entry,
                staging.path(),
                |PakRadarDownloadProgress { received, declared }| {
                    if received != 0 && received < announced.saturating_add(DOWNLOAD_EVENT_STRIDE) {
                        return;
                    }
                    announced = received;
                    emit_install(
                        app,
                        &progress,
                        InstallPhase::Downloading {
                            received,
                            total: declared,
                        },
                    );
                },
            )
            .await
            .map_err(|error| error.to_string())?;
            emit_install(app, &progress, InstallPhase::Confirming);
            content::install_verified_archive(&archive, destination)
                .map_err(|error| error.to_string())
        }
        .await;
        match result {
            Ok(path) => {
                emit_install(app, &progress, InstallPhase::Installed);
                installed.push(path);
            }
            Err(reason) => {
                emit_install(
                    app,
                    &progress,
                    InstallPhase::Failed {
                        reason: reason.clone(),
                    },
                );
                failures.push(InstallFailure {
                    map: entry.alias.clone(),
                    reason,
                });
            }
        }
    }
    Ok((installed, failures))
}

/// Download, confirm and install every candidate the player's selection resolves to.
///
/// A failure is recorded against its map and the pass continues; one unobtainable archive never
/// abandons the rest of the shopping list.
async fn install_shopping_list(
    catalogue: &CatalogueResolutionPass,
    selected: &HashSet<u64>,
    server: &Server,
    game_directory: &Path,
    app: &tauri::AppHandle,
) -> Result<(Vec<PathBuf>, Vec<InstallFailure>), String> {
    let client =
        content::MohDbClient::new(Duration::from_secs(30)).map_err(|error| error.to_string())?;
    let staging = tempfile::TempDir::new().map_err(|error| error.to_string())?;
    let mut installed = Vec::new();
    let mut failures = Vec::new();
    let mut filenames = HashSet::new();
    let planned = catalogue
        .resolutions
        .iter()
        .filter(|resolution| candidate_for_resolution(&resolution.outcome, selected).is_some())
        .count();
    info!(planned, "installing catalogue shopping list");
    let mut position = 0;
    for resolution in &catalogue.resolutions {
        let Some(candidate) = candidate_for_resolution(&resolution.outcome, selected) else {
            continue;
        };
        if !filenames.insert(candidate.filename.clone()) {
            continue;
        }
        let progress = InstallProgress {
            map: resolution.wanted.name.clone(),
            filename: candidate.filename.clone(),
            index: position,
            of: planned,
            phase: InstallPhase::Downloading {
                received: 0,
                total: Some(candidate.file_size.get()),
            },
        };
        position += 1;
        match install_candidate(
            &client,
            candidate,
            &resolution.wanted,
            server,
            staging.path(),
            game_directory,
            app.clone(),
            &progress,
        )
        .await
        {
            Ok(path) => {
                emit_install(app, &progress, InstallPhase::Installed);
                installed.push(path);
            }
            Err(reason) => {
                warn!(map = %resolution.wanted.name, %reason, "failed to install map candidate");
                emit_install(
                    app,
                    &progress,
                    InstallPhase::Failed {
                        reason: reason.clone(),
                    },
                );
                failures.push(InstallFailure {
                    map: resolution.wanted.name.clone(),
                    reason,
                });
            }
        }
    }
    failures.extend(catalogue.non_results.iter().map(|result| InstallFailure {
        map: result.wanted.name.clone(),
        reason: catalogue_reason(&result.reason),
    }));
    Ok((installed, failures))
}

/// Why one catalogue lookup produced nothing, in a sentence a player can read.
///
/// This rendered with `{:?}` until 27 Aug 2026, which put `HttpStatus { status: 503 }` in the
/// detail pane of a launcher aimed at people who have never seen a Rust enum.
/// The wording lives here rather than in `reveille-core` because how
/// a non-result is presented is policy, and the core stays free of it (AGENTS.md).
fn catalogue_reason(reason: &CatalogueNonResultReason) -> String {
    match reason {
        CatalogueNonResultReason::Timeout => "the map catalogue did not answer in time".to_owned(),
        CatalogueNonResultReason::HttpStatus { status } => {
            format!("the map catalogue refused the request (HTTP {status})")
        }
        CatalogueNonResultReason::Network { message } => {
            format!("the map catalogue could not be reached: {message}")
        }
        CatalogueNonResultReason::Malformed { message } => {
            format!("the map catalogue sent a reply Reveille could not read: {message}")
        }
    }
}

/// Start the client the detected install actually provides, connected to `address`.
fn launch(session: &Session, address: SocketAddrV4) -> Result<LaunchOutcome, JoinFailure> {
    use JoinFailureReason as Reason;

    info!(%address, game = ?session.game, engine = ?session.engine, "launching client");
    let installation =
        install::identify(&session.path).map_err(failed(Reason::GameInstallMissing))?;
    platform::engine::resolve_choice(
        &installation.root,
        Some(session.engine),
        &platform::HostCapabilities::current(),
    )
    .map_err(failed(Reason::EngineMissing))?;
    let kind = platform::ClientKind::from(session.engine);
    let profile = LaunchProfile::new(session.game);
    let program = platform::default_client(&installation.root, profile.target, kind)
        .to_string_lossy()
        .into_owned();
    let command = LaunchCommand::new(
        program,
        profile,
        FsGame::new("").map_err(failed(Reason::LaunchFailed))?,
        address,
    )
    .map_err(failed(Reason::LaunchFailed))?;
    Ok(LaunchOutcome::Launched {
        process_id: platform::launch_client(&command, kind)
            .map_err(failed(Reason::LaunchFailed))?
            .id(),
    })
}

/// Decide whether the launch may proceed, and say why when it may not.
///
/// `Compatible` needs no consent. Anything else needs the player to have accepted an incomplete
/// check — but consent cannot override the one fact that makes a join pointless: the map running
/// right now being absent, which drops the connection immediately. An unobtainable map later in
/// the rotation is not that. It costs one disconnect at one map change, and refusing the join over
/// it would invent a problem the engine does not have.
fn launch_refusal(assessment: &CompatibilityAssessment, accept_incomplete: bool) -> Option<String> {
    if matches!(assessment.state, CompatibilityState::Compatible) {
        return None;
    }
    if matches!(assessment.current_map, CurrentMapReadiness::Missing) {
        return Some(
            "The map this server is running right now is not on disk, so the join would be dropped immediately."
                .to_owned(),
        );
    }
    if accept_incomplete {
        return None;
    }
    Some("This join has not been fully checked and was not confirmed.".to_owned())
}

/// The telemetry code for a refusal [`launch_refusal`] made.
fn refusal_reason(assessment: &CompatibilityAssessment) -> JoinFailureReason {
    if matches!(assessment.current_map, CurrentMapReadiness::Missing) {
        JoinFailureReason::CurrentMapMissing
    } else {
        JoinFailureReason::Unconfirmed
    }
}

fn take_cached_preview(
    state: &tauri::State<'_, AppState>,
    session: &Session,
    address: &str,
) -> Option<JoinPreview> {
    let mut cache = state.preview.lock().ok()?;
    let usable = cache.as_ref().is_some_and(|cached| {
        cached.game == session.game
            && preview_cache_matches(
                &cached.install_root,
                cached.preview.address,
                cached.engine,
                Path::new(&session.path),
                address,
                session.engine,
            )
    });
    if !usable {
        return None;
    }
    cache.take().map(|cached| cached.preview)
}

fn cache_preview(state: &tauri::State<'_, AppState>, session: &Session, preview: JoinPreview) {
    if let Ok(mut cache) = state.preview.lock() {
        *cache = Some(CachedPreview {
            install_root: PathBuf::from(&session.path),
            engine: session.engine,
            game: session.game,
            preview,
        });
    }
}

fn unique_parent_directories(installed: &[PathBuf]) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for directory in installed.iter().filter_map(|path| path.parent()) {
        if !directories.iter().any(|existing| existing == directory) {
            directories.push(directory.to_path_buf());
        }
    }
    directories
}

fn preview_cache_matches(
    cached_root: &Path,
    cached_address: SocketAddrV4,
    cached_engine: EngineChoice,
    requested_root: &Path,
    requested_address: &str,
    requested_engine: EngineChoice,
) -> bool {
    cached_root == requested_root
        && cached_address.to_string() == requested_address
        && cached_engine == requested_engine
}

fn find_server(state: &tauri::State<'_, AppState>, address: &str) -> Result<Server, String> {
    let address = address
        .parse::<SocketAddrV4>()
        .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
    state
        .servers
        .lock()
        .map_err(|_| "server list state is unavailable".to_owned())?
        .iter()
        .find(|server| {
            SocketAddrV4::new(server.endpoint.address, server.game_port.get()) == address
        })
        .cloned()
        .ok_or_else(|| {
            "This server is no longer in the current list. Refresh and try again.".to_owned()
        })
}

async fn build_preview(
    session: &Session,
    server: Server,
    app: Option<&tauri::AppHandle>,
) -> Result<JoinPreview, String> {
    let address = SocketAddrV4::new(server.endpoint.address, server.game_port.get());
    info!(%address, game = ?session.game, engine = ?session.engine, "starting preview build");
    let index = installed_maps(session)?;
    let search_path = session_search_path(session)?;
    let first = reveille_core::join::classify_server(&index, &server, None);
    let wanted = first.preflight.as_ref().map_or_else(Vec::new, wanted_maps);
    info!(%address, wanted_maps = wanted.len(), "computed preview map requirements");
    let pakradar = build_pakradar_preview(&server, &search_path).await;
    let server_stage_unresolved = pakradar
        .as_ref()
        .is_some_and(|pakradar| pakradar.pending > 0 || pakradar.non_result.is_some());
    let catalogue = if wanted.is_empty() || server_stage_unresolved {
        None
    } else {
        let client = content::MohDbClient::new(Duration::from_secs(15))
            .map_err(|error| error.to_string())?;
        Some(
            client
                .resolve_all_reporting(&wanted, |progress| {
                    let Some(app) = app else {
                        return;
                    };
                    let map = match progress.resolved {
                        Ok(resolution) => resolution.wanted.name.clone(),
                        Err(non_result) => non_result.wanted.name.clone(),
                    };
                    drop(app.emit(
                        PREVIEW_EVENT,
                        PreviewProgress {
                            address,
                            index: progress.index,
                            of: progress.of,
                            map,
                        },
                    ));
                })
                .await,
        )
    };
    let assessment = reveille_core::join::classify_server(
        &index,
        &server,
        (!server_stage_unresolved)
            .then_some(catalogue.as_ref())
            .flatten(),
    );
    Ok(JoinPreview {
        address,
        server,
        assessment,
        pakradar,
        catalogue,
        engine: session.engine,
        game: session.game,
    })
}

async fn build_pakradar_preview(
    server: &Server,
    search_path: &[PathBuf],
) -> Option<PakRadarPreview> {
    let url = server.pr_downloads.as_ref()?.clone();
    let entries = match content::fetch_filelist(&url, Duration::from_secs(15)).await {
        Ok(entries) => entries,
        Err(error) => {
            return Some(PakRadarPreview {
                url,
                entries: Vec::new(),
                pending: 0,
                non_result: Some(error.to_string()),
            });
        }
    };
    let mut pending = 0;
    let mut filenames = HashSet::new();
    for entry in &entries {
        let key = entry.filename().map_or_else(
            |_| entry.url.to_ascii_lowercase(),
            |filename| filename.to_ascii_lowercase(),
        );
        if !filenames.insert(key) {
            continue;
        }
        if !matches!(
            content::pakradar_entry_is_current(entry, search_path).await,
            Ok(true)
        ) {
            pending += 1;
        }
    }
    Some(PakRadarPreview {
        url,
        entries,
        pending,
        non_result: None,
    })
}

fn wanted_maps(preflight: &reveille_core::preflight::Report) -> Vec<WantedMap> {
    preflight
        .maps
        .iter()
        .filter(|map| {
            matches!(
                map.status,
                reveille_core::preflight::MapStatus::Absent
                    | reveille_core::preflight::MapStatus::ChecksumDiffers { .. }
            )
        })
        .filter_map(|map| WantedMap::new(map.map.clone()))
        .collect()
}

fn shopping_list_will_write(catalogue: &CatalogueResolutionPass, selected: &HashSet<u64>) -> bool {
    catalogue
        .resolutions
        .iter()
        .any(|resolution| candidate_for_resolution(&resolution.outcome, selected).is_some())
}

fn candidate_for_resolution<'a>(
    outcome: &'a ResolutionOutcome,
    selected: &HashSet<u64>,
) -> Option<&'a CatalogueCandidate> {
    match outcome {
        ResolutionOutcome::Exact { name_match, .. } => Some(name_match),
        ResolutionOutcome::ChoiceRequired { choices } => choices
            .iter()
            .find(|candidate| selected.contains(&candidate.id)),
        ResolutionOutcome::NoSource => None,
    }
}

fn emit_install(app: &tauri::AppHandle, progress: &InstallProgress, phase: InstallPhase) {
    drop(app.emit(
        INSTALL_EVENT,
        InstallProgress {
            map: progress.map.clone(),
            filename: progress.filename.clone(),
            index: progress.index,
            of: progress.of,
            phase,
        },
    ));
}

#[expect(
    clippy::too_many_arguments,
    reason = "one download: what to fetch, what it is for, where it lands, and where to report it"
)]
async fn install_candidate(
    client: &content::MohDbClient,
    candidate: &CatalogueCandidate,
    wanted: &WantedMap,
    server: &Server,
    staging: &Path,
    game_directory: &Path,
    app: tauri::AppHandle,
    progress: &InstallProgress,
) -> Result<PathBuf, String> {
    info!(
        map = %wanted.name,
        candidate = %candidate.filename,
        "installing map candidate"
    );
    let mut announced = 0_u64;
    let archive = content::download_mohdb_archive_reporting(
        client,
        candidate,
        staging,
        |DownloadProgress { received, declared }| {
            if received != 0 && received < announced.saturating_add(DOWNLOAD_EVENT_STRIDE) {
                return;
            }
            announced = received;
            emit_install(
                &app,
                progress,
                InstallPhase::Downloading {
                    received,
                    total: declared.or_else(|| Some(candidate.file_size.get())),
                },
            );
        },
    )
    .await
    .map_err(|error| error.to_string())?;
    emit_install(&app, progress, InstallPhase::Confirming);
    let inspection = content::inspect_archive(&archive.path).map_err(|error| error.to_string())?;
    let checksum = server
        .current_map
        .as_deref()
        .filter(|current| MapKey::new(current) == Some(wanted.key.clone()))
        .and(server.map_checksum);
    content::confirm_map(&inspection, &wanted.name, checksum).map_err(|error| error.to_string())?;
    let installed =
        content::install_archive(&archive, game_directory).map_err(|error| error.to_string())?;
    info!(installed_path = %installed.display(), map = %wanted.name, "installed map candidate");
    Ok(installed)
}

fn main() {
    // The one exemption to the crate's `expect_used` deny, and the narrowest form of it: a
    // statement attribute on the last statement of an executable `main`, where a failed Tauri run
    // has no caller to return to and no window in which to report anything. AGENTS.md names this
    // boundary; this is it.
    //
    // `#[allow]`, not `#[expect]`. Under `cfg(test)` the lint is not enabled, so the expectation
    // would go unfulfilled and `unfulfilled_lint_expectations` — a warning, and `-D warnings` is
    // the gate — would fail the build.
    #[allow(
        clippy::expect_used,
        reason = "executable main boundary: a failed run has no caller to return to"
    )]
    tauri::Builder::default()
        // First, so a second launch hands over before any other plugin starts. Clicking a Windows
        // toast launches Reveille again, which is how a hidden window comes back.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|arg| arg == autostart::BACKGROUND_ARG) {
                tray::show_main(app);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(self_update::PUBLIC_KEY)
                .build(),
        )
        .setup(|app| {
            logs::init(app);
            app.manage(AppState::default());
            app.manage(telemetry::commands::init_telemetry(app));
            app.manage(tray::TrayState::default());
            app.manage(popup::PopupState::default());
            #[cfg(windows)]
            if let Some(window) = app.get_webview_window("main") {
                window.set_icon(app_icon::window(window.scale_factor()?))?;
            }
            if autostart::in_background() {
                tray::start_hidden(app.handle());
            }
            installation::register(app);
            engines::register(app);
            self_update::register(app);
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            installation::detect_install,
            installation::identify_install,
            engines::engine_overview,
            engines::select_engine,
            engines::reborn::install_reborn,
            engines::reborn::cancel_reborn_install,
            engines::openmohaa::openmohaa_status,
            engines::openmohaa::install_openmohaa,
            engines::openmohaa::cancel_openmohaa_install,
            installation::copy::installation_storage,
            installation::copy::pick_copy_destination,
            installation::copy::copy_game_installation,
            installation::copy::cancel_game_installation_copy,
            installation::pick_install_folder,
            cancel_browse,
            browse_servers,
            check_server,
            read_watched_server,
            game_client_running,
            notice::send_player_notification,
            notice::send_reveille_notice,
            notice::open_notification_settings,
            popup::popup_supported,
            popup::show_alert_popup,
            popup::alert_popup_ready,
            popup::fit_alert_popup,
            popup::alert_popup_action,
            autostart::start_at_login,
            autostart::set_start_at_login,
            preview_join,
            install_server_files,
            install_and_launch,
            self_update::check_reveille_update,
            self_update::install_reveille_update,
            self_update::cancel_reveille_update,
            tray::set_close_to_tray,
            tray::set_tray_tooltip,
            logs::app_log_files,
            telemetry::commands::telemetry_status,
            telemetry::commands::set_telemetry_shared,
            telemetry::commands::track_event
        ])
        .run(tauri::generate_context!())
        .expect("error while running Reveille");
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::path::Path;

    use reveille_core::bsp::Checksum;
    use reveille_core::content::{
        CatalogueCandidate, CatalogueResolution, CatalogueResolutionPass, FileSize,
        ResolutionOutcome, WantedMap,
    };
    use reveille_core::discovery::ParseError;
    use reveille_core::join::{
        CompatibilityAssessment, CompatibilityState, CurrentMapReadiness, MapsNeeded,
    };
    use reveille_core::mapindex::MapKey;
    use reveille_core::preflight::{MapResult, MapStatus, Report, Verdict};
    use tempfile::TempDir;

    use super::{
        BrowseFailure, BrowseFailureKind, CatalogueNonResultReason, DiscoveryError, EngineChoice,
        JoinFailureReason, MasterEndpoint, QueryPort, RequestError, Server, Session, TargetGame,
        answered_for_another_game, catalogue_reason, failed, installed_maps, launch_refusal,
        merge_checked_server, platform, preview_cache_matches, refusal_reason,
        shopping_list_will_write,
    };

    fn assessment(
        state: CompatibilityState,
        current_map: CurrentMapReadiness,
    ) -> CompatibilityAssessment {
        CompatibilityAssessment {
            state,
            preflight: Some(Report {
                verdict: Verdict::Compatible,
                maps: vec![MapResult {
                    map: "dm/mohdm6".to_owned(),
                    status: MapStatus::Present {
                        checksum: Checksum::new(1),
                        checksum_checked: false,
                    },
                }],
            }),
            current_map,
        }
    }

    #[test]
    fn a_saved_session_that_no_longer_fits_the_pc_is_not_reported_as_internal() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::write(
            platform::default_client(
                temporary.path(),
                TargetGame::AlliedAssault,
                platform::ClientKind::OpenMohaa,
            ),
            [],
        )
        .expect("client marker");
        let path = temporary.path().to_string_lossy().into_owned();
        let browse_kind = |path: &str, engine, game| {
            let error = installed_maps(&Session {
                path: path.to_owned(),
                engine,
                game,
            })
            .expect_err("the session is refused");
            BrowseFailure::from(error).kind
        };

        assert_eq!(
            browse_kind(
                &temporary.path().join("moved").to_string_lossy(),
                EngineChoice::Openmohaa,
                TargetGame::AlliedAssault,
            ),
            BrowseFailureKind::GameUnavailable
        );
        assert_eq!(
            browse_kind(&path, EngineChoice::Openmohaa, TargetGame::Spearhead),
            BrowseFailureKind::GameUnavailable
        );
        assert_eq!(
            browse_kind(&path, EngineChoice::Reborn, TargetGame::AlliedAssault),
            BrowseFailureKind::EngineUnavailable
        );
    }

    fn catalogue_candidate(id: u64) -> CatalogueCandidate {
        CatalogueCandidate {
            id,
            map_name: "dm/missing".to_owned(),
            map_key: MapKey::new("dm/missing").expect("map key"),
            filename: "missing.pk3".to_owned(),
            file_size: FileSize::new(1),
            map_file_tested: true,
            downloads: 1,
            download_url: "https://example.invalid/missing.pk3".to_owned(),
        }
    }

    fn catalogue_with(outcome: ResolutionOutcome) -> CatalogueResolutionPass {
        CatalogueResolutionPass {
            resolutions: vec![CatalogueResolution {
                wanted: WantedMap::new("dm/missing").expect("wanted map"),
                hits: 1,
                outcome,
            }],
            non_results: Vec::new(),
        }
    }

    #[test]
    fn a_writable_target_is_needed_only_for_a_candidate_that_will_be_installed() {
        let selected = std::collections::HashSet::new();
        assert!(!shopping_list_will_write(
            &catalogue_with(ResolutionOutcome::NoSource),
            &selected,
        ));
        assert!(!shopping_list_will_write(
            &catalogue_with(ResolutionOutcome::ChoiceRequired {
                choices: vec![catalogue_candidate(7)],
            }),
            &selected,
        ));

        let selected = [7].into_iter().collect();
        assert!(shopping_list_will_write(
            &catalogue_with(ResolutionOutcome::ChoiceRequired {
                choices: vec![catalogue_candidate(7)],
            }),
            &selected,
        ));
        assert!(shopping_list_will_write(
            &catalogue_with(ResolutionOutcome::Exact {
                name_match: catalogue_candidate(8),
                alternatives: Vec::new(),
            }),
            &std::collections::HashSet::new(),
        ));
    }

    /// The minimum of a `Server` this test needs: the two fields that identify a game endpoint,
    /// plus a hostname to tell two answers apart.
    fn probed(address: &str, query_port: u16, game_port: u16, hostname: &str) -> Server {
        Server {
            endpoint: MasterEndpoint {
                address: address.parse().expect("address"),
                query_port: QueryPort::new(query_port),
            },
            game_port: reveille_core::discovery::GamePort::new(game_port),
            hostname: hostname.to_owned(),
            game_name: None,
            game_version: None,
            version: None,
            protocol: None,
            current_map: None,
            game_type: None,
            rotation: Vec::new(),
            allow_download: None,
            map_checksum: None,
            pr_downloads: None,
            minimum_ping: None,
            maximum_ping: None,
            join_window: None,
            reserved_slots: None,
            occupancy: reveille_core::discovery::ReportedOccupancy::default(),
            client_capacity: None,
            players: Vec::new(),
            pure: None,
            status_round_trip: reveille_core::discovery::RoundTripMillis::new(12),
        }
    }

    #[test]
    fn a_checked_server_from_another_game_is_named_rather_than_listed() {
        let mut server = probed("10.0.0.1", 12300, 12203, "a Spearhead server");
        server.game_name = Some("mohaas".to_owned());

        // Browsing Spearhead, this is an ordinary row.
        assert_eq!(
            answered_for_another_game(&server, TargetGame::Spearhead),
            None
        );
        // Browsing Allied Assault, it answered — for something this session cannot join.
        assert_eq!(
            answered_for_another_game(&server, TargetGame::AlliedAssault),
            Some(TargetGame::Spearhead)
        );

        // A server that publishes no family is not guessed about. The sweep would have listed it,
        // and so does a check.
        server.game_name = None;
        assert_eq!(
            answered_for_another_game(&server, TargetGame::AlliedAssault),
            None
        );
        // Neither is one whose family is not a MOHAA family at all.
        server.game_name = Some("quake3".to_owned());
        assert_eq!(
            answered_for_another_game(&server, TargetGame::AlliedAssault),
            None
        );
    }

    #[test]
    fn checking_a_server_replaces_its_entry_rather_than_adding_a_second() {
        let mut servers = vec![
            probed("10.0.0.1", 12300, 12203, "stale"),
            probed("10.0.0.2", 12300, 12203, "another server"),
        ];

        merge_checked_server(&mut servers, probed("10.0.0.1", 12300, 12203, "fresh"));

        assert_eq!(servers.len(), 2);
        // `find_server` takes the first match, so a stale copy left behind would be the one a join
        // is prepared from.
        assert!(servers.iter().all(|server| server.hostname != "stale"));
        assert!(servers.iter().any(|server| server.hostname == "fresh"));
        assert!(
            servers
                .iter()
                .any(|server| server.hostname == "another server")
        );
    }

    #[test]
    fn a_server_reregistered_under_a_new_query_port_leaves_no_duplicate_game_endpoint() {
        // The master can hand out a different query port for the same server. Identity is the
        // game endpoint, because that is what a join connects to.
        let mut servers = vec![probed("10.0.0.1", 12300, 12203, "stale")];

        merge_checked_server(&mut servers, probed("10.0.0.1", 12400, 12203, "fresh"));

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].hostname, "fresh");
    }

    #[test]
    fn a_server_that_moved_to_another_game_port_is_kept_alongside_the_old_entry() {
        // Different game endpoint, so it is a different join target. Collapsing the two would be
        // a guess that the server merely moved rather than that a second one exists.
        let mut servers = vec![probed("10.0.0.1", 12300, 12203, "old port")];

        merge_checked_server(&mut servers, probed("10.0.0.1", 12300, 12204, "new port"));

        assert_eq!(servers.len(), 2);
    }

    #[test]
    fn compatible_launches_without_consent() {
        let ready = assessment(
            CompatibilityState::Compatible,
            CurrentMapReadiness::Playable,
        );

        assert_eq!(launch_refusal(&ready, false), None);
    }

    #[test]
    fn preview_cache_identity_includes_the_engine_choice() {
        let root = Path::new(r"C:\Games\MOHAA");
        let address = "127.0.0.1:12203".parse().expect("address");
        assert!(preview_cache_matches(
            root,
            address,
            reveille_core::engine::EngineChoice::Original,
            root,
            "127.0.0.1:12203",
            reveille_core::engine::EngineChoice::Original,
        ));
        assert!(!preview_cache_matches(
            root,
            address,
            reveille_core::engine::EngineChoice::Original,
            root,
            "127.0.0.1:12203",
            reveille_core::engine::EngineChoice::Reborn,
        ));
    }

    #[test]
    fn an_unobtainable_map_later_in_the_rotation_does_not_block_a_join() {
        // The server is running a map that is on disk. One map with no source further
        // along the rotation costs a disconnect at one map change, which is the player's
        // call to make — not a reason for the launcher to refuse.
        let no_source = assessment(
            CompatibilityState::NoSource {
                count: MapsNeeded::new(1),
            },
            CurrentMapReadiness::Playable,
        );

        assert_eq!(launch_refusal(&no_source, true), None);
        assert!(launch_refusal(&no_source, false).is_some());
    }

    #[test]
    fn consent_cannot_override_the_map_running_right_now_being_absent() {
        for state in [
            CompatibilityState::NoSource {
                count: MapsNeeded::new(1),
            },
            CompatibilityState::NeedsMaps {
                count: MapsNeeded::new(3),
                shopping_list: None,
            },
        ] {
            let dropped_on_arrival = assessment(state, CurrentMapReadiness::Missing);

            let refusal = launch_refusal(&dropped_on_arrival, true);

            assert!(refusal.is_some_and(|reason| reason.contains("right now")));
        }
    }

    #[test]
    fn an_unpublished_rotation_needs_explicit_consent() {
        let cant_tell = assessment(CompatibilityState::CantTell, CurrentMapReadiness::Unknown);

        assert!(launch_refusal(&cant_tell, false).is_some());
        assert_eq!(launch_refusal(&cant_tell, true), None);
    }

    #[test]
    fn a_refused_join_is_reported_by_why_it_was_refused() {
        let dropped_on_arrival = assessment(
            CompatibilityState::NoSource {
                count: MapsNeeded::new(1),
            },
            CurrentMapReadiness::Missing,
        );
        let unconfirmed = assessment(CompatibilityState::CantTell, CurrentMapReadiness::Unknown);

        assert_eq!(
            refusal_reason(&dropped_on_arrival),
            JoinFailureReason::CurrentMapMissing
        );
        assert_eq!(refusal_reason(&unconfirmed), JoinFailureReason::Unconfirmed);
    }

    #[test]
    fn a_join_failure_keeps_the_players_message_beside_its_code() {
        let failure = failed(JoinFailureReason::ServerGone)(
            "This server is no longer in the current list.".to_owned(),
        );

        assert_eq!(failure.reason, JoinFailureReason::ServerGone);
        assert_eq!(
            failure.message,
            "This server is no longer in the current list."
        );
    }

    #[test]
    fn a_sweep_failure_says_which_of_the_four_things_went_wrong() {
        // The whole point of classifying here rather than in JavaScript: a local networking
        // failure, a master that is down, and a master whose reply was truncated are different
        // situations, and matching on message text is how they became one unreadable line in the
        // status bar.
        let unreadable = BrowseFailure::from(DiscoveryError::Master {
            target: TargetGame::AlliedAssault,
            source: RequestError::Parse(ParseError::MisalignedMasterBody { length: 42 }),
        });
        assert_eq!(unreadable.kind, BrowseFailureKind::MasterUnreadable);

        let silent = BrowseFailure::from(DiscoveryError::Master {
            target: TargetGame::AlliedAssault,
            source: RequestError::Timeout,
        });
        assert_eq!(silent.kind, BrowseFailureKind::MasterUnreachable);

        let offline = BrowseFailure::from(DiscoveryError::Master {
            target: TargetGame::AlliedAssault,
            source: RequestError::Network(io::Error::from(io::ErrorKind::PermissionDenied)),
        });
        assert_eq!(offline.kind, BrowseFailureKind::NoNetwork);

        // Refusal and reset are observations about the remote TCP exchange, not evidence that the
        // player's PC is offline. Both used to be folded into `NoNetwork` with every other I/O
        // error because `fetch_master` wraps connect, read, and write failures in one variant.
        let master_io_failure = |kind| {
            BrowseFailure::from(DiscoveryError::Master {
                target: TargetGame::AlliedAssault,
                source: RequestError::Network(io::Error::from(kind)),
            })
            .kind
        };
        assert_eq!(
            master_io_failure(io::ErrorKind::ConnectionRefused),
            BrowseFailureKind::MasterUnreachable
        );
        assert_eq!(
            master_io_failure(io::ErrorKind::ConnectionReset),
            BrowseFailureKind::MasterUnreachable
        );

        // Whatever the classification, the original message survives for a bug report. It is
        // simply no longer the only thing the player is given.
        assert!(unreadable.detail.contains("42"));
    }

    #[test]
    fn a_catalogue_non_result_reads_as_a_sentence() {
        // It rendered as `HttpStatus { status: 503 }` in the detail pane until 27 Aug 2026.
        let refused = catalogue_reason(&CatalogueNonResultReason::HttpStatus { status: 503 });

        assert!(refused.contains("503"));
        assert!(!refused.contains('{'));
        assert!(
            !catalogue_reason(&CatalogueNonResultReason::Timeout).contains("Timeout"),
            "a player-facing reason must not carry the variant name"
        );
    }

    #[test]
    fn server_packages_are_applied_and_rescanned_before_mohdb_is_priced() {
        let source = include_str!("main.rs");
        let install_flow = source
            .split_once("async fn install_server_files(")
            .and_then(|(_, rest)| rest.split_once("async fn install_and_launch("))
            .map(|(flow, _)| flow)
            .expect("server-file install flow");
        let pakradar = install_flow
            .find("install_pakradar_manifest(")
            .expect("PakRadar install stage");
        let refreshed_preview = install_flow
            .find("let preview = build_preview(&session, server, Some(&app)).await?;")
            .expect("post-PakRadar preview and rescan");
        assert!(pakradar < refreshed_preview);

        let preview_flow = source
            .split_once("async fn build_preview(")
            .and_then(|(_, rest)| rest.split_once("async fn build_pakradar_preview("))
            .map(|(flow, _)| flow)
            .expect("preview flow");
        assert!(preview_flow.contains("wanted.is_empty() || server_stage_unresolved"));
    }
}
