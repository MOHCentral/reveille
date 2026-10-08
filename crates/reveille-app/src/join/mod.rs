// SPDX-License-Identifier: GPL-3.0-only

pub mod content;
pub mod preview;

use std::collections::HashSet;
use std::net::SocketAddrV4;
use std::path::PathBuf;

use reveille_core::content::{CatalogueResolutionPass, WantedMap};
use reveille_core::discovery::TargetGame;
use reveille_core::engine::EngineChoice;
use reveille_core::install;
use reveille_core::join::{
    CompatibilityAssessment, CompatibilityState, CurrentMapReadiness, FsGame, LaunchCommand,
    LaunchProfile,
};
use reveille_platform as platform;
use serde::Serialize;
use tauri::Manager;
use tauri::ipc::Channel;
use tracing::info;

use crate::servers;
use crate::session::{Session, installed_maps, session_search_path};
use crate::telemetry::{DownloadSource, Event, JoinFailureReason, Telemetry};
use content::{
    ContentHost, InstallFailure, InstallPhase, InstallProgress, emit_install, install_destination,
    install_shopping_list, shopping_list_will_write,
};
use preview::{
    JoinPreview, PreviewCache, PreviewHost, PreviewProgress, build_pakradar_preview, build_preview,
    cache_preview, price_on_mohdb, take_cached_preview,
};

/// The join as the running app sees it: the player's session, the window that shows progress, the
/// channel of the call waiting on a preview if there is one, and the telemetry it reports to.
struct Shell<'a> {
    session: &'a Session,
    app: &'a tauri::AppHandle,
    preview_progress: Option<&'a Channel<PreviewProgress>>,
    telemetry: &'a Telemetry,
}

impl<'a> Shell<'a> {
    fn new(
        session: &'a Session,
        app: &'a tauri::AppHandle,
        preview_progress: Option<&'a Channel<PreviewProgress>>,
        telemetry: &'a Telemetry,
    ) -> Self {
        Self {
            session,
            app,
            preview_progress,
            telemetry,
        }
    }
}

impl PreviewHost for Shell<'_> {
    fn engine(&self) -> EngineChoice {
        self.session.engine
    }

    fn game(&self) -> TargetGame {
        self.session.game
    }

    fn search_path(&self) -> Result<Vec<PathBuf>, String> {
        Ok(session_search_path(self.session)?)
    }

    async fn price(
        &self,
        address: SocketAddrV4,
        wanted: &[WantedMap],
    ) -> Result<CatalogueResolutionPass, String> {
        price_on_mohdb(self.preview_progress, address, wanted).await
    }
}

impl ContentHost for Shell<'_> {
    fn game_directory(&self) -> Result<PathBuf, String> {
        install_destination(self.session).map(|target| target.game_directory)
    }

    fn telemetry(&self) -> &Telemetry {
        self.telemetry
    }

    fn report_install(&self, progress: &InstallProgress, phase: InstallPhase) {
        emit_install(self.app, progress, phase);
    }
}

/// What happened at the launch gate. A refusal always carries its reason.
#[derive(Serialize)]
#[serde(tag = "launch", rename_all = "snake_case")]
pub enum LaunchOutcome {
    Launched { process_id: u32 },
    Refused { reason: String },
}

#[derive(Serialize)]
pub struct JoinResult {
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

/// Price a join, streaming each moh-db lookup over `on_progress`, which belongs to this call alone.
#[tauri::command]
pub async fn preview_join(
    session: Session,
    address: String,
    on_progress: Channel<PreviewProgress>,
    app: tauri::AppHandle,
    cache: tauri::State<'_, PreviewCache>,
    listing: tauri::State<'_, servers::Listing>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<JoinPreview, String> {
    info!(%address, game = ?session.game, engine = ?session.engine, "building join preview");
    let server = listing.find(&address, session.game)?;
    let preview = build_preview(
        &Shell::new(&session, &app, Some(&on_progress), &telemetry),
        server,
    )
    .await?;
    cache_preview(&cache, &session, preview.clone());
    Ok(preview)
}

#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri commands take each managed state as its own parameter"
)]
pub async fn install_and_launch(
    session: Session,
    address: String,
    selected_candidate_ids: Vec<u64>,
    accept_incomplete: bool,
    app: tauri::AppHandle,
    cache: tauri::State<'_, PreviewCache>,
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
        &cache,
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
pub struct JoinFailure {
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
    cache: &PreviewCache,
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
        .find(&address, session.game)
        .map_err(failed(JoinFailureReason::ServerGone))?;
    let preview = match take_cached_preview(cache, &session, &address) {
        Some(preview) => preview,
        None => build_preview(&Shell::new(&session, app, None, telemetry), server.clone())
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
pub fn track_download(
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

fn unique_parent_directories(installed: &[PathBuf]) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    for directory in installed.iter().filter_map(|path| path.parent()) {
        if !directories.iter().any(|existing| existing == directory) {
            directories.push(directory.to_path_buf());
        }
    }
    directories
}

pub fn register(app: &mut tauri::App) {
    app.manage(PreviewCache::default());
}

#[cfg(test)]
mod tests {
    use reveille_core::bsp::Checksum;
    use reveille_core::join::{
        CompatibilityAssessment, CompatibilityState, CurrentMapReadiness, MapsNeeded,
    };
    use reveille_core::preflight::{MapResult, MapStatus, Report, Verdict};

    use super::{JoinFailureReason, failed, launch_refusal, refusal_reason};

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
    fn compatible_launches_without_consent() {
        let ready = assessment(
            CompatibilityState::Compatible,
            CurrentMapReadiness::Playable,
        );

        assert_eq!(launch_refusal(&ready, false), None);
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
}
