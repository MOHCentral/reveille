// SPDX-License-Identifier: GPL-3.0-only

//! Browsing the moh-db catalogue page by page, as opposed to resolving one wanted map.

use reqwest::Url;
use serde::{Deserialize, Serialize};

use super::archive::validate_package_filename;
use super::mohdb::{
    CatalogueCandidate, FileSize, MAPS_ENDPOINT, MohDbClient, MohDbError, classify_request_error,
};
use crate::mapindex::MapKey;

/// Entries per browse page: four rows of cards at the default width, and a short table.
pub const BROWSE_PAGE_SIZE: usize = 48;
// The site serves map pages at `/maps/{vid}-{slug}`, keyed by revision rather than node; the API
// publishes no page URL of its own.
const SITE_MAPS: &str = "https://www.moh-db.com/maps/";
// Image paths the API gives without a host are served from moh-db's storage host.
const IMAGE_BASE: &str = "https://storage.moh-db.com/";
// A screenshot is a few hundred kilobytes; anything far larger is not one worth holding in memory.
const IMAGE_LIMIT: u64 = 4 * 1024 * 1024;

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
    /// The Spring `sort` parameter for this order.
    // The endpoint answers 500 when sorting by `added` or `title`; node id tracks the date added
    // and the map name is the only sortable name.
    #[must_use]
    pub const fn parameter(self) -> &'static str {
        match self {
            Self::Popular => "downloads,desc",
            Self::Newest => "nid,desc",
            Self::Name => "mapName,asc",
        }
    }
}

/// One browse request.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct CatalogueQuery {
    /// Free text typed by the player, matched against titles, or map names when it has a slash.
    pub search: String,
    /// Listing order.
    pub sort: CatalogueSort,
    /// Zero-based page number.
    pub page: usize,
}

impl CatalogueQuery {
    /// The query string moh-db's maps endpoint takes for this request.
    #[must_use]
    pub fn parameters(&self) -> Vec<(&'static str, String)> {
        let mut parameters = vec![
            ("size", BROWSE_PAGE_SIZE.to_string()),
            ("page", self.page.to_string()),
            ("sort", self.sort.parameter().to_owned()),
        ];
        let search = self.search.trim();
        if !search.is_empty() {
            // `dm/snipertown` is a map name; `Snipertown` is a title.
            let field = if search.contains(['/', '\\']) {
                "mapName"
            } else {
                "title"
            };
            parameters.push((field, search.to_owned()));
        }
        parameters
    }
}

/// One catalogue entry as a player browses it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CatalogueEntry {
    /// moh-db node identifier.
    pub id: u64,
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
    /// The downloadable file, when moh-db has one Reveille can install.
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
    /// Fetch one page of the maps catalogue.
    ///
    /// # Errors
    ///
    /// Returns an error for a timeout, an HTTP error, or a reply that does not match the schema.
    pub async fn browse(&self, query: &CatalogueQuery) -> Result<BrowsePage, MohDbError> {
        let response = self
            .http()
            .get(MAPS_ENDPOINT)
            .query(&query.parameters())
            .send()
            .await
            .map_err(classify_request_error)?;
        let status = response.status();
        if !status.is_success() {
            return Err(MohDbError::Status(status));
        }
        let page = response
            .json::<BrowsePageWire>()
            .await
            .map_err(MohDbError::Malformed)?;
        Ok(page.into_page(query.page))
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

/// The address of an entry's page on moh-db, `/maps/{vid}-{slug}`.
#[must_use]
pub fn page_url(vid: u64, title: &str) -> String {
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
        format!("{SITE_MAPS}{vid}")
    } else {
        format!("{SITE_MAPS}{vid}-{slug}")
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
struct BrowsePageWire {
    content: Vec<BrowseMapWire>,
    #[serde(rename = "totalElements")]
    total_elements: usize,
    last: Option<bool>,
}

impl BrowsePageWire {
    fn into_page(self, page: usize) -> BrowsePage {
        let seen = (page + 1).saturating_mul(BROWSE_PAGE_SIZE);
        let has_more = self.last.map_or(seen < self.total_elements, |last| !last);
        BrowsePage {
            entries: self
                .content
                .into_iter()
                .filter_map(BrowseMapWire::into_entry)
                .collect(),
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
        let candidate = match (&map_key, self.map_file) {
            (Some(key), Some(file)) => {
                let download_url = self.download_link.or(file.download_link);
                match (file.filename, file.filesize, download_url) {
                    (Some(filename), Some(size), Some(download_url))
                        if validate_package_filename(&filename).is_ok() =>
                    {
                        Some(CatalogueCandidate {
                            id: self.nid,
                            map_name: map_name.clone().unwrap_or_default(),
                            map_key: key.clone(),
                            filename,
                            file_size: FileSize::new(size),
                            map_file_tested: self
                                .map_file_tested
                                .is_some_and(|value| !value.trim().is_empty()),
                            downloads: self.downloads.unwrap_or(0),
                            download_url,
                        })
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        let images = self
            .images
            .unwrap_or_default()
            .iter()
            .filter_map(|raw| image_url(raw))
            .collect::<Vec<_>>();
        Some(CatalogueEntry {
            id: self.nid,
            page_url: page_url(self.vid, &title),
            title,
            map_name,
            map_key,
            author: self.map_creator.as_deref().and_then(plain_text),
            description: self.map_description.as_deref().and_then(plain_text),
            theme: self.maps_theme.as_deref().and_then(plain_text),
            modes: self.feature_modes.as_deref().and_then(plain_text),
            size_class: self.map_size.as_deref().and_then(plain_text),
            // Drupal stores seconds; a value this large can only be milliseconds.
            added: self.added.map(|added| {
                if added > 100_000_000_000 {
                    added / 1000
                } else {
                    added
                }
            }),
            rating: self.rating.filter(|rating| rating.is_finite()),
            downloads: self.downloads.unwrap_or(0),
            image_count: images.len(),
            images,
            candidate,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        BrowsePageWire, CatalogueQuery, CatalogueSort, image_url, page_url, plain_text, raster_type,
    };

    #[test]
    fn a_search_with_a_slash_looks_up_map_names_and_anything_else_titles() {
        let titles = CatalogueQuery {
            search: " Snipertown ".to_owned(),
            sort: CatalogueSort::Newest,
            page: 2,
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
    fn page_links_follow_the_sites_id_and_slug_pattern() {
        assert_eq!(
            page_url(4291, "Snipervalley"),
            "https://www.moh-db.com/maps/4291-snipervalley"
        );
        assert_eq!(
            page_url(12, "  V2 Rocket Facility (Final)!"),
            "https://www.moh-db.com/maps/12-v2-rocket-facility-final"
        );
        assert_eq!(page_url(7, "***"), "https://www.moh-db.com/maps/7");
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
        let page: BrowsePageWire =
            serde_json::from_str(include_str!("../../tests/fixtures/mohdb_browse_page.json"))
                .expect("valid browse page");
        let page = page.into_page(0);

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
}
