// SPDX-License-Identifier: GPL-3.0-only

use std::collections::HashSet;
use std::net::SocketAddrV4;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use reveille_core::content::{self, CatalogueResolutionPass, PakRadarEntry, WantedMap};
use reveille_core::discovery::{Server, TargetGame};
use reveille_core::engine::EngineChoice;
use reveille_core::join::CompatibilityAssessment;
use reveille_core::mapindex::MapIndex;
use serde::Serialize;
use tauri::ipc::Channel;
use tracing::info;

use crate::session::Session;

/// The most recent join preview, reused so a launch does not repeat the catalogue pass.
#[derive(Default)]
pub struct PreviewCache(Mutex<Option<CachedPreview>>);

struct CachedPreview {
    install_root: PathBuf,
    engine: EngineChoice,
    game: TargetGame,
    preview: JoinPreview,
}

#[derive(Clone, Serialize)]
pub struct PreviewProgress {
    address: SocketAddrV4,
    index: usize,
    of: usize,
    map: String,
}

#[derive(Clone, Serialize)]
pub struct JoinPreview {
    pub address: SocketAddrV4,
    server: Server,
    assessment: CompatibilityAssessment,
    pub pakradar: Option<PakRadarPreview>,
    pub catalogue: Option<CatalogueResolutionPass>,
    engine: EngineChoice,
    game: TargetGame,
}

/// Server-owned packages advertised through `pr_downloads`.
///
/// The manifest is fetched during preview, but its packages are installed only by the player's
/// separate first-stage action. A manifest failure is retained as a recorded non-result and keeps
/// the later moh-db decision gated until the server list can be checked.
#[derive(Clone, Serialize)]
pub struct PakRadarPreview {
    url: String,
    pub entries: Vec<PakRadarEntry>,
    pub pending: usize,
    pub non_result: Option<String>,
}

pub fn take_cached_preview(
    cache: &PreviewCache,
    session: &Session,
    address: &str,
) -> Option<JoinPreview> {
    let mut cache = cache.0.lock().ok()?;
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

pub fn cache_preview(cache: &PreviewCache, session: &Session, preview: JoinPreview) {
    if let Ok(mut cache) = cache.0.lock() {
        *cache = Some(CachedPreview {
            install_root: PathBuf::from(&session.path),
            engine: session.engine,
            game: session.game,
            preview,
        });
    }
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

/// What a join preview reads from outside the join: the folders the engine searches, which change
/// as server files land, and the moh-db price. A test supplies both without a game or a network.
pub trait PreviewHost {
    fn engine(&self) -> EngineChoice;
    fn game(&self) -> TargetGame;
    fn search_path(&self) -> Result<Vec<PathBuf>, String>;
    fn price(
        &self,
        address: SocketAddrV4,
        wanted: &[WantedMap],
    ) -> impl Future<Output = Result<CatalogueResolutionPass, String>>;
}

pub async fn build_preview(host: &impl PreviewHost, server: Server) -> Result<JoinPreview, String> {
    let address = SocketAddrV4::new(server.endpoint.address, server.game_port.get());
    info!(%address, game = ?host.game(), engine = ?host.engine(), "starting preview build");
    let search_path = host.search_path()?;
    let index = MapIndex::scan_chain(&search_path).map_err(|error| error.to_string())?;
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
        Some(host.price(address, &wanted).await?)
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
        engine: host.engine(),
        game: host.game(),
    })
}

/// Price the wanted maps on moh-db, reporting each lookup over `on_progress` as it lands.
///
/// A lookup that cannot be reported is not an error: the returned pass carries every result.
pub async fn price_on_mohdb(
    on_progress: Option<&Channel<PreviewProgress>>,
    address: SocketAddrV4,
    wanted: &[WantedMap],
) -> Result<CatalogueResolutionPass, String> {
    let client =
        content::MohDbClient::new(Duration::from_secs(15)).map_err(|error| error.to_string())?;
    Ok(client
        .resolve_all_reporting(wanted, |progress| {
            let map = match progress.resolved {
                Ok(resolution) => resolution.wanted.name.clone(),
                Err(non_result) => non_result.wanted.name.clone(),
            };
            if let Some(channel) = on_progress {
                drop(channel.send(PreviewProgress {
                    address,
                    index: progress.index,
                    of: progress.of,
                    map,
                }));
            }
        })
        .await)
}

pub async fn build_pakradar_preview(
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::preview_cache_matches;

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
}
