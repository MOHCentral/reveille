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
use tauri::ipc::Channel;
use tracing::{info, warn};

use super::preview::{
    JoinPreview, PakRadarPreview, PreviewCache, PreviewHost, PreviewProgress,
    build_pakradar_preview, build_preview, cache_preview,
};
use super::{Shell, track_download};
use crate::servers;
use crate::session::{Session, session_installation};
use crate::telemetry::{DownloadSource, Event, Telemetry};

pub const EVENT: &str = "reveille://install";

/// Bytes between download progress emissions. A 24 MB shopping list produces a few hundred events
/// rather than tens of thousands.
const DOWNLOAD_EVENT_STRIDE: u64 = 256 * 1024;

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum InstallPhase {
    Downloading { received: u64, total: Option<u64> },
    Confirming,
    Installed,
    Failed { reason: String },
}

#[derive(Clone, Serialize)]
pub struct InstallProgress {
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

/// What installing server files reads and reports outside the join: where packages go, the
/// telemetry, and the window that shows each package's progress.
pub trait ContentHost: PreviewHost {
    fn game_directory(&self) -> Result<PathBuf, String>;
    fn telemetry(&self) -> &Telemetry;
    fn report_install(&self, progress: &InstallProgress, phase: InstallPhase);
}

/// Install the server's own files, then price the join again against the search path they changed.
///
/// That second preview streams over `on_preview_progress`; the downloads stay on [`EVENT`].
#[tauri::command]
pub async fn install_server_files(
    session: Session,
    address: String,
    on_preview_progress: Channel<PreviewProgress>,
    app: tauri::AppHandle,
    cache: tauri::State<'_, PreviewCache>,
    listing: tauri::State<'_, servers::Listing>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<ServerFilesResult, String> {
    info!(%address, game = ?session.game, engine = ?session.engine, "installing server files");
    let server = listing.find(&address, session.game)?;
    let result = apply_server_files(
        &Shell::new(&session, &app, Some(&on_preview_progress), &telemetry),
        server,
    )
    .await?;
    cache_preview(&cache, &session, result.preview.clone());
    Ok(result)
}

async fn apply_server_files(
    host: &impl ContentHost,
    server: Server,
) -> Result<ServerFilesResult, String> {
    let search_path = host.search_path()?;
    let pakradar = build_pakradar_preview(&server, &search_path)
        .await
        .ok_or_else(|| "This server does not publish a server download list.".to_owned())?;
    let game_directory = (pakradar.pending > 0)
        .then(|| host.game_directory())
        .transpose()?;
    let (_, failures) = match &game_directory {
        Some(game_directory) => {
            host.telemetry().track(&Event::MapDownloadStarted {
                source: DownloadSource::ServerFiles,
                count: pakradar.pending,
            });
            let result =
                install_pakradar_manifest(&pakradar, &search_path, game_directory, host).await;
            track_download(
                host.telemetry(),
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
    let preview = build_preview(host, server).await?;
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
    host: &impl ContentHost,
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
                    host.report_install(
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
            host.report_install(&progress, InstallPhase::Confirming);
            content::install_verified_archive(&archive, destination)
                .map_err(|error| error.to_string())
        }
        .await;
        match result {
            Ok(path) => {
                host.report_install(&progress, InstallPhase::Installed);
                installed.push(path);
            }
            Err(reason) => {
                host.report_install(
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

pub fn emit_install(app: &tauri::AppHandle, progress: &InstallProgress, phase: InstallPhase) {
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

    use std::fs;
    use std::io::{Cursor, Write};
    use std::net::{Ipv4Addr, SocketAddrV4};
    use std::path::PathBuf;
    use std::sync::Mutex;

    use md5::{Digest, Md5};
    use reveille_core::discovery::{
        GamePort, MasterEndpoint, QueryPort, ReportedOccupancy, RoundTripMillis, Server, TargetGame,
    };
    use reveille_core::engine::EngineChoice;
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::{
        CatalogueNonResultReason, ContentHost, InstallPhase, InstallProgress, PreviewHost,
        apply_server_files, build_preview, catalogue_reason, shopping_list_will_write,
    };
    use crate::telemetry::Telemetry;

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

    /// A game folder and a moh-db that records what it was asked to price instead of answering.
    struct Fixture {
        _root: TempDir,
        main: PathBuf,
        priced: Mutex<Vec<Vec<String>>>,
        telemetry: Telemetry,
    }

    impl Fixture {
        fn new() -> Self {
            let root = TempDir::new().expect("temporary directory");
            let main = root.path().join("main");
            fs::create_dir(&main).expect("main directory");
            Self {
                _root: root,
                main,
                priced: Mutex::new(Vec::new()),
                telemetry: Telemetry::unavailable("0.0.0".to_owned()),
            }
        }

        fn priced(&self) -> Vec<Vec<String>> {
            self.priced.lock().expect("priced lookups").clone()
        }
    }

    impl PreviewHost for Fixture {
        fn engine(&self) -> EngineChoice {
            EngineChoice::Original
        }

        fn game(&self) -> TargetGame {
            TargetGame::AlliedAssault
        }

        fn search_path(&self) -> Result<Vec<PathBuf>, String> {
            Ok(vec![self.main.clone()])
        }

        fn price(
            &self,
            _address: SocketAddrV4,
            wanted: &[WantedMap],
        ) -> impl Future<Output = Result<CatalogueResolutionPass, String>> {
            self.priced
                .lock()
                .expect("priced lookups")
                .push(wanted.iter().map(|map| map.name.clone()).collect());
            std::future::ready(Ok(CatalogueResolutionPass::default()))
        }
    }

    impl ContentHost for Fixture {
        fn game_directory(&self) -> Result<PathBuf, String> {
            Ok(self.main.clone())
        }

        fn telemetry(&self) -> &Telemetry {
            &self.telemetry
        }

        fn report_install(&self, _progress: &InstallProgress, _phase: InstallPhase) {}
    }

    /// A server package holding one map, as the server's own download host would serve it.
    fn package(map: &str) -> Vec<u8> {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(format!("maps/{map}.bsp"), SimpleFileOptions::default())
            .expect("start entry");
        let mut header = *b"2015\x13\0\0\0\0\0\0\0";
        header[8..12].copy_from_slice(&42_i32.to_le_bytes());
        archive.write_all(&header).expect("write BSP");
        archive.finish().expect("finish archive").into_inner()
    }

    /// Serve a `pr_downloads` manifest and its one package on loopback, so the `PakRadar` stage runs
    /// its real HTTP path without leaving the machine.
    async fn serve_server_files(package: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let base = format!("http://{}", listener.local_addr().expect("address"));
        let manifest = format!(
            "map {{\n  alias \"Custom pack\"\n  md5 \"{:x}\"\n  url \"{base}/custom.pk3\"\n}}\n",
            Md5::digest(&package)
        );
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let mut request = vec![0; 4096];
                let read = stream.read(&mut request).await.expect("request");
                let request = String::from_utf8_lossy(&request[..read]);
                let body = if request.starts_with("GET /custom.pk3 ") {
                    package.clone()
                } else {
                    manifest.clone().into_bytes()
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).await.expect("head");
                stream.write_all(&body).await.expect("body");
            }
        });
        format!("{base}/filelist.txt")
    }

    fn server(pr_downloads: String) -> Server {
        Server {
            endpoint: MasterEndpoint {
                address: Ipv4Addr::LOCALHOST,
                query_port: QueryPort::new(12_300),
            },
            game_port: GamePort::new(12_203),
            hostname: "fixture".to_owned(),
            game_name: Some("mohaa".to_owned()),
            game_version: None,
            version: None,
            protocol: Some("8".to_owned()),
            current_map: Some("dm/custom".to_owned()),
            game_type: None,
            rotation: vec!["dm/custom".to_owned(), "dm/elsewhere".to_owned()],
            allow_download: None,
            map_checksum: None,
            pr_downloads: Some(pr_downloads),
            minimum_ping: None,
            maximum_ping: None,
            join_window: None,
            reserved_slots: None,
            occupancy: ReportedOccupancy::default(),
            client_capacity: None,
            players: Vec::new(),
            pure: None,
            status_round_trip: RoundTripMillis::new(0),
        }
    }

    #[tokio::test]
    async fn server_packages_are_applied_and_rescanned_before_mohdb_is_priced() {
        let fixture = Fixture::new();
        let server = server(serve_server_files(package("dm/custom")).await);

        // While the server's own package is pending, nothing is priced: moh-db could only be asked
        // for a map the server is about to supply.
        let before = build_preview(&fixture, server.clone())
            .await
            .expect("preview before the server files");
        assert_eq!(
            before.pakradar.as_ref().map(|pakradar| pakradar.pending),
            Some(1)
        );
        assert!(fixture.priced().is_empty());

        let applied = apply_server_files(&fixture, server)
            .await
            .expect("server files applied");

        assert!(applied.failures.is_empty());
        assert!(fixture.main.join("custom.pk3").is_file());
        assert_eq!(
            applied
                .preview
                .pakradar
                .as_ref()
                .map(|pakradar| pakradar.pending),
            Some(0)
        );
        // The rescan saw the installed package, so only the map the server does not supply is
        // priced, and it is priced once.
        assert_eq!(fixture.priced(), vec![vec!["dm/elsewhere".to_owned()]]);
    }
}
