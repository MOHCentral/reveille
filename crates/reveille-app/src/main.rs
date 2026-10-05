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
mod servers;
mod session;
mod telemetry;
mod tray;

use std::collections::HashSet;
use std::net::SocketAddrV4;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use reveille_core::content::{
    self, CatalogueCandidate, CatalogueNonResultReason, CatalogueResolutionPass, DownloadProgress,
    PakRadarDownloadProgress, PakRadarEntry, PakRadarPackageStatus, ResolutionOutcome, WantedMap,
};
use reveille_core::discovery::{self, MasterEndpoint, QueryPort, Server, TargetGame};
use reveille_core::engine::EngineChoice;
use reveille_core::install;
use reveille_core::join::{
    CompatibilityAssessment, CompatibilityState, CurrentMapReadiness, FsGame, LaunchCommand,
    LaunchProfile,
};
use reveille_core::mapindex::MapKey;
use reveille_platform as platform;
use serde::Serialize;
use servers::PROBE_TIMEOUT;
use servers::check::answered_for_another_game;
use session::{Session, installed_maps, session_installation, session_search_path};
use tauri::{Emitter, Manager};
use telemetry::{DownloadSource, Event, JoinFailureReason, Telemetry};
use tracing::{info, warn};

/// Events the frontend listens for, kept together so the contract reads in one place.
const PREVIEW_EVENT: &str = "reveille://preview";
const INSTALL_EVENT: &str = "reveille://install";

/// Bytes between download progress emissions. A 24 MB shopping list produces a few hundred events
/// rather than tens of thousands.
const DOWNLOAD_EVENT_STRIDE: u64 = 256 * 1024;

#[derive(Default)]
struct AppState {
    /// The most recent join preview, reused so a launch does not repeat the catalogue pass.
    preview: Mutex<Option<CachedPreview>>,
}

struct CachedPreview {
    install_root: PathBuf,
    engine: EngineChoice,
    game: TargetGame,
    preview: JoinPreview,
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

#[tauri::command]
async fn preview_join(
    session: Session,
    address: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    listing: tauri::State<'_, servers::Listing>,
) -> Result<JoinPreview, String> {
    info!(%address, game = ?session.game, engine = ?session.engine, "building join preview");
    let server = listing.find(&address)?;
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
    listing: tauri::State<'_, servers::Listing>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<ServerFilesResult, String> {
    info!(%address, game = ?session.game, engine = ?session.engine, "installing server files");
    let server = listing.find(&address)?;
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
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri commands take each managed state as its own parameter"
)]
async fn install_and_launch(
    session: Session,
    address: String,
    selected_candidate_ids: Vec<u64>,
    accept_incomplete: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    listing: tauri::State<'_, servers::Listing>,
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
        &listing,
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

#[expect(
    clippy::too_many_arguments,
    reason = "one join: what the player chose, the states it reads, and where it reports"
)]
async fn join_and_launch(
    session: Session,
    address: String,
    selected_candidate_ids: Vec<u64>,
    accept_incomplete: bool,
    app: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    listing: &servers::Listing,
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
    let server = listing
        .find(&address)
        .map_err(failed(JoinFailureReason::ServerGone))?;
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
            servers::register(app);
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
            servers::browse::cancel_browse,
            servers::browse::browse_servers,
            servers::check::check_server,
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
    use std::path::Path;

    use reveille_core::bsp::Checksum;
    use reveille_core::content::{
        CatalogueCandidate, CatalogueResolution, CatalogueResolutionPass, FileSize,
        ResolutionOutcome, WantedMap,
    };
    use reveille_core::join::{
        CompatibilityAssessment, CompatibilityState, CurrentMapReadiness, MapsNeeded,
    };
    use reveille_core::mapindex::MapKey;
    use reveille_core::preflight::{MapResult, MapStatus, Report, Verdict};

    use super::{
        CatalogueNonResultReason, JoinFailureReason, catalogue_reason, failed, launch_refusal,
        preview_cache_matches, refusal_reason, shopping_list_will_write,
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
