// SPDX-License-Identifier: GPL-3.0-only

//! What Reveille installed from the catalogue, so a later removal can prove a file is its own.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use reveille_core::content::CatalogueKind;
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

pub const FILENAME: &str = "installed-content.json";

/// One package Reveille put in a game folder.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct InstalledItem {
    /// moh-db node identifier.
    pub id: u64,
    /// Map or mod. Records written before mods could be installed hold maps only.
    #[serde(default)]
    pub kind: CatalogueKind,
    /// The title moh-db gave it, so Installed can name it without asking moh-db again.
    #[serde(default)]
    pub title: String,
    /// Its page on moh-db.
    #[serde(default)]
    pub page_url: Option<String>,
    /// The package's file name, as installed.
    pub filename: String,
    /// Where it was written.
    pub path: PathBuf,
    /// SHA-256 of the bytes written, lowercase hex.
    pub sha256: String,
    /// Bytes written.
    pub size: u64,
    /// When it was installed, in Unix seconds.
    pub installed_at: u64,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct RecordFile {
    v: u32,
    items: Vec<InstalledItem>,
}

/// The install record kept in the app data directory.
#[derive(Clone, Debug)]
pub struct InstallRecord {
    path: PathBuf,
}

impl InstallRecord {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(FILENAME),
        }
    }

    /// Every recorded install. A missing or unreadable record reads as empty: it only ever adds
    /// caution, since a package missing from it is treated as one Reveille did not install.
    pub fn items(&self) -> Vec<InstalledItem> {
        fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RecordFile>(&bytes).ok())
            .map(|file| file.items)
            .unwrap_or_default()
    }

    /// Record `item`, replacing an earlier record of the same file.
    pub fn add(&self, item: InstalledItem) -> io::Result<()> {
        let mut items = self.items();
        items.retain(|known| known.path != item.path);
        items.push(item);
        self.write(&RecordFile { v: 1, items })
    }

    /// Forget the install written to `path`.
    pub fn remove(&self, path: &Path) -> io::Result<()> {
        let mut items = self.items();
        items.retain(|known| known.path != path);
        self.write(&RecordFile { v: 1, items })
    }

    /// The recorded install of `id` whose file is still where it was written, if any.
    pub fn installed(items: &[InstalledItem], id: u64) -> Option<&InstalledItem> {
        items
            .iter()
            .rev()
            .find(|item| item.id == id && item.path.is_file())
    }

    /// The recorded install named `filename`, whatever its case, whose file is still where it was
    /// written. A join records server files under no moh-db id, so this is how they are found.
    pub fn installed_file<'a>(
        items: &'a [InstalledItem],
        filename: &str,
    ) -> Option<&'a InstalledItem> {
        items
            .iter()
            .rev()
            .find(|item| item.filename.eq_ignore_ascii_case(filename) && item.path.is_file())
    }

    fn write(&self, file: &RecordFile) -> io::Result<()> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("the install record has no directory"))?;
        fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
        // Written beside the record and renamed over it, so a crash mid-write never leaves
        // half a record that would read as empty.
        let mut temporary = NamedTempFile::new_in(directory)?;
        io::Write::write_all(&mut temporary, &bytes)?;
        temporary.persist(&self.path).map_err(|error| error.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::{FILENAME, InstallRecord, InstalledItem};

    fn item(id: u64, path: std::path::PathBuf) -> InstalledItem {
        InstalledItem {
            id,
            kind: reveille_core::content::CatalogueKind::Map,
            title: "Snipertown".to_owned(),
            page_url: None,
            filename: path
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path,
            sha256: "00".repeat(32),
            size: 3,
            installed_at: 1_700_000_000,
        }
    }

    #[test]
    fn an_install_is_recorded_and_survives_a_reload() {
        let data = TempDir::new().expect("data directory");
        let game = TempDir::new().expect("game directory");
        let package = game.path().join("snipertown.pk3");
        fs::write(&package, b"pk3").expect("package");
        let record = InstallRecord::new(&data.path().join("nested"));

        record.add(item(4301, package.clone())).expect("recorded");
        record
            .add(item(4301, package.clone()))
            .expect("recorded again");

        let items = InstallRecord::new(&data.path().join("nested")).items();
        assert_eq!(items.len(), 1, "the same file is recorded once");
        assert_eq!(
            InstallRecord::installed(&items, 4301).map(|item| &item.path),
            Some(&package)
        );
        assert!(InstallRecord::installed(&items, 1).is_none());
    }

    #[test]
    fn a_recorded_file_that_was_deleted_no_longer_counts_as_installed() {
        let data = TempDir::new().expect("data directory");
        let game = TempDir::new().expect("game directory");
        let package = game.path().join("gone.pk3");
        let record = InstallRecord::new(data.path());
        record.add(item(7, package)).expect("recorded");

        assert!(InstallRecord::installed(&record.items(), 7).is_none());
    }

    #[test]
    fn a_removed_install_is_forgotten_and_the_others_kept() {
        let data = TempDir::new().expect("data directory");
        let game = TempDir::new().expect("game directory");
        let record = InstallRecord::new(data.path());
        record
            .add(item(1, game.path().join("one.pk3")))
            .expect("recorded");
        record
            .add(item(2, game.path().join("two.pk3")))
            .expect("recorded");

        record
            .remove(&game.path().join("one.pk3"))
            .expect("removed");

        let ids = record
            .items()
            .iter()
            .map(|item| item.id)
            .collect::<Vec<_>>();
        assert_eq!(ids, [2]);
    }

    #[test]
    fn a_record_from_before_mods_reads_as_maps_with_no_title() {
        let data = TempDir::new().expect("data directory");
        fs::write(
            data.path().join(FILENAME),
            br#"{"v":1,"items":[{"id":7,"filename":"a.pk3","path":"a.pk3","sha256":"00","size":3,"installed_at":1}]}"#,
        )
        .expect("old record");

        let items = InstallRecord::new(data.path()).items();
        assert_eq!(items[0].kind, reveille_core::content::CatalogueKind::Map);
        assert_eq!(items[0].title, "");
    }

    #[test]
    fn an_install_is_found_by_its_file_name_whatever_its_case() {
        let game = TempDir::new().expect("game folder");
        let path = game.path().join("SniperTown.pk3");
        fs::write(&path, b"pk3").expect("package");
        let mut recorded = item(0, path);
        recorded.filename = "SniperTown.pk3".to_owned();
        let items = [recorded];
        assert!(InstallRecord::installed_file(&items, "snipertown.PK3").is_some());
        assert!(InstallRecord::installed_file(&items, "rockbound.pk3").is_none());
    }

    #[test]
    fn a_corrupt_record_reads_as_empty_rather_than_failing() {
        let data = TempDir::new().expect("data directory");
        fs::write(data.path().join(FILENAME), b"{not json").expect("corrupt record");

        assert!(InstallRecord::new(data.path()).items().is_empty());
    }
}
