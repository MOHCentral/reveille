// SPDX-License-Identifier: GPL-3.0-only

//! Browsing the moh-db catalogue page by page, as opposed to resolving one wanted map.

use reqwest::Url;
use serde::{Deserialize, Serialize};

use super::archive::validate_package_filename;
use super::mohdb::{
    CatalogueCandidate, FileSize, MAPS_ENDPOINT, MODS_ENDPOINT, MohDbClient, MohDbError, MohDbFile,
    classify_request_error,
};
use crate::discovery::TargetGame;
use crate::mapindex::MapKey;

/// Entries per browse page: four rows of cards at the default width, and a short table.
pub const BROWSE_PAGE_SIZE: usize = 48;
// The site serves pages at `/maps/{vid}-{slug}` and `/mods/{vid}-{slug}`, keyed by revision rather
// than node; the API publishes no page URL of its own.
const SITE_MAPS: &str = "https://www.moh-db.com/maps/";
const SITE_MODS: &str = "https://www.moh-db.com/mods/";
// Image paths the API gives without a host are served from moh-db's storage host.
const IMAGE_BASE: &str = "https://storage.moh-db.com/";
// A screenshot is a few hundred kilobytes; anything far larger is not one worth holding in memory.
const IMAGE_LIMIT: u64 = 4 * 1024 * 1024;

/// Which of moh-db's two listings an entry comes from.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogueKind {
    /// A custom map, matched against what servers run.
    #[default]
    Map,
    /// Anything else moh-db lists: skins, gametypes, tools.
    Mod,
}

impl CatalogueKind {
    const fn endpoint(self) -> &'static str {
        match self {
            Self::Map => MAPS_ENDPOINT,
            Self::Mod => MODS_ENDPOINT,
        }
    }
}

/// A map's game mode, as its map name's directory spells it.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MapMode {
    /// `dm/`: free-for-all and team deathmatch.
    Deathmatch,
    /// `obj/`: objective.
    Objective,
    /// `lib/`: Spearhead and Breakthrough's liberation.
    Liberation,
}

impl MapMode {
    /// The directory every map of this mode lives under.
    #[must_use]
    pub const fn prefix(self) -> &'static str {
        match self {
            Self::Deathmatch => "dm/",
            Self::Objective => "obj/",
            Self::Liberation => "lib/",
        }
    }
}

/// moh-db's `gameType` value for a game.
const fn game_type(game: TargetGame) -> &'static str {
    match game {
        TargetGame::AlliedAssault => "MOHAA",
        TargetGame::Spearhead => "MOHSH",
        TargetGame::Breakthrough => "MOHBT",
    }
}

/// Which order the catalogue lists its entries in.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogueSort {
    /// Most downloaded first.
    #[default]
    Popular,
    /// Most recently added first.
    Newest,
    /// Alphabetical by title.
    Name,
}

impl CatalogueSort {
    /// The Spring `sort` parameter for this order in `kind`'s listing.
    // Both endpoints answer 500 when sorting by `added` or `title`; node id tracks the date added
    // and the map or mod name is the only sortable name.
    #[must_use]
    pub const fn parameter(self, kind: CatalogueKind) -> &'static str {
        match (self, kind) {
            (Self::Popular, _) => "downloads,desc",
            (Self::Newest, _) => "nid,desc",
            (Self::Name, CatalogueKind::Map) => "mapName,asc",
            (Self::Name, CatalogueKind::Mod) => "modName,asc",
        }
    }
}

/// One browse request.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CatalogueQuery {
    /// Maps or mods.
    pub kind: CatalogueKind,
    /// Free text typed by the player, matched against titles, or map names when it has a slash.
    pub search: String,
    /// Listing order.
    pub sort: CatalogueSort,
    /// Zero-based page number.
    pub page: usize,
    /// Only maps of this mode. Ignored for mods.
    pub mode: Option<MapMode>,
    /// Only mods for this game. Ignored for maps, whose records carry no game and whose filter
    /// moh-db ignores.
    pub game: Option<TargetGame>,
}

impl CatalogueQuery {
    /// The query string moh-db's endpoint for this kind takes for this request.
    #[must_use]
    pub fn parameters(&self) -> Vec<(&'static str, String)> {
        let mut parameters = vec![
            ("size", BROWSE_PAGE_SIZE.to_string()),
            ("page", self.page.to_string()),
            ("sort", self.sort.parameter(self.kind).to_owned()),
        ];
        let search = self.search.trim();
        match self.kind {
            CatalogueKind::Map => {
                // `dm/snipertown` is a map name; `Snipertown` is a title. moh-db's map name filter
                // matches anywhere in the name, so a mode is its directory. A typed map name
                // already names its directory and takes the mode's place.
                if search.contains(['/', '\\']) {
                    parameters.push(("mapName", search.to_owned()));
                } else {
                    if !search.is_empty() {
                        parameters.push(("title", search.to_owned()));
                    }
                    if let Some(mode) = self.mode {
                        parameters.push(("mapName", mode.prefix().to_owned()));
                    }
                }
            }
            CatalogueKind::Mod => {
                if !search.is_empty() {
                    parameters.push(("title", search.to_owned()));
                }
                if let Some(game) = self.game {
                    parameters.push(("gameType", game_type(game).to_owned()));
                }
            }
        }
        parameters
    }
}

/// One catalogue entry as a player browses it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CatalogueEntry {
    /// moh-db node identifier. Maps and mods share Drupal's node table, so it is unique across
    /// both listings.
    pub id: u64,
    /// Map or mod.
    pub kind: CatalogueKind,
    /// Display title, falling back to the map name.
    pub title: String,
    /// Map name as moh-db spells it, when it has one.
    pub map_name: Option<String>,
    /// The shared normalisation of `map_name`, matched against what servers are running.
    pub map_key: Option<MapKey>,
    /// Who made it.
    pub author: Option<String>,
    /// Description as plain text.
    pub description: Option<String>,
    /// Setting, such as a theatre or season.
    pub theme: Option<String>,
    /// Game modes the map supports, as moh-db words them.
    pub modes: Option<String>,
    /// moh-db's size class for the map itself, not the download.
    pub size_class: Option<String>,
    /// When it was added, in Unix seconds.
    pub added: Option<i64>,
    /// moh-db's average rating.
    pub rating: Option<f64>,
    /// Download count.
    pub downloads: u64,
    /// How many screenshots moh-db holds for it.
    pub image_count: usize,
    /// The entry's page on moh-db.
    pub page_url: String,
    /// What kind of mod it is, as moh-db words it.
    pub mod_type: Option<String>,
    /// The mod's version.
    pub version: Option<String>,
    /// What the mod needs besides the game.
    pub requires: Option<String>,
    /// The author's installation instructions, as plain text.
    pub install_notes: Option<String>,
    /// The single package Reveille can install, map or mod.
    pub file: Option<MohDbFile>,
    /// The name of a download Reveille will not install itself, such as a mod's `.zip`.
    pub archive_name: Option<String>,
    /// For a map, the same file as a name-level candidate, which installation confirms the
    /// archive against.
    pub candidate: Option<CatalogueCandidate>,
    #[serde(skip)]
    images: Vec<String>,
}

impl CatalogueEntry {
    /// The screenshot at `index`, as an HTTPS URL on a moh-db host.
    #[must_use]
    pub fn image_url(&self, index: usize) -> Option<&str> {
        self.images.get(index).map(String::as_str)
    }
}

/// One browse page.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BrowsePage {
    /// Entries on this page, in the order moh-db listed them.
    pub entries: Vec<CatalogueEntry>,
    /// Entries matching the query across every page.
    pub total_elements: usize,
    /// This page's number.
    pub page: usize,
    /// Whether a further page exists.
    pub has_more: bool,
}

/// A screenshot fetched from moh-db.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogueImage {
    /// Media type, one of the raster formats a webview shows.
    pub media_type: &'static str,
    /// The image bytes.
    pub bytes: Vec<u8>,
}

impl MohDbClient {
    /// Fetch one page of the maps or mods catalogue.
    ///
    /// # Errors
    ///
    /// Returns an error for a timeout, an HTTP error, or a reply that does not match the schema.
    pub async fn browse(&self, query: &CatalogueQuery) -> Result<BrowsePage, MohDbError> {
        let response = self
            .http()
            .get(query.kind.endpoint())
            .query(&query.parameters())
            .send()
            .await
            .map_err(classify_request_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(MohDbError::Status(status));
        }
        Ok(match query.kind {
            CatalogueKind::Map => response
                .json::<BrowsePageWire<BrowseMapWire>>()
                .await
                .map_err(MohDbError::Malformed)?
                .into_page(query.page, BrowseMapWire::into_entry),
            CatalogueKind::Mod => response
                .json::<BrowsePageWire<BrowseModWire>>()
                .await
                .map_err(MohDbError::Malformed)?
                .into_page(query.page, BrowseModWire::into_entry),
        })
    }

    /// Fetch a screenshot named by [`CatalogueEntry::image_url`].
    ///
    /// # Errors
    ///
    /// Refuses a URL off moh-db's hosts, a reply that is not a raster image, or one over 4 MiB.
    pub async fn fetch_image(&self, url: &str) -> Result<CatalogueImage, MohDbError> {
        if image_url(url).as_deref() != Some(url) {
            return Err(MohDbError::NotAnImage);
        }
        let mut response = self
            .http()
            .get(url)
            .send()
            .await
            .map_err(classify_request_error)?;
        if !response.status().is_success() {
            return Err(MohDbError::Status(response.status()));
        }
        let media_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(raster_type)
            .ok_or(MohDbError::NotAnImage)?;
        if response
            .content_length()
            .is_some_and(|length| length > IMAGE_LIMIT)
        {
            return Err(MohDbError::ImageTooLarge);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(classify_request_error)? {
            bytes.extend_from_slice(&chunk);
            if bytes.len() as u64 > IMAGE_LIMIT {
                return Err(MohDbError::ImageTooLarge);
            }
        }
        Ok(CatalogueImage { media_type, bytes })
    }
}

/// The address of an entry's page on moh-db, `/maps/{vid}-{slug}` or `/mods/{vid}-{slug}`.
#[must_use]
pub fn page_url(kind: CatalogueKind, vid: u64, title: &str) -> String {
    let site = match kind {
        CatalogueKind::Map => SITE_MAPS,
        CatalogueKind::Mod => SITE_MODS,
    };
    let mut slug = String::with_capacity(title.len());
    for character in title.trim().chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
        } else if !slug.ends_with('-') && !slug.is_empty() {
            slug.push('-');
        }
    }
    let slug = slug.trim_end_matches('-');
    if slug.is_empty() {
        format!("{site}{vid}")
    } else {
        format!("{site}{vid}-{slug}")
    }
}

/// Resolve an image reference from the API to an HTTPS URL on a moh-db host, or nothing.
fn image_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let mut url = if raw.starts_with("https://") || raw.starts_with("http://") {
        Url::parse(raw).ok()?
    } else {
        Url::parse(IMAGE_BASE)
            .ok()?
            .join(raw.trim_start_matches('/'))
            .ok()?
    };
    let host = url.host_str()?.to_ascii_lowercase();
    if host != "moh-db.com" && !host.ends_with(".moh-db.com") {
        return None;
    }
    if url.scheme() == "http" {
        url.set_scheme("https").ok()?;
    }
    Some(url.into())
}

fn raster_type(content_type: &str) -> Option<&'static str> {
    let essence = content_type.split(';').next()?.trim().to_ascii_lowercase();
    match essence.as_str() {
        "image/jpeg" | "image/jpg" => Some("image/jpeg"),
        "image/png" => Some("image/png"),
        "image/webp" => Some("image/webp"),
        "image/gif" => Some("image/gif"),
        _ => None,
    }
}

/// moh-db's text fields come from a CMS and may carry markup; the interface shows plain text.
fn plain_text(raw: &str) -> Option<String> {
    let mut text = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find('<') {
        text.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            rest = "";
            break;
        };
        let tag = rest[start + 1..start + end].trim().to_ascii_lowercase();
        if tag.starts_with("br") || tag.starts_with("/p") || tag.starts_with("/li") {
            text.push('\n');
        }
        rest = &rest[start + end + 1..];
    }
    text.push_str(rest);
    let decoded = text
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#039;", "'")
        .replace("&amp;", "&");
    let lines = decoded
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

#[derive(Debug, Deserialize)]
struct BrowsePageWire<Record> {
    content: Vec<Record>,
    #[serde(rename = "totalElements")]
    total_elements: usize,
    last: Option<bool>,
}

impl<Record> BrowsePageWire<Record> {
    fn into_page(
        self,
        page: usize,
        into_entry: impl Fn(Record) -> Option<CatalogueEntry>,
    ) -> BrowsePage {
        let seen = (page + 1).saturating_mul(BROWSE_PAGE_SIZE);
        let has_more = self.last.map_or(seen < self.total_elements, |last| !last);
        BrowsePage {
            entries: self.content.into_iter().filter_map(into_entry).collect(),
            total_elements: self.total_elements,
            page,
            has_more,
        }
    }
}

#[derive(Debug, Deserialize)]
struct BrowseMapWire {
    nid: u64,
    vid: u64,
    title: Option<String>,
    #[serde(rename = "mapName")]
    map_name: Option<String>,
    #[serde(rename = "mapCreator")]
    map_creator: Option<String>,
    #[serde(rename = "mapDescription")]
    map_description: Option<String>,
    #[serde(rename = "mapsTheme")]
    maps_theme: Option<String>,
    #[serde(rename = "featureModes")]
    feature_modes: Option<String>,
    #[serde(rename = "mapSize")]
    map_size: Option<String>,
    #[serde(rename = "mapFileTested")]
    map_file_tested: Option<String>,
    downloads: Option<u64>,
    images: Option<Vec<String>>,
    added: Option<i64>,
    rating: Option<f64>,
    #[serde(rename = "mapFile")]
    map_file: Option<BrowseFileWire>,
    #[serde(rename = "downloadLink")]
    download_link: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BrowseFileWire {
    filename: Option<String>,
    filesize: Option<u64>,
    #[serde(rename = "downloadLink")]
    download_link: Option<String>,
}

impl BrowseMapWire {
    fn into_entry(self) -> Option<CatalogueEntry> {
        let map_name = self.map_name.filter(|name| !name.trim().is_empty());
        let title = self
            .title
            .as_deref()
            .and_then(plain_text)
            .or_else(|| map_name.clone())?;
        let map_key = map_name.as_deref().and_then(MapKey::new);
        let file = self
            .map_file
            .and_then(|file| file.into_package(self.download_link));
        let candidate = match (&map_key, &file) {
            (Some(key), Some(file)) => Some(CatalogueCandidate {
                id: self.nid,
                map_name: map_name.clone().unwrap_or_default(),
                map_key: key.clone(),
                filename: file.filename.clone(),
                file_size: file.file_size,
                map_file_tested: self
                    .map_file_tested
                    .is_some_and(|value| !value.trim().is_empty()),
                downloads: self.downloads.unwrap_or(0),
                download_url: file.download_url.clone(),
            }),
            _ => None,
        };
        let images = screenshots(self.images);
        Some(CatalogueEntry {
            id: self.nid,
            kind: CatalogueKind::Map,
            page_url: page_url(CatalogueKind::Map, self.vid, &title),
            title,
            map_name,
            map_key,
            author: self.map_creator.as_deref().and_then(plain_text),
            description: self.map_description.as_deref().and_then(plain_text),
            theme: self.maps_theme.as_deref().and_then(plain_text),
            modes: self.feature_modes.as_deref().and_then(plain_text),
            size_class: self.map_size.as_deref().and_then(plain_text),
            added: self.added.map(unix_seconds),
            rating: self.rating.filter(|rating| rating.is_finite()),
            downloads: self.downloads.unwrap_or(0),
            image_count: images.len(),
            images,
            mod_type: None,
            version: None,
            requires: None,
            install_notes: None,
            // A map without a confirmable name is not offered: install proves the archive holds it.
            file: candidate.as_ref().and(file),
            archive_name: None,
            candidate,
        })
    }
}

impl BrowseFileWire {
    /// This file as one Reveille can install, or nothing when it is not a single safe `.pk3`.
    fn into_package(self, download_link: Option<String>) -> Option<MohDbFile> {
        let filename = self.filename?;
        validate_package_filename(&filename).ok()?;
        Some(MohDbFile {
            filename,
            file_size: FileSize::new(self.filesize?),
            download_url: download_link.or(self.download_link)?,
        })
    }
}

#[derive(Debug, Deserialize)]
struct BrowseModWire {
    nid: u64,
    vid: u64,
    title: Option<String>,
    #[serde(rename = "modName")]
    mod_name: Option<String>,
    #[serde(rename = "modCreator")]
    mod_creator: Option<String>,
    #[serde(rename = "shortDescription")]
    short_description: Option<String>,
    #[serde(rename = "modDescription")]
    mod_description: Option<String>,
    #[serde(rename = "modInstall")]
    mod_install: Option<String>,
    #[serde(rename = "modRequires")]
    mod_requires: Option<String>,
    #[serde(rename = "modVersion")]
    mod_version: Option<String>,
    #[serde(rename = "typeOfMod")]
    type_of_mod: Option<String>,
    downloads: Option<u64>,
    images: Option<Vec<String>>,
    added: Option<i64>,
    rating: Option<f64>,
    file: Option<BrowseFileWire>,
    #[serde(rename = "downloadLink")]
    download_link: Option<String>,
    #[serde(rename = "pk3File")]
    pk3_file: Option<BrowseFileWire>,
    #[serde(rename = "pk3DownloadLink")]
    pk3_download_link: Option<String>,
}

impl BrowseModWire {
    fn into_entry(self) -> Option<CatalogueEntry> {
        let title = self
            .title
            .as_deref()
            .and_then(plain_text)
            .or_else(|| self.mod_name.as_deref().and_then(plain_text))?;
        let archive_name = self
            .file
            .as_ref()
            .and_then(|file| file.filename.clone())
            .filter(|name| !name.trim().is_empty());
        // Only a mod that ships as one `.pk3` installs in one click: anything else is an archive
        // whose files could belong anywhere in the game folder, and its author's notes say where.
        let file = match self.pk3_file {
            Some(pk3) => pk3.into_package(self.pk3_download_link),
            None => self
                .file
                .and_then(|file| file.into_package(self.download_link)),
        };
        let images = screenshots(self.images);
        Some(CatalogueEntry {
            id: self.nid,
            kind: CatalogueKind::Mod,
            page_url: page_url(CatalogueKind::Mod, self.vid, &title),
            title,
            map_name: None,
            map_key: None,
            author: self.mod_creator.as_deref().and_then(plain_text),
            description: self
                .short_description
                .as_deref()
                .and_then(plain_text)
                .or_else(|| self.mod_description.as_deref().and_then(plain_text)),
            theme: None,
            modes: None,
            size_class: None,
            added: self.added.map(unix_seconds),
            rating: self.rating.filter(|rating| rating.is_finite()),
            downloads: self.downloads.unwrap_or(0),
            image_count: images.len(),
            images,
            mod_type: self.type_of_mod.as_deref().and_then(plain_text),
            version: self.mod_version.as_deref().and_then(plain_text),
            requires: self.mod_requires.as_deref().and_then(plain_text),
            install_notes: self.mod_install.as_deref().and_then(plain_text),
            archive_name: if file.is_some() { None } else { archive_name },
            file,
            candidate: None,
        })
    }
}

fn screenshots(raw: Option<Vec<String>>) -> Vec<String> {
    raw.unwrap_or_default()
        .iter()
        .filter_map(|raw| image_url(raw))
        .collect()
}

// Drupal stores seconds; a value this large can only be milliseconds.
const fn unix_seconds(added: i64) -> i64 {
    if added > 100_000_000_000 {
        added / 1000
    } else {
        added
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BrowseMapWire, BrowseModWire, BrowsePageWire, CatalogueKind, CatalogueQuery, CatalogueSort,
        MapMode, image_url, page_url, plain_text, raster_type,
    };
    use crate::discovery::TargetGame;

    #[test]
    fn a_search_with_a_slash_looks_up_map_names_and_anything_else_titles() {
        let titles = CatalogueQuery {
            search: " Snipertown ".to_owned(),
            sort: CatalogueSort::Newest,
            page: 2,
            ..CatalogueQuery::default()
        };
        assert_eq!(
            titles.parameters(),
            [
                ("size", "48".to_owned()),
                ("page", "2".to_owned()),
                ("sort", "nid,desc".to_owned()),
                ("title", "Snipertown".to_owned()),
            ]
        );
        let names = CatalogueQuery {
            search: "dm/snipertown".to_owned(),
            ..CatalogueQuery::default()
        };
        assert_eq!(
            names.parameters().last(),
            Some(&("mapName", "dm/snipertown".to_owned()))
        );
        assert_eq!(CatalogueQuery::default().parameters().len(), 3);
    }

    #[test]
    fn a_mode_narrows_maps_to_its_directory_unless_a_map_name_was_typed() {
        let objective = CatalogueQuery {
            search: "docks".to_owned(),
            mode: Some(MapMode::Objective),
            ..CatalogueQuery::default()
        };
        assert_eq!(
            objective.parameters()[3..],
            [
                ("title", "docks".to_owned()),
                ("mapName", "obj/".to_owned())
            ]
        );
        let typed = CatalogueQuery {
            search: "dm/snipertown".to_owned(),
            mode: Some(MapMode::Objective),
            ..CatalogueQuery::default()
        };
        assert_eq!(
            typed.parameters()[3..],
            [("mapName", "dm/snipertown".to_owned())]
        );
    }

    #[test]
    fn mods_are_asked_for_by_title_for_the_game_being_played() {
        let mods = CatalogueQuery {
            kind: CatalogueKind::Mod,
            search: "dm/skins".to_owned(),
            sort: CatalogueSort::Name,
            mode: Some(MapMode::Deathmatch),
            game: Some(TargetGame::Spearhead),
            ..CatalogueQuery::default()
        };
        assert_eq!(
            mods.parameters(),
            [
                ("size", "48".to_owned()),
                ("page", "0".to_owned()),
                ("sort", "modName,asc".to_owned()),
                ("title", "dm/skins".to_owned()),
                ("gameType", "MOHSH".to_owned()),
            ]
        );
    }

    #[test]
    fn page_links_follow_the_sites_id_and_slug_pattern() {
        assert_eq!(
            page_url(CatalogueKind::Map, 4291, "Snipervalley"),
            "https://www.moh-db.com/maps/4291-snipervalley"
        );
        assert_eq!(
            page_url(CatalogueKind::Map, 12, "  V2 Rocket Facility (Final)!"),
            "https://www.moh-db.com/maps/12-v2-rocket-facility-final"
        );
        assert_eq!(
            page_url(CatalogueKind::Map, 7, "***"),
            "https://www.moh-db.com/maps/7"
        );
        assert_eq!(
            page_url(CatalogueKind::Mod, 43007, "Allies Flag Avatar"),
            "https://www.moh-db.com/mods/43007-allies-flag-avatar"
        );
    }

    #[test]
    fn only_https_images_on_moh_db_hosts_are_fetched() {
        assert_eq!(
            image_url("https://storage.moh-db.com/MOHAA-MAP-IMAGE/a.jpg").as_deref(),
            Some("https://storage.moh-db.com/MOHAA-MAP-IMAGE/a.jpg")
        );
        assert_eq!(
            image_url("http://www.moh-db.com/a.png").as_deref(),
            Some("https://www.moh-db.com/a.png")
        );
        assert_eq!(
            image_url("/MOHAA-MAP-IMAGE/b.jpg").as_deref(),
            Some("https://storage.moh-db.com/MOHAA-MAP-IMAGE/b.jpg")
        );
        assert_eq!(image_url("https://evil.example/moh-db.com/a.jpg"), None);
        assert_eq!(image_url("https://moh-db.com.evil.example/a.jpg"), None);
        assert_eq!(image_url(""), None);
        assert_eq!(
            raster_type("image/JPEG; charset=binary"),
            Some("image/jpeg")
        );
        assert_eq!(raster_type("image/svg+xml"), None);
        assert_eq!(raster_type("text/html"), None);
    }

    #[test]
    fn markup_in_text_fields_reads_as_plain_text() {
        assert_eq!(
            plain_text("<p>A sniper town &amp; a <b>bell</b> tower.</p><p>8&nbsp;to 20</p>")
                .as_deref(),
            Some("A sniper town & a bell tower.\n8 to 20")
        );
        assert_eq!(plain_text("  <br/> "), None);
    }

    #[test]
    fn parses_a_browse_page_with_the_published_map_fields() {
        let page: BrowsePageWire<BrowseMapWire> =
            serde_json::from_str(include_str!("../../tests/fixtures/mohdb_browse_page.json"))
                .expect("valid browse page");
        let page = page.into_page(0, BrowseMapWire::into_entry);

        assert_eq!(page.total_elements, 3);
        assert!(!page.has_more);
        assert_eq!(page.entries.len(), 3);
        let snipertown = &page.entries[0];
        assert_eq!(snipertown.title, "Snipertown");
        assert_eq!(snipertown.author.as_deref(), Some("Dr. Fragg"));
        assert_eq!(
            snipertown
                .map_key
                .as_ref()
                .map(crate::mapindex::MapKey::as_str),
            Some("dm/snipertown")
        );
        assert_eq!(snipertown.image_count, 2);
        assert_eq!(
            snipertown.image_url(1),
            Some("https://storage.moh-db.com/MOHAA-MAP-IMAGE/snipertown_2.jpg")
        );
        assert_eq!(snipertown.added, Some(1_700_000_000));
        let candidate = snipertown.candidate.as_ref().expect("installable");
        assert_eq!(candidate.filename, "snipertown.pk3");
        assert_eq!(candidate.file_size.get(), 14_889_000);
        assert_eq!(
            snipertown.page_url,
            "https://www.moh-db.com/maps/9101-snipertown"
        );

        // No file on moh-db: still listed, but nothing to install.
        assert!(page.entries[1].candidate.is_none());
        assert_eq!(page.entries[1].description, None);
        // A filename that could escape the game folder is never offered.
        assert!(page.entries[2].candidate.is_none());
    }

    #[test]
    fn only_a_mod_that_ships_as_one_pk3_can_be_installed() {
        let page: BrowsePageWire<BrowseModWire> =
            serde_json::from_str(include_str!("../../tests/fixtures/mohdb_mods_page.json"))
                .expect("valid mods page");
        let page = page.into_page(0, BrowseModWire::into_entry);

        assert_eq!(page.entries.len(), 3);
        assert!(page.has_more);
        let avatar = &page.entries[0];
        assert_eq!(avatar.kind, CatalogueKind::Mod);
        assert_eq!(avatar.mod_type.as_deref(), Some("Avatar"));
        assert_eq!(avatar.version.as_deref(), Some("v1.0"));
        assert_eq!(
            avatar.page_url,
            "https://www.moh-db.com/mods/43007-allies-american-flag-waving-avatar"
        );
        let file = avatar.file.as_ref().expect("a single pk3");
        assert_eq!(file.filename, "zzzzzz-AlliesFlagWaving_v1.pk3");
        assert_eq!(file.file_size.get(), 2789);
        assert!(avatar.candidate.is_none());
        assert_eq!(avatar.archive_name, None);

        // A .zip whose files go who knows where: its notes and page, not an Install button.
        let patch = &page.entries[1];
        assert!(patch.file.is_none());
        assert_eq!(patch.archive_name.as_deref(), Some("mohaa_win8_patch.zip"));
        assert_eq!(
            patch.install_notes.as_deref(),
            Some("Copy opengl32.dll next to MOHAA.exe.\nNot into main.")
        );
        assert_eq!(
            patch.description.as_deref(),
            Some("Runs MOHAA on Windows 8.")
        );

        // A separate .pk3 beside an archive is the one installed.
        let skins = &page.entries[2];
        assert_eq!(
            skins.file.as_ref().map(|file| file.download_url.as_str()),
            Some("https://storage.moh-db.com/MOHAA-MOD-FILE/skins.pk3")
        );
    }
}
