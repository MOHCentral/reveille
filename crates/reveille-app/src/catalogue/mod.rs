// SPDX-License-Identifier: GPL-3.0-only

//! Maps & mods: browsing moh-db, installing one entry at a time outside any join, and removing
//! what Reveille installed.

pub mod record;

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reveille_core::content::{
    self, CatalogueEntry, CatalogueKind, CatalogueQuery, CatalogueSort, DownloadProgress, MapMode,
    MohDbClient, MohDbFile, MohDbIntegrity,
};
use reveille_core::mapindex::{Map, MapIndex, MapKey, Provider};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;
use tauri::ipc::Channel;
use tokio::sync::Notify;
use tokio::task::JoinSet;
use tracing::{info, warn};

use crate::join::content::{catalogue_reason, install_destination};
use crate::session::{Session, installed_maps, session_search_path};
use crate::telemetry::{DownloadSource, Event, Telemetry};
use record::{InstallRecord, InstalledItem};

/// Bytes between progress messages, as for join downloads.
const PROGRESS_STRIDE: u64 = 256 * 1024;
/// Screenshots kept in memory. A session of browsing touches a few pages of cards.
const IMAGE_CACHE: usize = 240;
/// Custom maps looked up for Played now in one call. A full server list runs a few dozen.
const PLAYED_NOW_LIMIT: usize = 40;
/// Played now lookups in flight at once, so a first look costs moh-db a short trickle.
const PLAYED_NOW_CONCURRENCY: usize = 4;

/// The catalogue as this run has seen it, the installs in flight and the screenshots fetched.
///
/// Installs and screenshots are looked up by id in what Reveille itself fetched, never taken from
/// the webview, so a page can only ask for what moh-db listed.
///
/// Played now remembers, per map name, which entry moh-db gave for it (or that it gave none), so
/// the list is asked of moh-db once a run and again only on Refresh.
#[derive(Default)]
pub struct Catalogue {
    entries: Mutex<HashMap<u64, CatalogueEntry>>,
    installing: Mutex<HashMap<u64, Arc<Notify>>>,
    images: Mutex<HashMap<(u64, usize), String>>,
    played: Mutex<HashMap<MapKey, Option<u64>>>,
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
    /// The game already has it: a file of that name, or for a map, the map itself, put there by
    /// someone else.
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
    kind: CatalogueKind,
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
    mod_type: Option<String>,
    version: Option<String>,
    requires: Option<String>,
    install_notes: Option<String>,
    archive_name: Option<String>,
    file: Option<ItemFile>,
    state: ItemState,
}

impl CatalogueItem {
    fn new(entry: &CatalogueEntry, state: ItemState) -> Self {
        Self {
            id: entry.id,
            kind: entry.kind,
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
            mod_type: entry.mod_type.clone(),
            version: entry.version.clone(),
            requires: entry.requires.clone(),
            install_notes: entry.install_notes.clone(),
            archive_name: entry.archive_name.clone(),
            file: entry.file.as_ref().map(|file| ItemFile {
                filename: file.filename.clone(),
                size: file.file_size.get(),
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

/// One page of moh-db's maps or mods, each marked with whether this game folder already has it.
#[tauri::command]
#[expect(
    clippy::too_many_arguments,
    reason = "Tauri commands take each argument the page sends, plus the state they read"
)]
pub async fn browse_catalogue(
    session: Session,
    kind: CatalogueKind,
    search: String,
    sort: CatalogueSort,
    mode: Option<MapMode>,
    page: usize,
    app: tauri::AppHandle,
    catalogue: tauri::State<'_, Catalogue>,
) -> Result<CataloguePayload, String> {
    info!(
        page,
        ?kind,
        ?sort,
        ?mode,
        searching = !search.trim().is_empty(),
        "browsing catalogue"
    );
    let query = CatalogueQuery {
        kind,
        search,
        sort,
        page,
        mode,
        game: Some(session.game),
    };
    let client = MohDbClient::new(Duration::from_secs(20)).map_err(|error| error.to_string())?;
    let result = client
        .browse(&query)
        .await
        .map_err(|error| catalogue_reason(&error.into()))?;
    let local = LocalContent::read(&session, &app, kind)?;
    let entries = result
        .entries
        .iter()
        .map(|entry| CatalogueItem::new(entry, local.state(entry)))
        .collect();
    lock(&catalogue.entries).extend(result.entries.into_iter().map(|entry| (entry.id, entry)));
    Ok(CataloguePayload {
        entries,
        total: result.total_elements,
        page: result.page,
        has_more: result.has_more,
    })
}

/// What the game already holds, read once per answer to the page.
struct LocalContent {
    installed: Vec<InstalledItem>,
    packages: HashSet<String>,
    maps: Option<MapIndex>,
}

impl LocalContent {
    fn read(
        session: &Session,
        app: &tauri::AppHandle,
        kind: CatalogueKind,
    ) -> Result<Self, String> {
        let packages = package_names(&session_search_path(session)?);
        // Mods have no map to look for, and scanning every package's maps is the costly part.
        let maps = match kind {
            CatalogueKind::Map => Some(installed_maps(session).map_err(|error| error.to_string())?),
            CatalogueKind::Mod => None,
        };
        Ok(Self {
            installed: install_record(app)
                .map(|record| record.items())
                .unwrap_or_default(),
            packages,
            maps,
        })
    }

    fn state(&self, entry: &CatalogueEntry) -> ItemState {
        item_state(entry, &self.installed, &self.packages, self.maps.as_ref())
    }
}

fn item_state(
    entry: &CatalogueEntry,
    installed: &[InstalledItem],
    present: &HashSet<String>,
    maps: Option<&MapIndex>,
) -> ItemState {
    let Some(file) = &entry.file else {
        return ItemState::Unavailable;
    };
    let has_map = entry
        .map_name
        .as_deref()
        .zip(maps)
        .is_some_and(|(name, maps)| maps.get(name).is_some());
    if InstallRecord::installed(installed, entry.id).is_some() {
        ItemState::Installed
    } else if has_map || present.contains(&file.filename.to_ascii_lowercase()) {
        ItemState::Present
    } else {
        ItemState::Available
    }
}

/// Whether the engine loads `map` from the game's own `pakN.pk3` archives.
fn is_stock(map: &Map) -> bool {
    matches!(map.effective_provider(), Some(Provider::Pk3 { archive, .. }) if is_stock_archive(archive))
}

fn is_stock_archive(archive: &Path) -> bool {
    archive
        .file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| {
            stem.get(..3)
                .filter(|head| head.eq_ignore_ascii_case("pak"))
                .and_then(|_| stem.get(3..))
        })
        .is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// moh-db's entry for each custom map in `maps`, the names servers in the list are running. With
/// `fresh`, what earlier calls learned is asked again.
///
/// Maps the game ships with are skipped: they are never worth a download, and asking moh-db about
/// them would make up most of the requests.
#[tauri::command]
pub async fn catalogue_played_now(
    session: Session,
    maps: Vec<String>,
    fresh: bool,
    app: tauri::AppHandle,
    catalogue: tauri::State<'_, Catalogue>,
) -> Result<Vec<CatalogueItem>, String> {
    if fresh {
        lock(&catalogue.played).clear();
    }
    let index = installed_maps(&session).map_err(|error| error.to_string())?;
    let mut wanted = Vec::new();
    let mut seen = HashSet::new();
    for name in maps {
        let Some(key) = MapKey::new(&name) else {
            continue;
        };
        // moh-db's name filter is only reached by a name with a directory, and every server map
        // has one; anything else would be searched as a title.
        let stock = index.get(&name).is_some_and(is_stock);
        if stock || !name.contains(['/', '\\']) || !seen.insert(key.clone()) {
            continue;
        }
        wanted.push((name, key));
        if wanted.len() == PLAYED_NOW_LIMIT {
            break;
        }
    }
    let unknown = {
        let played = lock(&catalogue.played);
        wanted
            .iter()
            .filter(|(_, key)| !played.contains_key(key))
            .cloned()
            .collect::<Vec<_>>()
    };
    info!(
        maps = wanted.len(),
        asking = unknown.len(),
        "looking up maps played now"
    );
    if !unknown.is_empty() {
        let client =
            MohDbClient::new(Duration::from_secs(20)).map_err(|error| error.to_string())?;
        let found = look_up_maps(&client, unknown).await?;
        let mut entries = lock(&catalogue.entries);
        let mut played = lock(&catalogue.played);
        for (key, entry) in found {
            played.insert(key, entry.as_ref().map(|entry| entry.id));
            if let Some(entry) = entry {
                entries.insert(entry.id, entry);
            }
        }
    }
    let local = LocalContent {
        installed: install_record(&app)
            .map(|record| record.items())
            .unwrap_or_default(),
        packages: package_names(&session_search_path(&session)?),
        maps: Some(index),
    };
    let played = lock(&catalogue.played);
    let entries = lock(&catalogue.entries);
    Ok(wanted
        .iter()
        .filter_map(|(_, key)| played.get(key).copied().flatten())
        .filter_map(|id| entries.get(&id))
        .map(|entry| CatalogueItem::new(entry, local.state(entry)))
        .collect())
}

/// Ask moh-db for each map by name, a few at a time. A lookup that fails is not remembered, so the
/// next look asks again; it only fails the call when every lookup did.
async fn look_up_maps(
    client: &MohDbClient,
    wanted: Vec<(String, MapKey)>,
) -> Result<Vec<(MapKey, Option<CatalogueEntry>)>, String> {
    let mut pending = wanted.into_iter();
    let mut running = JoinSet::new();
    let mut found = Vec::new();
    let mut failure = None;
    loop {
        while running.len() < PLAYED_NOW_CONCURRENCY {
            let Some((name, key)) = pending.next() else {
                break;
            };
            let client = client.clone();
            running.spawn(async move {
                let query = CatalogueQuery {
                    search: name,
                    ..CatalogueQuery::default()
                };
                (key, client.browse(&query).await)
            });
        }
        let Some(joined) = running.join_next().await else {
            break;
        };
        match joined {
            Ok((key, Ok(page))) => {
                let entry = best_match(page.entries, &key);
                found.push((key, entry));
            }
            Ok((_, Err(error))) => failure = Some(catalogue_reason(&error.into())),
            Err(error) => failure = Some(error.to_string()),
        }
    }
    match failure {
        Some(reason) if found.is_empty() => Err(reason),
        _ => Ok(found),
    }
}

/// The entry for exactly this map: moh-db's name filter also matches longer names, such as a
/// `_beta` beside the release. The listing is most downloaded first, and one with a file wins.
fn best_match(entries: Vec<CatalogueEntry>, key: &MapKey) -> Option<CatalogueEntry> {
    let mut exact = entries
        .into_iter()
        .filter(|entry| entry.map_key.as_ref() == Some(key))
        .collect::<Vec<_>>();
    let at = exact
        .iter()
        .position(|entry| entry.file.is_some())
        .unwrap_or(0);
    (at < exact.len()).then(|| exact.swap_remove(at))
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
        .ok_or_else(|| "Reveille no longer has these details. Search again.".to_owned())?;
    let installable = Installable::from_entry(&entry)
        .ok_or_else(|| "moh-db has no file Reveille can install for this.".to_owned())?;
    let cancel = Arc::new(Notify::new());
    {
        let mut installing = lock(&catalogue.installing);
        if installing.contains_key(&id) {
            return Err("This is already being installed.".to_owned());
        }
        installing.insert(id, Arc::clone(&cancel));
    }
    info!(id, kind = ?entry.kind, filename = %installable.file.filename, "installing catalogue entry");
    telemetry.track(&Event::MapDownloadStarted {
        source: DownloadSource::Browse,
        count: 1,
    });
    let result = async {
        let target = install_destination(&session)?;
        let staging = tempfile::TempDir::new().map_err(|error| error.to_string())?;
        install_entry(
            &installable,
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

/// What installing one entry needs to know about it.
struct Installable {
    id: u64,
    kind: CatalogueKind,
    title: String,
    page_url: String,
    file: MohDbFile,
    /// The map the archive must carry; none for a mod.
    map_name: Option<String>,
}

impl Installable {
    fn from_entry(entry: &CatalogueEntry) -> Option<Self> {
        Some(Self {
            id: entry.id,
            kind: entry.kind,
            title: entry.title.clone(),
            page_url: entry.page_url.clone(),
            file: entry.file.clone()?,
            map_name: match entry.kind {
                CatalogueKind::Map => Some(entry.candidate.as_ref()?.map_name.clone()),
                CatalogueKind::Mod => None,
            },
        })
    }
}

/// Download into `staging`, confirm a map's archive carries the map moh-db named, and install it.
///
/// The archive is inspected before anything is written to the game folder, so a package with a
/// program library or a path out of the folder is refused, and installation never replaces an
/// existing file. `cancel` stops the download; once confirming starts the install runs to the end,
/// since it is a single rename into place.
async fn install_entry(
    entry: &Installable,
    game_directory: &Path,
    staging: &Path,
    report: impl Fn(InstallStep),
    cancel: &Notify,
) -> Result<InstalledItem, String> {
    let file = &entry.file;
    let client = MohDbClient::new(Duration::from_secs(30)).map_err(|error| error.to_string())?;
    let total = file.file_size.get();
    let mut announced = 0_u64;
    let download = content::download_mohdb_file_reporting(
        &client,
        file,
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
    if let Some(map_name) = &entry.map_name {
        content::confirm_map(&inspection, map_name, None).map_err(|error| error.to_string())?;
    }
    let path =
        content::install_archive(&archive, game_directory).map_err(|error| error.to_string())?;
    let MohDbIntegrity::RecordedSha256(sha256) = archive.integrity;
    Ok(InstalledItem {
        id: entry.id,
        kind: entry.kind,
        title: entry.title.clone(),
        page_url: Some(entry.page_url.clone()),
        filename: archive.filename,
        path,
        sha256,
        size: total,
        installed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_secs()),
    })
}

/// One package Reveille installed, as Installed lists it.
#[derive(Serialize)]
pub struct InstalledEntry {
    id: u64,
    kind: CatalogueKind,
    title: String,
    filename: String,
    page_url: Option<String>,
    size: u64,
    installed_at: u64,
    /// The file's size no longer matches the record, so Remove will refuse it.
    changed: bool,
}

#[derive(Serialize)]
pub struct InstalledPayload {
    items: Vec<InstalledEntry>,
    /// Bytes the listed packages take on disk.
    total_size: u64,
}

/// What Reveille installed into the directories this session's game reads, newest first.
///
/// A recorded file that is gone is left out: the player removed it themselves.
#[tauri::command]
pub async fn installed_content(
    session: Session,
    app: tauri::AppHandle,
) -> Result<InstalledPayload, String> {
    let search_path = session_search_path(&session)?;
    let items = install_record(&app)
        .map(|record| record.items())
        .unwrap_or_default();
    Ok(installed_payload(&items, &search_path))
}

fn installed_payload(items: &[InstalledItem], search_path: &[PathBuf]) -> InstalledPayload {
    let mut listed = items
        .iter()
        .filter(|item| in_search_path(&item.path, search_path))
        .filter_map(|item| {
            let on_disk = std::fs::metadata(&item.path)
                .ok()
                .filter(std::fs::Metadata::is_file)?;
            Some(InstalledEntry {
                id: item.id,
                kind: item.kind,
                title: if item.title.is_empty() {
                    item.filename.clone()
                } else {
                    item.title.clone()
                },
                filename: item.filename.clone(),
                page_url: item.page_url.clone(),
                size: on_disk.len(),
                installed_at: item.installed_at,
                changed: on_disk.len() != item.size,
            })
        })
        .collect::<Vec<_>>();
    listed.sort_by_key(|item| std::cmp::Reverse(item.installed_at));
    let total_size = listed.iter().map(|item| item.size).sum();
    InstalledPayload {
        items: listed,
        total_size,
    }
}

fn in_search_path(path: &Path, search_path: &[PathBuf]) -> bool {
    path.parent()
        .is_some_and(|parent| search_path.iter().any(|directory| directory == parent))
}

/// The state an entry is in once its file is gone.
#[derive(Serialize)]
pub struct RemovalOutcome {
    id: u64,
    state: ItemState,
}

/// Delete the package Reveille installed for `id`, but only if it is still the file Reveille wrote.
#[tauri::command]
pub async fn remove_installed_item(
    session: Session,
    id: u64,
    app: tauri::AppHandle,
) -> Result<RemovalOutcome, String> {
    let record = install_record(&app)
        .ok_or_else(|| "Reveille cannot read its list of installs.".to_owned())?;
    let items = record.items();
    let search_path = session_search_path(&session)?;
    let item = items
        .iter()
        .rev()
        .find(|item| {
            item.id == id && in_search_path(&item.path, &search_path) && item.path.is_file()
        })
        .ok_or_else(|| "Reveille did not install this in your game folder.".to_owned())?;
    remove_package(item)?;
    if let Err(error) = record.remove(&item.path) {
        warn!(%error, "could not update the install record after a removal");
    }
    info!(id, path = %item.path.display(), "removed installed content");
    Ok(RemovalOutcome {
        id,
        state: ItemState::Available,
    })
}

/// Delete `item`'s file when its bytes still hash to what Reveille recorded writing.
///
/// Anything else is a file Reveille did not put there, or one the player changed since, and stays.
fn remove_package(item: &InstalledItem) -> Result<(), String> {
    let named = item
        .path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(item.filename.as_str()));
    if !named || sha256_file(&item.path)? != item.sha256 {
        return Err(
            "This file changed since Reveille installed it, so Reveille left it in place."
                .to_owned(),
        );
    }
    std::fs::remove_file(&item.path)
        .map_err(|error| format!("Reveille could not delete it: {error}"))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).map_err(|error| error.to_string())?;
    Ok(hasher
        .finalize()
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        }))
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

    use reveille_core::content::{CatalogueKind, FileSize, MohDbFile};
    use tempfile::TempDir;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Notify;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::record::InstalledItem;
    use super::{
        CANCELLED, InstallStep, Installable, base64, install_entry, installed_payload,
        is_stock_archive, package_names, remove_package, sha256_file,
    };

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

    fn mod_package(entry: &str) -> Vec<u8> {
        let mut archive = ZipWriter::new(Cursor::new(Vec::new()));
        archive
            .start_file(entry, SimpleFileOptions::default())
            .expect("start entry");
        archive.write_all(b"skin").expect("write entry");
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

    fn candidate(map: &str, url: String, size: usize) -> Installable {
        Installable {
            id: 4301,
            kind: CatalogueKind::Map,
            title: "Snipertown".to_owned(),
            page_url: "https://www.moh-db.com/maps/9101-snipertown".to_owned(),
            file: MohDbFile {
                filename: "snipertown.pk3".to_owned(),
                file_size: FileSize::new(size as u64),
                download_url: url,
            },
            map_name: Some(map.to_owned()),
        }
    }

    fn mod_entry(url: String, size: usize) -> Installable {
        Installable {
            id: 39755,
            kind: CatalogueKind::Mod,
            title: "Flag avatar".to_owned(),
            page_url: "https://www.moh-db.com/mods/43007-flag-avatar".to_owned(),
            file: MohDbFile {
                filename: "zzz-flag.pk3".to_owned(),
                file_size: FileSize::new(size as u64),
                download_url: url,
            },
            map_name: None,
        }
    }

    fn installed(path: std::path::PathBuf, bytes: &[u8]) -> InstalledItem {
        fs::write(&path, bytes).expect("package");
        InstalledItem {
            id: 4301,
            kind: CatalogueKind::Map,
            title: "Snipertown".to_owned(),
            page_url: None,
            filename: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            sha256: sha256_file(&path).expect("hash"),
            size: bytes.len() as u64,
            path,
            installed_at: 1_700_000_000,
        }
    }

    #[tokio::test]
    async fn an_entry_is_downloaded_confirmed_and_installed_without_a_join() {
        let body = package("dm/snipertown");
        let url = serve(body.clone(), false).await;
        let game = TempDir::new().expect("game folder");
        let staging = TempDir::new().expect("staging");
        let steps = std::sync::Mutex::new(Vec::new());

        let installed = install_entry(
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

        let refused = install_entry(
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

        let cancelled = install_entry(
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

    #[tokio::test]
    async fn a_mod_that_is_one_pk3_installs_without_a_map_to_confirm() {
        let body = mod_package("players/allied_flag/flag.tga");
        let url = serve(body.clone(), false).await;
        let game = TempDir::new().expect("game folder");
        let staging = TempDir::new().expect("staging");

        let installed = install_entry(
            &mod_entry(url, body.len()),
            game.path(),
            staging.path(),
            |_| {},
            &Notify::new(),
        )
        .await
        .expect("installed");

        assert_eq!(installed.path, game.path().join("zzz-flag.pk3"));
        assert_eq!(installed.kind, CatalogueKind::Mod);
        assert_eq!(installed.title, "Flag avatar");
    }

    #[tokio::test]
    async fn a_mod_carrying_a_program_library_never_reaches_the_game_folder() {
        let body = mod_package("opengl32.dll");
        let url = serve(body.clone(), false).await;
        let game = TempDir::new().expect("game folder");
        let staging = TempDir::new().expect("staging");

        let refused = install_entry(
            &mod_entry(url, body.len()),
            game.path(),
            staging.path(),
            |_| {},
            &Notify::new(),
        )
        .await;

        assert!(refused.is_err());
        assert_eq!(fs::read_dir(game.path()).expect("game folder").count(), 0);
    }

    #[test]
    fn remove_deletes_a_package_only_while_it_is_the_file_reveille_wrote() {
        let game = TempDir::new().expect("game folder");
        let mine = installed(game.path().join("snipertown.pk3"), b"pk3 bytes");
        remove_package(&mine).expect("removed");
        assert!(!mine.path.exists());

        let changed = installed(game.path().join("rockbound.pk3"), b"pk3 bytes");
        fs::write(&changed.path, b"edited by hand").expect("edit");
        assert!(remove_package(&changed).is_err());
        assert!(changed.path.exists(), "a changed file is left alone");
    }

    #[test]
    fn installed_lists_this_games_packages_newest_first_and_marks_changed_ones() {
        let main = TempDir::new().expect("main");
        let elsewhere = TempDir::new().expect("another game");
        let mut older = installed(main.path().join("older.pk3"), b"old");
        older.installed_at = 1;
        older.title = String::new();
        let newer = installed(main.path().join("newer.pk3"), b"newer");
        let other_game = installed(elsewhere.path().join("other.pk3"), b"x");
        let gone = InstalledItem {
            path: main.path().join("gone.pk3"),
            ..newer.clone()
        };
        let changed = installed(main.path().join("changed.pk3"), b"one");
        fs::write(&changed.path, b"three").expect("edit");

        let payload = installed_payload(
            &[older, newer, other_game, gone, changed],
            &[main.path().to_path_buf()],
        );

        let listed = payload
            .items
            .iter()
            .map(|item| (item.filename.as_str(), item.title.as_str(), item.changed))
            .collect::<Vec<_>>();
        assert_eq!(
            listed,
            [
                ("newer.pk3", "Snipertown", false),
                ("changed.pk3", "Snipertown", true),
                ("older.pk3", "older.pk3", false),
            ]
        );
        assert_eq!(payload.total_size, 5 + 5 + 3);
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
    fn only_the_games_own_numbered_paks_count_as_stock() {
        for stock in ["main/Pak0.pk3", "mainta/pak1.pk3", "maintt/PAK5.PK3"] {
            assert!(is_stock_archive(std::path::Path::new(stock)), "{stock}");
        }
        for custom in [
            "main/pak.pk3",
            "main/pakistan.pk3",
            "main/user-pak1.pk3",
            "main/zzz.pk3",
        ] {
            assert!(!is_stock_archive(std::path::Path::new(custom)), "{custom}");
        }
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
