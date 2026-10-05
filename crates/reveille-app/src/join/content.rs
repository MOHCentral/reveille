// SPDX-License-Identifier: GPL-3.0-only

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use reveille_core::content::{
    self, CatalogueCandidate, CatalogueNonResultReason, CatalogueResolutionPass, DownloadProgress,
    PakRadarDownloadProgress, PakRadarPackageStatus, ResolutionOutcome, WantedMap,
};
use reveille_core::discovery::Server;
use reveille_core::join::LaunchProfile;
use reveille_core::mapindex::MapKey;
use reveille_platform as platform;
use serde::Serialize;
use tauri::Emitter;
use tracing::{info, warn};

use super::preview::{
    JoinPreview, PakRadarPreview, PreviewCache, build_pakradar_preview, build_preview,
    cache_preview,
};
use super::track_download;
use crate::servers;
use crate::session::{Session, session_installation, session_search_path};
use crate::telemetry::{DownloadSource, Event, Telemetry};

pub const EVENT: &str = "reveille://install";

/// Bytes between download progress emissions. A 24 MB shopping list produces a few hundred events
/// rather than tens of thousands.
const DOWNLOAD_EVENT_STRIDE: u64 = 256 * 1024;

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

#[derive(Serialize)]
pub struct ServerFilesResult {
    preview: JoinPreview,
    failures: Vec<InstallFailure>,
}

/// One map that could not be installed. Structured rather than pre-formatted prose, so the
/// interface decides how to say it.
#[derive(Serialize)]
pub struct InstallFailure {
    map: String,
    reason: String,
}

/// Resolve where downloaded content goes for this session, and nothing else.
///
/// Called exactly once, and only after a shopping list proves this join will write a file. The
/// returned destination is retained through installation and reporting.
pub fn install_destination(session: &Session) -> Result<platform::InstallTarget, String> {
    let installation = session_installation(session)?;
    platform::resolve_install_target(
        &installation.root,
        LaunchProfile::new(session.game).data_directory(),
        platform::ClientKind::from(session.engine),
    )
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn install_server_files(
    session: Session,
    address: String,
    app: tauri::AppHandle,
    cache: tauri::State<'_, PreviewCache>,
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
    cache_preview(&cache, &session, preview.clone());
    Ok(ServerFilesResult { preview, failures })
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
pub async fn install_shopping_list(
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

pub fn shopping_list_will_write(
    catalogue: &CatalogueResolutionPass,
    selected: &HashSet<u64>,
) -> bool {
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
        EVENT,
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

#[cfg(test)]
mod tests {
    use reveille_core::content::{
        CatalogueCandidate, CatalogueResolution, CatalogueResolutionPass, FileSize,
        ResolutionOutcome, WantedMap,
    };
    use reveille_core::mapindex::MapKey;

    use super::{CatalogueNonResultReason, catalogue_reason, shopping_list_will_write};

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
        let install_flow = include_str!("content.rs")
            .split_once("async fn install_server_files(")
            .and_then(|(_, rest)| rest.split_once("async fn install_pakradar_manifest("))
            .map(|(flow, _)| flow)
            .expect("server-file install flow");
        let pakradar = install_flow
            .find("install_pakradar_manifest(")
            .expect("PakRadar install stage");
        let refreshed_preview = install_flow
            .find("let preview = build_preview(&session, server, Some(&app)).await?;")
            .expect("post-PakRadar preview and rescan");
        assert!(pakradar < refreshed_preview);

        let preview_flow = include_str!("preview.rs")
            .split_once("async fn build_preview(")
            .and_then(|(_, rest)| rest.split_once("async fn build_pakradar_preview("))
            .map(|(flow, _)| flow)
            .expect("preview flow");
        assert!(preview_flow.contains("wanted.is_empty() || server_stage_unresolved"));
    }
}
