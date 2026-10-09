// SPDX-License-Identifier: GPL-3.0-only

//! Maps & mods: browsing moh-db and installing one entry at a time, outside any join.

pub mod record;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reveille_core::content::{
    self, CatalogueCandidate, CatalogueEntry, CatalogueQuery, CatalogueSort, DownloadProgress,
    MohDbClient, MohDbIntegrity,
};
use serde::Serialize;
use tauri::Manager;
use tauri::ipc::Channel;
use tokio::sync::Notify;
use tracing::{info, warn};

use crate::join::content::{catalogue_reason, install_destination};
use crate::session::{Session, session_search_path};
use crate::telemetry::{DownloadSource, Event, Telemetry};
use record::{InstallRecord, InstalledItem};

/// Bytes between progress messages, as for join downloads.
const PROGRESS_STRIDE: u64 = 256 * 1024;
/// Screenshots kept in memory. A session of browsing touches a few pages of cards.
const IMAGE_CACHE: usize = 240;

/// The catalogue as this run has seen it, the installs in flight and the screenshots fetched.
///
/// Installs and screenshots are looked up by id in what Reveille itself fetched, never taken from
/// the webview, so a page can only ask for what moh-db listed.
#[derive(Default)]
pub struct Catalogue {
    entries: Mutex<HashMap<u64, CatalogueEntry>>,
    installing: Mutex<HashMap<u64, Arc<Notify>>>,
    images: Mutex<HashMap<(u64, usize), String>>,
}

impl Catalogue {
    fn entry(&self, id: u64) -> Option<CatalogueEntry> {
        lock(&self.entries).get(&id).cloned()
    }
}

pub fn register(app: &mut tauri::App) {
    app.manage(Catalogue::default());
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Whether an entry can be installed, and if not, why.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    /// Reveille installed it and the file is still there.
    Installed,
    /// A file of that name is already in the game's search path, put there by someone else.
    Present,
    /// Ready to install.
    Available,
    /// moh-db has no file Reveille can install.
    Unavailable,
}

#[derive(Serialize)]
pub struct ItemFile {
    filename: String,
    size: u64,
}

/// One entry as the page shows it.
#[derive(Serialize)]
pub struct CatalogueItem {
    id: u64,
    title: String,
    map_name: Option<String>,
    map_key: Option<String>,
    author: Option<String>,
    description: Option<String>,
    theme: Option<String>,
    modes: Option<String>,
    size_class: Option<String>,
    added: Option<i64>,
    rating: Option<f64>,
    downloads: u64,
    image_count: usize,
    page_url: String,
    file: Option<ItemFile>,
    state: ItemState,
}

impl CatalogueItem {
    fn new(entry: &CatalogueEntry, state: ItemState) -> Self {
        Self {
            id: entry.id,
            title: entry.title.clone(),
            map_name: entry.map_name.clone(),
            map_key: entry.map_key.as_ref().map(|key| key.as_str().to_owned()),
            author: entry.author.clone(),
            description: entry.description.clone(),
            theme: entry.theme.clone(),
            modes: entry.modes.clone(),
            size_class: entry.size_class.clone(),
            added: entry.added,
            rating: entry.rating,
            downloads: entry.downloads,
            image_count: entry.image_count,
            page_url: entry.page_url.clone(),
            file: entry.candidate.as_ref().map(|candidate| ItemFile {
                filename: candidate.filename.clone(),
                size: candidate.file_size.get(),
            }),
            state,
        }
    }
}

#[derive(Serialize)]
pub struct CataloguePayload {
    entries: Vec<CatalogueItem>,
    total: usize,
    page: usize,
    has_more: bool,
}

/// One page of moh-db's maps, each marked with whether this game folder already has it.
#[tauri::command]
pub async fn browse_catalogue(
    session: Session,
    search: String,
    sort: CatalogueSort,
    page: usize,
    app: tauri::AppHandle,
    catalogue: tauri::State<'_, Catalogue>,
) -> Result<CataloguePayload, String> {
    info!(
        page,
        ?sort,
        searching = !search.trim().is_empty(),
        "browsing catalogue"
    );
    let query = CatalogueQuery { search, sort, page };
    let client = MohDbClient::new(Duration::from_secs(20)).map_err(|error| error.to_string())?;
    let result = client
        .browse(&query)
        .await
        .map_err(|error| catalogue_reason(&error.into()))?;
    let present = package_names(&session_search_path(&session)?);
    let installed = install_record(&app)
        .map(|record| record.items())
        .unwrap_or_default();
    let entries = result
        .entries
        .iter()
        .map(|entry| CatalogueItem::new(entry, item_state(entry, &installed, &present)))
        .collect();
    lock(&catalogue.entries).extend(result.entries.into_iter().map(|entry| (entry.id, entry)));
    Ok(CataloguePayload {
        entries,
        total: result.total_elements,
        page: result.page,
        has_more: result.has_more,
    })
}

fn item_state(
    entry: &CatalogueEntry,
    installed: &[InstalledItem],
    present: &HashSet<String>,
) -> ItemState {
    let Some(candidate) = &entry.candidate else {
        return ItemState::Unavailable;
    };
    if InstallRecord::installed(installed, entry.id).is_some() {
        ItemState::Installed
    } else if present.contains(&candidate.filename.to_ascii_lowercase()) {
        ItemState::Present
    } else {
        ItemState::Available
    }
}

/// Lowercased names of every package in the directories the engine reads.
fn package_names(search_path: &[PathBuf]) -> HashSet<String> {
    search_path
        .iter()
        .filter_map(|directory| std::fs::read_dir(directory).ok())
        .flatten()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_ascii_lowercase())
        .filter(|name| {
            Path::new(name)
                .extension()
                .is_some_and(|extension| extension == "pk3")
        })
        .collect()
}

fn install_record(app: &tauri::AppHandle) -> Option<InstallRecord> {
    match app.path().app_data_dir() {
        Ok(directory) => Some(InstallRecord::new(&directory)),
        Err(error) => {
            warn!(%error, "could not resolve the app data directory; installs go unrecorded");
            None
        }
    }
}

/// A screenshot of a listed entry, as a `data:` URL so the CSP need not admit moh-db's host.
#[tauri::command]
pub async fn catalogue_image(
    id: u64,
    index: usize,
    catalogue: tauri::State<'_, Catalogue>,
) -> Result<String, String> {
    if let Some(cached) = lock(&catalogue.images).get(&(id, index)) {
        return Ok(cached.clone());
    }
    let url = catalogue
        .entry(id)
        .and_then(|entry| entry.image_url(index).map(str::to_owned))
        .ok_or_else(|| "moh-db lists no such screenshot.".to_owned())?;
    let client = MohDbClient::new(Duration::from_secs(20)).map_err(|error| error.to_string())?;
    let image = client
        .fetch_image(&url)
        .await
        .map_err(|error| error.to_string())?;
    let data = format!("data:{};base64,{}", image.media_type, base64(&image.bytes));
    let mut images = lock(&catalogue.images);
    if images.len() >= IMAGE_CACHE {
        images.clear();
    }
    images.insert((id, index), data.clone());
    Ok(data)
}

#[derive(Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum InstallStep {
    Downloading { received: u64, total: u64 },
    Confirming,
}

#[derive(Serialize)]
pub struct InstallOutcome {
    id: u64,
    path: PathBuf,
    state: ItemState,
}

/// Download, check and install one listed entry into the game folder, reporting over `on_progress`.
#[tauri::command]
pub async fn install_catalogue_item(
    session: Session,
    id: u64,
    on_progress: Channel<InstallStep>,
    app: tauri::AppHandle,
    catalogue: tauri::State<'_, Catalogue>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<InstallOutcome, String> {
    let entry = catalogue
        .entry(id)
        .ok_or_else(|| "Reveille no longer has this map's details. Search again.".to_owned())?;
    let candidate = entry
        .candidate
        .clone()
        .ok_or_else(|| "moh-db has no file Reveille can install for this map.".to_owned())?;
    let cancel = Arc::new(Notify::new());
    {
        let mut installing = lock(&catalogue.installing);
        if installing.contains_key(&id) {
            return Err("This map is already being installed.".to_owned());
        }
        installing.insert(id, Arc::clone(&cancel));
    }
    info!(id, filename = %candidate.filename, "installing catalogue entry");
    telemetry.track(&Event::MapDownloadStarted {
        source: DownloadSource::Browse,
        count: 1,
    });
    let result = async {
        let target = install_destination(&session)?;
        let staging = tempfile::TempDir::new().map_err(|error| error.to_string())?;
        install_candidate(
            &candidate,
            &target.game_directory,
            staging.path(),
            |step| drop(on_progress.send(step)),
            &cancel,
        )
        .await
    }
    .await;
    lock(&catalogue.installing).remove(&id);
    match result {
        Ok(installed) => {
            telemetry.track(&Event::MapDownloadCompleted {
                source: DownloadSource::Browse,
                installed: 1,
            });
            let path = installed.path.clone();
            if let Some(record) = install_record(&app)
                && let Err(error) = record.add(installed)
            {
                warn!(%error, "could not record the install");
            }
            info!(id, path = %path.display(), "installed catalogue entry");
            Ok(InstallOutcome {
                id,
                path,
                state: ItemState::Installed,
            })
        }
        Err(reason) => {
            if reason != CANCELLED {
                warn!(id, %reason, "catalogue install failed");
                telemetry.track(&Event::MapDownloadFailed {
                    source: DownloadSource::Browse,
                    failed: 1,
                });
            }
            Err(reason)
        }
    }
}

/// Stop the install of `id`, if one is running. Nothing reaches the game folder.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn cancel_catalogue_install(id: u64, catalogue: tauri::State<'_, Catalogue>) {
    if let Some(cancel) = lock(&catalogue.installing).get(&id) {
        info!(id, "catalogue install cancellation requested");
        cancel.notify_one();
    }
}

/// The reason a cancelled install returns. The page recognises it and shows no error.
pub const CANCELLED: &str = "cancelled";

/// Download into `staging`, confirm the archive carries the map moh-db named, and install it.
///
/// The archive is inspected before anything is written to the game folder, and installation never
/// replaces an existing file. `cancel` stops the download; once confirming starts the install
/// runs to the end, since it is a single rename into place.
async fn install_candidate(
    candidate: &CatalogueCandidate,
    game_directory: &Path,
    staging: &Path,
    report: impl Fn(InstallStep),
    cancel: &Notify,
) -> Result<InstalledItem, String> {
    let client = MohDbClient::new(Duration::from_secs(30)).map_err(|error| error.to_string())?;
    let total = candidate.file_size.get();
    let mut announced = 0_u64;
    let download = content::download_mohdb_archive_reporting(
        &client,
        candidate,
        staging,
        |DownloadProgress { received, .. }| {
            if received != 0 && received < announced.saturating_add(PROGRESS_STRIDE) {
                return;
            }
            announced = received;
            report(InstallStep::Downloading { received, total });
        },
    );
    let archive = tokio::select! {
        archive = download => archive.map_err(|error| error.to_string())?,
        () = cancel.notified() => return Err(CANCELLED.to_owned()),
    };
    report(InstallStep::Confirming);
    let inspection = content::inspect_archive(&archive.path).map_err(|error| error.to_string())?;
    content::confirm_map(&inspection, &candidate.map_name, None)
        .map_err(|error| error.to_string())?;
    let path =
        content::install_archive(&archive, game_directory).map_err(|error| error.to_string())?;
    let MohDbIntegrity::RecordedSha256(sha256) = archive.integrity;
    Ok(InstalledItem {
        id: candidate.id,
        filename: archive.filename,
        path,
        sha256,
        size: total,
        installed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs()),
    })
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut text = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = chunk.iter().enumerate().fold(0_u32, |acc, (index, byte)| {
            acc | (u32::from(*byte) << (16 - 8 * index))
        });
        for position in 0..4 {
            if position <= chunk.len() {
                let sextet = (triple >> (18 - 6 * position)) & 0x3f;
                text.push(char::from(ALPHABET[sextet as usize]));
            } else {
                text.push('=');
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::fs;
    use std::io::{Cursor, Write};

    use reveille_core::content::{CatalogueCandidate, FileSize};
    use reveille_core::mapindex::MapKey;
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Notify;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::{CANCELLED, InstallStep, base64, install_candidate, package_names};

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

    /// Serve `body` on loopback; with `stall`, send the headers and then nothing.
    async fn serve(body: Vec<u8>, stall: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let url = format!("http://{}/map.pk3", listener.local_addr().expect("address"));
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut request = vec![0; 4096];
                drop(stream.read(&mut request).await);
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                stream.write_all(head.as_bytes()).await.expect("head");
                if stall {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                }
                stream.write_all(&body).await.expect("body");
            }
        });
        url
    }

    fn candidate(map: &str, url: String, size: usize) -> CatalogueCandidate {
        CatalogueCandidate {
            id: 4301,
            map_name: map.to_owned(),
            map_key: MapKey::new(map).expect("map key"),
            filename: "snipertown.pk3".to_owned(),
            file_size: FileSize::new(size as u64),
            map_file_tested: true,
            downloads: 1,
            download_url: url,
        }
    }

    #[tokio::test]
    async fn an_entry_is_downloaded_confirmed_and_installed_without_a_join() {
        let body = package("dm/snipertown");
        let url = serve(body.clone(), false).await;
        let game = TempDir::new().expect("game folder");
        let staging = TempDir::new().expect("staging");
        let steps = std::sync::Mutex::new(Vec::new());

        let installed = install_candidate(
            &candidate("dm/snipertown", url, body.len()),
            game.path(),
            staging.path(),
            |step| steps.lock().expect("steps").push(step),
            &Notify::new(),
        )
        .await
        .expect("installed");

        assert_eq!(installed.path, game.path().join("snipertown.pk3"));
        assert_eq!(fs::read(&installed.path).expect("installed file"), body);
        assert_eq!(installed.sha256.len(), 64);
        let steps = steps.into_inner().expect("steps");
        assert!(matches!(
            steps.first(),
            Some(InstallStep::Downloading { received: 0, .. })
        ));
        assert!(matches!(steps.last(), Some(InstallStep::Confirming)));
    }

    #[tokio::test]
    async fn an_archive_without_the_named_map_never_reaches_the_game_folder() {
        let body = package("dm/something_else");
        let url = serve(body.clone(), false).await;
        let game = TempDir::new().expect("game folder");
        let staging = TempDir::new().expect("staging");

        let refused = install_candidate(
            &candidate("dm/snipertown", url, body.len()),
            game.path(),
            staging.path(),
            |_| {},
            &Notify::new(),
        )
        .await;

        assert!(refused.is_err());
        assert_eq!(fs::read_dir(game.path()).expect("game folder").count(), 0);
    }

    #[tokio::test]
    async fn a_cancelled_download_installs_nothing() {
        let body = package("dm/snipertown");
        let url = serve(body.clone(), true).await;
        let game = TempDir::new().expect("game folder");
        let staging = TempDir::new().expect("staging");
        let cancel = Notify::new();
        cancel.notify_one();

        let cancelled = install_candidate(
            &candidate("dm/snipertown", url, body.len()),
            game.path(),
            staging.path(),
            |_| {},
            &cancel,
        )
        .await;

        assert_eq!(cancelled.err().as_deref(), Some(CANCELLED));
        assert_eq!(fs::read_dir(game.path()).expect("game folder").count(), 0);
    }

    #[test]
    fn packages_are_found_whatever_their_case_and_other_files_are_ignored() {
        let main = TempDir::new().expect("main");
        fs::write(main.path().join("SniperTown.PK3"), b"").expect("package");
        fs::write(main.path().join("readme.txt"), b"").expect("text");

        let names = package_names(&[main.path().to_path_buf(), main.path().join("missing")]);
        assert_eq!(names, HashSet::from(["snipertown.pk3".to_owned()]));
    }

    #[test]
    fn screenshots_are_encoded_as_standard_base64() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[0xff, 0xfe, 0xfd, 0x00]), "//79AA==");
    }
}
