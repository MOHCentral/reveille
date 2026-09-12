// SPDX-License-Identifier: GPL-2.0-only

//! Probing and one-time relocation of installations that Windows protects from writes.

use std::env;
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::path::{Component, Path, PathBuf};

use reveille_core::install::{self, INCOMPLETE_COPY_MARKER, Installation};
use thiserror::Error;
use walkdir::WalkDir;

use crate::probe_writable;

const COPY_BUFFER_SIZE: usize = 1024 * 1024;

/// Result of probing every directory Reveille may need to write during setup or a join.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallationWriteProbe {
    /// Directories whose write probe was refused by the operating system.
    pub blocked: Vec<PathBuf>,
}

impl InstallationWriteProbe {
    /// Whether every relevant directory accepted a create-and-delete probe.
    #[must_use]
    pub fn is_writable(&self) -> bool {
        self.blocked.is_empty()
    }
}

/// A measured source tree ready to be copied.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CopyPlan {
    /// Bytes in all regular files beneath the installation root.
    pub bytes: u64,
    /// Number of regular files beneath the installation root.
    pub files: u64,
}

/// Progress while copying one installation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct CopyProgress {
    /// Bytes copied so far.
    pub copied_bytes: u64,
    /// Total bytes measured before the copy started.
    pub total_bytes: u64,
    /// Files copied so far.
    pub copied_files: u64,
    /// Total files measured before the copy started.
    pub total_files: u64,
}

/// A completed and re-identified writable copy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallationCopy {
    /// Installation identified at its final destination.
    pub installation: Installation,
    /// Source size measured before copying began.
    pub source_bytes: u64,
    /// Files measured and copied.
    pub source_files: u64,
}

/// Probe the installation root and every present game-data or managed-engine directory.
///
/// Permission refusals are collected so setup can name every affected folder. Other I/O errors
/// remain errors: a missing or failing volume is not evidence that Windows protected a folder.
///
/// # Errors
///
/// Returns an error when a probe fails for a reason other than denied permission.
pub fn probe_installation_write_access(
    installation: &Installation,
) -> Result<InstallationWriteProbe, InstallationCopyError> {
    probe_installation_write_access_with(installation, probe_writable)
}

fn probe_installation_write_access_with<F>(
    installation: &Installation,
    mut probe: F,
) -> Result<InstallationWriteProbe, InstallationCopyError>
where
    F: FnMut(&Path) -> io::Result<()>,
{
    let mut directories = vec![installation.root.clone()];
    directories.extend(
        installation
            .products
            .iter()
            .map(|product| installation.root.join(product.data_directory())),
    );
    let managed = installation.root.join(".reveille-engines");
    if managed.is_dir() {
        directories.push(managed);
    }

    let mut blocked = Vec::new();
    for directory in directories {
        match probe(&directory) {
            Ok(()) => {}
            Err(source) if source.kind() == io::ErrorKind::PermissionDenied => {
                blocked.push(directory);
            }
            Err(source) => return Err(InstallationCopyError::Probe { directory, source }),
        }
    }
    Ok(InstallationWriteProbe { blocked })
}

/// Measure all regular files in an installation without following links outside it.
///
/// # Errors
///
/// Returns an error for unreadable entries, symbolic links, or a byte-count overflow.
pub fn measure_installation(source: &Path) -> Result<CopyPlan, InstallationCopyError> {
    let mut bytes = 0_u64;
    let mut files = 0_u64;
    for entry in WalkDir::new(source).follow_links(false) {
        let entry = entry.map_err(|source| InstallationCopyError::Walk { source })?;
        if entry.file_type().is_symlink() {
            return Err(InstallationCopyError::Link {
                path: entry.path().to_path_buf(),
            });
        }
        if entry.file_type().is_file() {
            let length = entry
                .metadata()
                .map_err(|source| InstallationCopyError::Walk { source })?
                .len();
            bytes = bytes
                .checked_add(length)
                .ok_or(InstallationCopyError::SourceTooLarge)?;
            files = files
                .checked_add(1)
                .ok_or(InstallationCopyError::SourceTooLarge)?;
        }
    }
    Ok(CopyPlan { bytes, files })
}

/// Suggest a non-existing destination beneath the current user's `Games` directory.
#[must_use]
pub fn suggested_destination(source: &Path) -> Option<PathBuf> {
    let home = env::var_os("USERPROFILE").or_else(|| env::var_os("HOME"))?;
    let home = PathBuf::from(home);
    if !home.is_dir() || probe_writable(&home).is_err() {
        return None;
    }
    let games = home.join("Games");
    let parent = if games.is_dir() {
        probe_writable(&games).is_ok().then_some(games)?
    } else {
        games
    };
    Some(unique_destination(
        &parent,
        source
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("MOHAA")),
    ))
}

/// Choose a non-existing child of `parent`, retaining the source folder's name.
#[must_use]
pub fn destination_in_parent(source: &Path, parent: &Path) -> PathBuf {
    unique_destination(
        parent,
        source
            .file_name()
            .unwrap_or_else(|| std::ffi::OsStr::new("MOHAA")),
    )
}

fn unique_destination(parent: &Path, name: &std::ffi::OsStr) -> PathBuf {
    let first = parent.join(name);
    if !first.exists() {
        return first;
    }
    for suffix in 2..10_000 {
        let mut candidate = OsString::from(name);
        candidate.push(format!(" ({suffix})"));
        let path = parent.join(candidate);
        if !path.exists() {
            return path;
        }
    }
    parent.join(format!("MOHAA copy {}", std::process::id()))
}

/// Copy an installation into a new directory, validate it, and report byte progress.
///
/// The source is never modified. The final destination does not appear until the complete staging
/// tree has passed `install::identify`. A marker makes both staging and failed final trees
/// unidentifiable, even if best-effort cleanup itself is interrupted.
///
/// # Errors
///
/// Returns an error before copying when space is insufficient or the destination is unsafe, and
/// cleans the partial tree on cancellation or any later failure.
pub fn copy_installation_reporting<C, P>(
    source: &Path,
    destination: &Path,
    mut cancelled: C,
    mut progress: P,
) -> Result<InstallationCopy, InstallationCopyError>
where
    C: FnMut() -> bool,
    P: FnMut(CopyProgress),
{
    copy_installation_with_space(
        source,
        destination,
        |path| fs2::available_space(path),
        &mut cancelled,
        &mut progress,
    )
}

#[expect(
    clippy::too_many_lines,
    reason = "one guarded copy transaction is easier to audit when its cleanup scope stays visible"
)]
fn copy_installation_with_space<S, C, P>(
    source: &Path,
    destination: &Path,
    available_space: S,
    cancelled: &mut C,
    progress: &mut P,
) -> Result<InstallationCopy, InstallationCopyError>
where
    S: FnOnce(&Path) -> io::Result<u64>,
    C: FnMut() -> bool,
    P: FnMut(CopyProgress),
{
    let source_installation = install::identify(source)?;
    if destination.exists() {
        return Err(InstallationCopyError::DestinationExists(
            destination.to_path_buf(),
        ));
    }
    validate_destination(&source_installation.root, destination)?;
    let plan = measure_installation(&source_installation.root)?;
    let parent = destination
        .parent()
        .ok_or_else(|| InstallationCopyError::NoDestinationParent(destination.to_path_buf()))?;
    fs::create_dir_all(parent).map_err(|source| InstallationCopyError::Filesystem {
        path: parent.to_path_buf(),
        source,
    })?;
    let available = available_space(parent).map_err(|source| InstallationCopyError::Space {
        path: parent.to_path_buf(),
        source,
    })?;
    if available < plan.bytes {
        return Err(InstallationCopyError::InsufficientSpace {
            path: destination.to_path_buf(),
            required: plan.bytes,
            available,
        });
    }

    let staging = allocate_staging(parent)?;
    let mut cleanup = PartialCopy::new(staging.clone());
    fs::write(staging.join(INCOMPLETE_COPY_MARKER), b"copy in progress\n").map_err(|source| {
        InstallationCopyError::Filesystem {
            path: staging.clone(),
            source,
        }
    })?;
    let mut copied = CopyProgress {
        copied_bytes: 0,
        total_bytes: plan.bytes,
        copied_files: 0,
        total_files: plan.files,
    };
    progress(copied);

    for entry in WalkDir::new(&source_installation.root).follow_links(false) {
        if cancelled() {
            return Err(InstallationCopyError::Cancelled);
        }
        let entry = entry.map_err(|source| InstallationCopyError::Walk { source })?;
        let relative = entry
            .path()
            .strip_prefix(&source_installation.root)
            .map_err(|_| InstallationCopyError::OutsideSource(entry.path().to_path_buf()))?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = staging.join(relative);
        if entry.file_type().is_symlink() {
            return Err(InstallationCopyError::Link {
                path: entry.path().to_path_buf(),
            });
        }
        if entry.file_type().is_dir() {
            fs::create_dir(&target).map_err(|source| InstallationCopyError::Filesystem {
                path: target,
                source,
            })?;
            continue;
        }
        if entry.file_type().is_file() {
            copy_file(entry.path(), &target, cancelled, &mut copied, progress)?;
        }
    }

    if copied.copied_bytes != plan.bytes || copied.copied_files != plan.files {
        return Err(InstallationCopyError::SourceChanged {
            expected_bytes: plan.bytes,
            copied_bytes: copied.copied_bytes,
            expected_files: plan.files,
            copied_files: copied.copied_files,
        });
    }
    if cancelled() {
        return Err(InstallationCopyError::Cancelled);
    }
    let marker = staging.join(INCOMPLETE_COPY_MARKER);
    fs::remove_file(&marker).map_err(|source| InstallationCopyError::Filesystem {
        path: marker.clone(),
        source,
    })?;
    let staged_installation =
        install::identify(&staging).map_err(|source| InstallationCopyError::InvalidCopy {
            path: staging.clone(),
            source,
        })?;
    verify_identity(&source_installation, &staged_installation)?;
    fs::write(&marker, b"validated; moving into place\n").map_err(|source| {
        InstallationCopyError::Filesystem {
            path: marker,
            source,
        }
    })?;
    fs::rename(&staging, destination).map_err(|source| InstallationCopyError::Filesystem {
        path: destination.to_path_buf(),
        source,
    })?;
    cleanup.move_to(destination.to_path_buf());
    let final_marker = destination.join(INCOMPLETE_COPY_MARKER);
    fs::remove_file(&final_marker).map_err(|source| InstallationCopyError::Filesystem {
        path: final_marker,
        source,
    })?;
    let installation =
        install::identify(destination).map_err(|source| InstallationCopyError::InvalidCopy {
            path: destination.to_path_buf(),
            source,
        })?;
    verify_identity(&source_installation, &installation)?;
    cleanup.keep();
    Ok(InstallationCopy {
        installation,
        source_bytes: plan.bytes,
        source_files: plan.files,
    })
}

fn validate_destination(source: &Path, destination: &Path) -> Result<(), InstallationCopyError> {
    if destination
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(InstallationCopyError::UnsafeDestination(
            destination.to_path_buf(),
        ));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| InstallationCopyError::NoDestinationParent(destination.to_path_buf()))?;
    let existing = parent
        .ancestors()
        .find(|ancestor| ancestor.exists())
        .ok_or_else(|| InstallationCopyError::NoDestinationParent(destination.to_path_buf()))?;
    let existing = existing
        .canonicalize()
        .map_err(|source| InstallationCopyError::Filesystem {
            path: existing.to_path_buf(),
            source,
        })?;
    if existing.starts_with(source) {
        return Err(InstallationCopyError::DestinationInsideSource(
            destination.to_path_buf(),
        ));
    }
    Ok(())
}

fn allocate_staging(parent: &Path) -> Result<PathBuf, InstallationCopyError> {
    for suffix in 0..64 {
        let candidate = parent.join(format!(
            ".reveille-copy-{}-{suffix}.partial",
            std::process::id()
        ));
        match fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {}
            Err(source) => {
                return Err(InstallationCopyError::Filesystem {
                    path: candidate,
                    source,
                });
            }
        }
    }
    Err(InstallationCopyError::NoStagingDirectory(
        parent.to_path_buf(),
    ))
}

fn copy_file<C, P>(
    source: &Path,
    target: &Path,
    cancelled: &mut C,
    copied: &mut CopyProgress,
    progress: &mut P,
) -> Result<(), InstallationCopyError>
where
    C: FnMut() -> bool,
    P: FnMut(CopyProgress),
{
    let mut input =
        File::open(source).map_err(|source_error| InstallationCopyError::Filesystem {
            path: source.to_path_buf(),
            source: source_error,
        })?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|source| InstallationCopyError::Filesystem {
            path: target.to_path_buf(),
            source,
        })?;
    let mut buffer = vec![0_u8; COPY_BUFFER_SIZE];
    loop {
        if cancelled() {
            return Err(InstallationCopyError::Cancelled);
        }
        let read =
            input
                .read(&mut buffer)
                .map_err(|source_error| InstallationCopyError::Filesystem {
                    path: source.to_path_buf(),
                    source: source_error,
                })?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|source| InstallationCopyError::Filesystem {
                path: target.to_path_buf(),
                source,
            })?;
        copied.copied_bytes = copied
            .copied_bytes
            .checked_add(u64::try_from(read).map_err(|_| InstallationCopyError::SourceTooLarge)?)
            .ok_or(InstallationCopyError::SourceTooLarge)?;
        progress(*copied);
    }
    output
        .flush()
        .map_err(|source| InstallationCopyError::Filesystem {
            path: target.to_path_buf(),
            source,
        })?;
    copied.copied_files += 1;
    progress(*copied);
    Ok(())
}

fn verify_identity(
    source: &Installation,
    copy: &Installation,
) -> Result<(), InstallationCopyError> {
    let source_binaries = source
        .binaries
        .iter()
        .map(|binary| {
            (
                binary.path.file_name().map(ToOwned::to_owned),
                &binary.sha256,
                &binary.known_version,
            )
        })
        .collect::<Vec<_>>();
    let copy_binaries = copy
        .binaries
        .iter()
        .map(|binary| {
            (
                binary.path.file_name().map(ToOwned::to_owned),
                &binary.sha256,
                &binary.known_version,
            )
        })
        .collect::<Vec<_>>();
    if source.products != copy.products
        || source.playable != copy.playable
        || source.identification != copy.identification
        || source_binaries != copy_binaries
    {
        return Err(InstallationCopyError::IdentityChanged);
    }
    Ok(())
}

struct PartialCopy {
    path: Option<PathBuf>,
}

impl PartialCopy {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn move_to(&mut self, path: PathBuf) {
        self.path = Some(path);
    }

    fn keep(&mut self) {
        self.path = None;
    }
}

impl Drop for PartialCopy {
    fn drop(&mut self) {
        let Some(path) = self.path.take() else {
            return;
        };
        // If cleanup is interrupted or refused, the marker still prevents `install::identify`
        // from accepting the remainder as a complete installation.
        drop(fs::write(
            path.join(INCOMPLETE_COPY_MARKER),
            b"incomplete\n",
        ));
        drop(fs::remove_dir_all(path));
    }
}

/// A setup probe or one-time installation copy failure.
#[derive(Debug, Error)]
pub enum InstallationCopyError {
    /// The source is not an identifiable game installation.
    #[error(transparent)]
    Identification(#[from] install::Error),
    /// A write probe failed for a reason other than a permission refusal.
    #[error("could not check whether Reveille may write to {directory}")]
    Probe {
        /// Directory checked.
        directory: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: io::Error,
    },
    /// A source entry could not be walked or measured.
    #[error("could not read the complete game folder")]
    Walk {
        /// Walk failure.
        #[source]
        source: walkdir::Error,
    },
    /// Links are not copied because they may leave the selected source tree.
    #[error("the game folder contains a link Reveille will not follow: {path}")]
    Link {
        /// Link found.
        path: PathBuf,
    },
    /// The total cannot be represented safely.
    #[error("the game folder is too large to measure safely")]
    SourceTooLarge,
    /// Files changed between the pre-copy measurement and the copy pass.
    #[error(
        "the original game folder changed while it was being copied (expected {expected_files} files and {expected_bytes} bytes; copied {copied_files} files and {copied_bytes} bytes)"
    )]
    SourceChanged {
        /// Files measured before copying.
        expected_files: u64,
        /// Files copied.
        copied_files: u64,
        /// Bytes measured before copying.
        expected_bytes: u64,
        /// Bytes copied.
        copied_bytes: u64,
    },
    /// Destination already contains something and must not be overlaid.
    #[error("the copy destination already exists: {0}")]
    DestinationExists(PathBuf),
    /// Destination has no usable parent directory.
    #[error("the copy destination has no parent folder: {0}")]
    NoDestinationParent(PathBuf),
    /// Destination uses unresolved navigation components.
    #[error("the copy destination is not an exact folder path: {0}")]
    UnsafeDestination(PathBuf),
    /// Copying beneath the source would recursively copy the copy itself.
    #[error("the copy destination must not be inside the original game folder: {0}")]
    DestinationInsideSource(PathBuf),
    /// Free space could not be read.
    #[error("could not check free space for {path}")]
    Space {
        /// Volume path checked.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: io::Error,
    },
    /// The destination volume cannot hold the measured source.
    #[error("the game needs {required} bytes, but only {available} bytes are available at {path}")]
    InsufficientSpace {
        /// Planned final destination.
        path: PathBuf,
        /// Source bytes measured before starting.
        required: u64,
        /// Available bytes measured before starting.
        available: u64,
    },
    /// No unique adjacent staging directory could be allocated.
    #[error("could not create a temporary copy folder under {0}")]
    NoStagingDirectory(PathBuf),
    /// A path returned by the walker escaped the source root.
    #[error("a copied path was outside the selected game folder: {0}")]
    OutsideSource(PathBuf),
    /// The player cancelled before the atomic move into place.
    #[error("the game-folder copy was cancelled")]
    Cancelled,
    /// An ordinary filesystem operation failed.
    #[error("could not copy the game folder at {path}")]
    Filesystem {
        /// Path being read or written.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: io::Error,
    },
    /// The staged or final copy was not accepted as an installation.
    #[error("the completed copy at {path} did not pass the game-folder check")]
    InvalidCopy {
        /// Copy that failed validation.
        path: PathBuf,
        /// Identification failure.
        #[source]
        source: install::Error,
    },
    /// Re-identification produced different products or executable identities.
    #[error("the completed copy did not match the original game installation")]
    IdentityChanged,
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::{Cursor};

    use reveille_core::content::{DownloadedArchive, MohDbIntegrity};
    use reveille_core::engine::EngineChoice;
    use reveille_core::platform::openmohaa::{
        ClientActivity, PublishedSha256, ReleaseChannel, ReleasePackage, ReleaseVersion,
        UpdateOutcome, install_verified_archive,
    };
    use reveille_core::platform::reborn::{RebornExecutable, RebornProductSet, package};
    use sha2::{Digest as _, Sha256};
    use tempfile::TempDir;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::*;
    use crate::engine::{self, EngineActivity};

    fn fixture(root: &Path) {
        fs::create_dir_all(root.join("main/maps/dm")).expect("main tree");
        fs::create_dir_all(root.join("mainta")).expect("expansion tree");
        fs::create_dir_all(root.join("maintt")).expect("second expansion tree");
        fs::write(root.join("MOHAA.exe"), b"retail executable").expect("retail executable");
        fs::write(root.join("moh_spearhead.exe"), b"spearhead executable")
            .expect("spearhead executable");
        fs::write(
            root.join("moh_breakthrough.exe"),
            b"breakthrough executable",
        )
        .expect("breakthrough executable");
        fs::write(root.join("main/Pak0.pk3"), b"base assets").expect("base assets");
        fs::write(root.join("main/maps/dm/readme.txt"), b"custom map note").expect("map note");
        fs::write(root.join("mainta/Pak1.pk3"), b"spearhead assets").expect("expansion assets");
        fs::write(root.join("maintt/Pak2.pk3"), b"breakthrough assets")
            .expect("second expansion assets");
    }

    fn zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("start zip entry");
            writer.write_all(bytes).expect("write zip entry");
        }
        writer.finish().expect("finish zip").into_inner()
    }

    fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        WalkDir::new(root)
            .into_iter()
            .map(|entry| entry.expect("walk fixture"))
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| {
                let relative = entry
                    .path()
                    .strip_prefix(root)
                    .expect("relative fixture path")
                    .to_path_buf();
                let bytes = fs::read(entry.path()).expect("fixture file");
                (relative, bytes)
            })
            .collect()
    }

    #[test]
    fn copy_checks_space_reidentifies_and_leaves_the_source_untouched() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("protected");
        fixture(&source);
        let before = snapshot(&source);
        let destination = temporary.path().join("Games/MOHAA");
        let mut observations = Vec::new();
        let copied = copy_installation_with_space(
            &source,
            &destination,
            |_| Ok(u64::MAX),
            &mut || false,
            &mut |progress| observations.push(progress),
        )
        .expect("validated copy");

        assert_eq!(
            copied.installation.root,
            destination.canonicalize().expect("copy root")
        );
        assert_eq!(
            copied.installation.products,
            [
                reveille_core::install::Product::AlliedAssault,
                reveille_core::install::Product::Spearhead,
                reveille_core::install::Product::Breakthrough,
            ]
        );
        assert_eq!(snapshot(&source), before, "the source installation changed");
        assert_eq!(snapshot(&destination), before);
        assert!(observations.last().is_some_and(|progress| {
            progress.copied_bytes == copied.source_bytes
                && progress.copied_files == copied.source_files
        }));
        assert!(probe_writable(&destination).is_ok());
        assert!(probe_writable(&destination.join("main")).is_ok());
        assert!(probe_writable(&destination.join("mainta")).is_ok());
        assert!(probe_writable(&destination.join("maintt")).is_ok());
    }

    #[test]
    #[expect(
        clippy::too_many_lines,
        reason = "one end-to-end fixture proves every post-copy operation uses the validated root"
    )]
    fn copied_installation_accepts_engines_maps_and_a_join_command() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("protected");
        fixture(&source);
        let source_installation = install::identify(&source).expect("source installation");
        let protected = probe_installation_write_access_with(&source_installation, |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        })
        .expect("permission refusals are a setup result");
        assert_eq!(protected.blocked.len(), 4, "root plus all three games");
        let destination = temporary.path().join("Games/MOHAA");
        copy_installation_with_space(
            &source,
            &destination,
            |_| Ok(u64::MAX),
            &mut || false,
            &mut |_| {},
        )
        .expect("writable copy");

        let openmohaa_zip = zip(&[("openmohaa.exe", b"openmohaa")]);
        let openmohaa_package = ReleasePackage {
            channel: ReleaseChannel::Stable,
            version: "v1.0.0".to_owned(),
            semver: ReleaseVersion::parse("v1.0.0").expect("semver"),
            prerelease: false,
            asset_name: "openmohaa-v1.0.0-windows-x86_64.zip".to_owned(),
            download_url: "https://example.invalid/openmohaa.zip".to_owned(),
            size: u64::try_from(openmohaa_zip.len()).expect("zip length"),
            digest: PublishedSha256::parse(&format!("sha256:{:x}", Sha256::digest(&openmohaa_zip)))
                .expect("published digest"),
        };
        assert!(matches!(
            install_verified_archive(
                &openmohaa_package,
                &openmohaa_zip,
                &destination,
                ClientActivity::ConfirmedStopped,
            ),
            Ok(UpdateOutcome::Installed { .. })
        ));
        assert!(destination.join("openmohaa.exe").is_file());

        let reborn_package = package(RebornProductSet::AaShBt);
        let reborn_bytes = b"synthetic reborn".to_vec();
        let executables = ["MOHAA.exe", "moh_spearhead.exe", "moh_breakthrough.exe"]
            .into_iter()
            .map(|filename| RebornExecutable {
                filename: filename.to_owned(),
                sha256: format!("{:x}", Sha256::digest(&reborn_bytes)),
                bytes: reborn_bytes.clone(),
            })
            .collect::<Vec<_>>();
        engine::install_reborn(
            &destination,
            &reborn_package,
            &executables,
            EngineActivity::ConfirmedStopped,
        )
        .expect("Reborn installs into copy");
        for filename in ["MOHAA.exe", "moh_spearhead.exe", "moh_breakthrough.exe"] {
            assert!(
                destination
                    .join(".reveille-engines/original")
                    .join(filename)
                    .is_file(),
                "original {filename} was not preserved"
            );
        }

        let bsp = [
            b"2015".as_slice(),
            &19_i32.to_le_bytes(),
            &42_i32.to_le_bytes(),
        ]
        .concat();
        let map_zip = zip(&[("maps/dm/copied.bsp", &bsp)]);
        let staged_map = temporary.path().join("download.pk3");
        fs::write(&staged_map, &map_zip).expect("staged map");
        let archive = DownloadedArchive {
            path: staged_map,
            filename: "copied-map.pk3".to_owned(),
            integrity: MohDbIntegrity::RecordedSha256(format!("{:x}", Sha256::digest(&map_zip))),
        };
        reveille_core::content::install_archive(&archive, destination.join("main"))
            .expect("Original installs a map into the copy");

        let session_engine = EngineChoice::Original;
        let program = crate::default_client(
            &destination,
            reveille_core::discovery::TargetGame::AlliedAssault,
            session_engine.into(),
        );
        assert_eq!(program, destination.join("MOHAA.exe"));
        let command = reveille_core::join::LaunchCommand::new(
            program.to_string_lossy().into_owned(),
            reveille_core::join::LaunchProfile::new(
                reveille_core::discovery::TargetGame::AlliedAssault,
            ),
            reveille_core::join::FsGame::new("").expect("base game"),
            "127.0.0.1:12203".parse().expect("join address"),
        )
        .expect("join command against copy");
        assert_eq!(
            command.program,
            destination.join("MOHAA.exe").to_string_lossy()
        );

        // Exercise the platform spawn against the copied root without starting a real game. A
        // stock shell stands in for the executable and is stopped immediately; the invariant is
        // that the exact program beneath the validated copy is the one `launch_client` starts.
        let shell = if cfg!(windows) {
            PathBuf::from(env::var_os("COMSPEC").expect("Windows command processor"))
        } else {
            PathBuf::from("/bin/sh")
        };
        fs::copy(shell, &program).expect("runnable fixture");
        let mut child = crate::launch_client(&command, session_engine.into())
            .expect("launch from copied installation");
        drop(child.kill());
        drop(child.wait());
    }

    #[test]
    fn setup_storage_probe_names_every_protected_game_directory() {
        let temporary = TempDir::new().expect("temporary directory");
        fixture(temporary.path());
        fs::create_dir(temporary.path().join(".reveille-engines")).expect("managed directory");
        let installation = install::identify(temporary.path()).expect("installation");
        let protected = [
            installation.root.clone(),
            installation.root.join("mainta"),
            installation.root.join(".reveille-engines"),
        ];
        let result = probe_installation_write_access_with(&installation, |directory| {
            if protected.contains(&directory.to_path_buf()) {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            } else {
                Ok(())
            }
        })
        .expect("permission refusals are probe results");
        assert_eq!(result.blocked, protected);
    }

    #[test]
    fn insufficient_space_refuses_before_a_destination_or_partial_copy_exists() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("source");
        fixture(&source);
        let destination = temporary.path().join("Games/MOHAA");
        let error = copy_installation_with_space(
            &source,
            &destination,
            |_| Ok(1),
            &mut || false,
            &mut |_| {},
        )
        .expect_err("one byte cannot hold the source");
        assert!(matches!(
            error,
            InstallationCopyError::InsufficientSpace {
                required,
                available: 1,
                ..
            } if required > 1
        ));
        assert!(!destination.exists());
        assert_eq!(
            fs::read_dir(destination.parent().expect("destination parent"))
                .expect("empty parent")
                .count(),
            0
        );
    }

    #[test]
    fn copy_cancellation_removes_the_partial_installation() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("source");
        fixture(&source);
        let destination = temporary.path().join("Games/MOHAA");
        let mut checks = 0;
        let error = copy_installation_with_space(
            &source,
            &destination,
            |_| Ok(u64::MAX),
            &mut || {
                checks += 1;
                checks > 2
            },
            &mut |_| {},
        )
        .expect_err("copy cancelled");
        assert!(matches!(error, InstallationCopyError::Cancelled));
        assert!(!destination.exists());
        let leftovers = fs::read_dir(destination.parent().expect("destination parent"))
            .expect("copy parent")
            .collect::<Result<Vec<_>, _>>()
            .expect("copy parent entries");
        assert!(leftovers.is_empty(), "partial copy remained: {leftovers:?}");
    }

    #[test]
    fn copy_failure_removes_the_partial_installation() {
        let temporary = TempDir::new().expect("temporary directory");
        let source = temporary.path().join("source");
        fixture(&source);
        let destination = temporary.path().join("Games/MOHAA");
        let removed = std::cell::Cell::new(false);
        let error = copy_installation_with_space(
            &source,
            &destination,
            |_| Ok(u64::MAX),
            &mut || false,
            &mut |_| {
                if !removed.replace(true) {
                    fs::remove_file(source.join("main/Pak0.pk3"))
                        .expect("change source after measurement");
                }
            },
        )
        .expect_err("changed source is not a complete copy");
        assert!(matches!(error, InstallationCopyError::SourceChanged { .. }));
        assert!(!destination.exists());
        let leftovers = fs::read_dir(destination.parent().expect("destination parent"))
            .expect("copy parent")
            .collect::<Result<Vec<_>, _>>()
            .expect("copy parent entries");
        assert!(leftovers.is_empty(), "partial copy remained: {leftovers:?}");
    }

    #[test]
    fn incomplete_marker_prevents_identification() {
        let temporary = TempDir::new().expect("temporary directory");
        fixture(temporary.path());
        fs::write(
            temporary.path().join(INCOMPLETE_COPY_MARKER),
            b"incomplete\n",
        )
        .expect("marker");
        assert!(matches!(
            install::identify(temporary.path()),
            Err(install::Error::IncompleteCopy(_))
        ));
    }

    #[test]
    fn destination_beneath_the_source_is_rejected_before_copying() {
        let temporary = TempDir::new().expect("temporary directory");
        fixture(temporary.path());
        let destination = temporary.path().join("copy/MOHAA");
        assert!(matches!(
            copy_installation_with_space(
                temporary.path(),
                &destination,
                |_| Ok(u64::MAX),
                &mut || false,
                &mut |_| {},
            ),
            Err(InstallationCopyError::DestinationInsideSource(_))
        ));
        assert!(!destination.exists());
    }
}
