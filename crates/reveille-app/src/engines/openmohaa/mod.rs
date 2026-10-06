// SPDX-License-Identifier: GPL-3.0-only

mod receipt;

use std::collections::VecDeque;
use std::io;
use std::ops::ControlFlow;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use reveille_core::engine::EngineChoice;
use reveille_core::install::{self, Installation};
use reveille_core::platform::openmohaa::{
    ClientActivity, OpenMohaaError, OpenMohaaReleaseClient, ReleaseChannel,
    ReleaseDownloadProgress, ReleasePackage, ReleaseSelector, ReleaseTarget, UpdateOutcome,
};
use reveille_platform as platform;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

use super::{DownloadProgress, InstallGate};
use receipt::{installed_openmohaa_build, record_openmohaa_install};

pub const EVENT: &str = "reveille://openmohaa-install";

#[derive(Default)]
pub struct OpenMohaaState {
    /// Read between download chunks; cancellation never interrupts the atomic apply phase.
    cancel: AtomicBool,
    /// Release offers already shown to the player, retained so Install uses those exact bytes.
    offers: Mutex<VecDeque<CachedOpenMohaaOffer>>,
    /// Opaque identity generator for cached offers.
    next_offer: AtomicU64,
}

const OPENMOHAA_OFFER_CACHE_CAPACITY: usize = 8;

#[derive(Clone)]
pub struct CachedOpenMohaaOffer {
    id: OpenMohaaOfferId,
    installation_root: PathBuf,
    target: ReleaseTarget,
    package: ReleasePackage,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(transparent)]
pub struct OpenMohaaOfferId(u64);

#[derive(Clone, Serialize)]
pub struct OpenMohaaReleaseSummary {
    offer_id: OpenMohaaOfferId,
    channel: ReleaseChannel,
    version: String,
    /// Whether the offered release is a prerelease. The preview channel serves the stable release
    /// once it outranks the newest candidate, so the channel alone does not answer this.
    prerelease: bool,
    asset_name: String,
    size: u64,
    digest: String,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum OpenMohaaInstalledBuild {
    Absent,
    Current,
    KnownOther {
        channel: ReleaseChannel,
        version: String,
        relation: OfferRelation,
    },
    Unknown,
}

/// Where the offered release sits relative to the installed one, by semver precedence.
///
/// The interface may not call every replacement an update. The channel selector can legitimately
/// offer a *lower* version than the one installed - a player on preview holding `v0.83.0-rc.2`
/// who switches to stable is offered `v0.82.1` - and naming that "update" would turn a rollback
/// into a word the player did not choose. A receipt written before semver tags
/// (`Development build 2026-08-20`) has no place in that ordering and takes `Incomparable`, so the
/// shell offers a plain install rather than inventing a direction.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OfferRelation {
    /// The offered version outranks the installed one.
    Newer,
    /// The installed version outranks the offered one.
    Older,
    /// The same version by semver precedence, from a different release file.
    SameVersion,
    /// The installed version is not semver, so the two cannot be ordered.
    Incomparable,
}

#[derive(Serialize)]
#[serde(tag = "availability", rename_all = "snake_case")]
pub enum OpenMohaaStatus {
    Available {
        target: ReleaseTarget,
        installed_build: OpenMohaaInstalledBuild,
        activity: OpenMohaaActivitySummary,
        package: OpenMohaaReleaseSummary,
    },
    Unsupported {
        os: String,
        architecture: String,
    },
}

#[derive(Serialize)]
pub struct OpenMohaaInstallResult {
    package: OpenMohaaReleaseSummary,
    outcome: UpdateOutcome,
    activity: OpenMohaaActivitySummary,
    installed_build: OpenMohaaInstalledBuild,
}

#[derive(Clone, Serialize)]
pub struct OpenMohaaActivitySummary {
    state: ClientActivity,
    running: Vec<OpenMohaaRunningProgram>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenMohaaRunningProgram {
    Game,
    DedicatedServer,
    Launcher,
}

/// Why an engine step stopped, classified once here rather than by matching message text.
///
/// The interface has to say what actually happened — a release that published no digest is not
/// a corrupted download, and neither is a release that has no build for this machine. Reading
/// that distinction out of a formatted `OpenMohaaError` string in JavaScript is how the two got
/// merged, so the classification lives beside the errors it names. `detail` carries the original
/// message for diagnosis; the shell chooses its own wording from `kind`.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenMohaaFailureKind {
    /// GitHub could not be reached or refused the request.
    Unreachable,
    /// The release exists but publishes nothing for this machine.
    NoAssetForHost,
    /// The release metadata is unusable — no digest, an ambiguous asset, no dev identity.
    /// Nothing was downloaded, so retrying changes nothing.
    ReleaseMetadata,
    /// Bytes arrived but did not match the published size or digest.
    CorruptDownload,
    /// The archive itself was rejected before any file was written.
    ArchiveRejected,
    /// The player pressed Stop.
    Cancelled,
    /// Writing into the game folder failed; existing files were restored.
    Filesystem,
    /// A failure outside the release pipeline, carried through with its own message rather than
    /// dressed up as one of the causes above.
    Internal,
}

#[derive(Clone, Debug, Serialize)]
pub struct OpenMohaaFailure {
    kind: OpenMohaaFailureKind,
    detail: String,
}

impl From<OpenMohaaError> for OpenMohaaFailure {
    fn from(error: OpenMohaaError) -> Self {
        use OpenMohaaFailureKind as Kind;

        let detail = match &error {
            OpenMohaaError::Filesystem { path, source }
                if source.kind() == io::ErrorKind::PermissionDenied =>
            {
                format!(
                    "Windows protects {}, so Reveille cannot change files there. Make a writable copy of the game folder first.",
                    path.display()
                )
            }
            _ => error.to_string(),
        };
        let kind = match error {
            OpenMohaaError::Client(_)
            | OpenMohaaError::Network(_)
            | OpenMohaaError::HttpStatus(_) => Kind::Unreachable,
            OpenMohaaError::MissingAsset(_) => Kind::NoAssetForHost,
            OpenMohaaError::MalformedRelease(_)
            | OpenMohaaError::AmbiguousAsset(_)
            | OpenMohaaError::NoSelectableRelease(_)
            | OpenMohaaError::UnversionedRelease(_)
            | OpenMohaaError::MissingDigest(_)
            | OpenMohaaError::UnsupportedDigest(_)
            | OpenMohaaError::InvalidDigest(_)
            | OpenMohaaError::AssetTooLarge { .. } => Kind::ReleaseMetadata,
            OpenMohaaError::SizeMismatch { .. } | OpenMohaaError::DigestMismatch { .. } => {
                Kind::CorruptDownload
            }
            OpenMohaaError::DownloadCancelled => Kind::Cancelled,
            OpenMohaaError::InvalidZip(_)
            | OpenMohaaError::UnsafeArchiveEntry(_)
            | OpenMohaaError::DuplicateArchiveEntry(_)
            | OpenMohaaError::EmptyArchive => Kind::ArchiveRejected,
            OpenMohaaError::NoDestinationParent(_)
            | OpenMohaaError::TargetIsDirectory(_)
            | OpenMohaaError::IncompleteTransaction
            | OpenMohaaError::Filesystem { .. } => Kind::Filesystem,
        };
        Self { kind, detail }
    }
}

impl OpenMohaaFailure {
    /// A failure outside the release pipeline: an unreadable folder, or a busy install lock.
    fn other(detail: &impl ToString) -> Self {
        Self {
            kind: OpenMohaaFailureKind::Internal,
            detail: detail.to_string(),
        }
    }

    fn no_asset_for_host(detail: &impl ToString) -> Self {
        Self {
            kind: OpenMohaaFailureKind::NoAssetForHost,
            detail: detail.to_string(),
        }
    }
}

#[tauri::command]
pub async fn openmohaa_status(
    path: String,
    channel: ReleaseChannel,
    state: tauri::State<'_, OpenMohaaState>,
) -> Result<OpenMohaaStatus, OpenMohaaFailure> {
    platform::HostCapabilities::current()
        .require(EngineChoice::Openmohaa)
        .map_err(|error| OpenMohaaFailure::other(&error))?;
    let installation = install::identify(&path).map_err(|error| OpenMohaaFailure::other(&error))?;
    let target = match ReleaseTarget::for_host() {
        Ok(target) => target,
        Err(unsupported) => {
            return Ok(OpenMohaaStatus::Unsupported {
                os: unsupported.os,
                architecture: unsupported.architecture,
            });
        }
    };
    let client = OpenMohaaReleaseClient::new(Duration::from_secs(120))?;
    let package = client.release(ReleaseSelector { channel, target }).await?;
    let offer_id = cache_openmohaa_offer(&state, &installation, target, package.clone())?;
    Ok(OpenMohaaStatus::Available {
        target,
        installed_build: installed_openmohaa_build(&installation.root, target, &package),
        activity: activity_summary(&platform::openmohaa_activity()),
        package: release_summary(&package, offer_id),
    })
}

#[tauri::command]
pub async fn install_openmohaa(
    path: String,
    offer_id: OpenMohaaOfferId,
    app: tauri::AppHandle,
    gate: tauri::State<'_, InstallGate>,
    state: tauri::State<'_, OpenMohaaState>,
) -> Result<OpenMohaaInstallResult, OpenMohaaFailure> {
    platform::HostCapabilities::current()
        .require(EngineChoice::Openmohaa)
        .map_err(|error| OpenMohaaFailure::other(&error))?;
    let _install_guard = gate
        .try_enter()
        .map_err(|_| OpenMohaaFailure::other(&"an OpenMoHAA install is already running"))?;
    state.cancel.store(false, Ordering::Release);

    // Re-identification prevents a stale or forged frontend path from becoming an arbitrary
    // archive extraction destination.
    let installation = install::identify(&path).map_err(|error| OpenMohaaFailure::other(&error))?;
    let target =
        ReleaseTarget::for_host().map_err(|error| OpenMohaaFailure::no_asset_for_host(&error))?;
    let offer = cached_openmohaa_offer(&state, offer_id)?;
    if offer.installation_root != installation.root || offer.target != target {
        return Err(OpenMohaaFailure::other(
            &"the displayed OpenMoHAA offer does not belong to this game folder",
        ));
    }
    let client = OpenMohaaReleaseClient::new(Duration::from_secs(120))?;
    let summary = release_summary(&offer.package, offer.id);
    let cancel = &state.cancel;
    let observed_activity = Mutex::new(platform::OpenMohaaActivity::unknown());
    let outcome = client
        .download_and_install_reporting(
            &offer.package,
            &installation.root,
            // Probed after the transfer, not before it: the archive takes long enough to
            // download that a player can start the client in between.
            || {
                let activity = platform::openmohaa_activity();
                let client_activity = activity.client_activity();
                if let Ok(mut observed) = observed_activity.lock() {
                    *observed = activity;
                }
                client_activity
            },
            |ReleaseDownloadProgress { received, total }| {
                drop(app.emit(EVENT, DownloadProgress { received, total }));
                if cancel.load(Ordering::Acquire) {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            },
        )
        .await?;
    let installed_build = if matches!(
        outcome,
        UpdateOutcome::Installed { .. } | UpdateOutcome::Updated { .. }
    ) {
        // The engine install succeeded even if this evidence record cannot be written. Without a
        // valid receipt the result and next status check honestly fall back to Version unknown.
        if record_openmohaa_install(&installation.root, target, &offer.package).is_ok() {
            OpenMohaaInstalledBuild::Current
        } else {
            OpenMohaaInstalledBuild::Unknown
        }
    } else {
        installed_openmohaa_build(&installation.root, target, &offer.package)
    };
    let activity = match observed_activity.into_inner() {
        Ok(activity) => activity,
        Err(error) => error.into_inner(),
    };
    Ok(OpenMohaaInstallResult {
        package: summary,
        outcome,
        activity: activity_summary(&activity),
        installed_build,
    })
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn cancel_openmohaa_install(state: tauri::State<'_, OpenMohaaState>) {
    state.cancel.store(true, Ordering::Release);
}

fn cache_openmohaa_offer(
    state: &OpenMohaaState,
    installation: &Installation,
    target: ReleaseTarget,
    package: ReleasePackage,
) -> Result<OpenMohaaOfferId, OpenMohaaFailure> {
    let id = OpenMohaaOfferId(state.next_offer.fetch_add(1, Ordering::Relaxed));
    let mut offers = state
        .offers
        .lock()
        .map_err(|error| OpenMohaaFailure::other(&error))?;
    if offers.len() == OPENMOHAA_OFFER_CACHE_CAPACITY {
        offers.pop_front();
    }
    offers.push_back(CachedOpenMohaaOffer {
        id,
        installation_root: installation.root.clone(),
        target,
        package,
    });
    Ok(id)
}

fn cached_openmohaa_offer(
    state: &OpenMohaaState,
    id: OpenMohaaOfferId,
) -> Result<CachedOpenMohaaOffer, OpenMohaaFailure> {
    state
        .offers
        .lock()
        .map_err(|error| OpenMohaaFailure::other(&error))?
        .iter()
        .find(|offer| offer.id == id)
        .cloned()
        .ok_or_else(|| {
            OpenMohaaFailure::other(
                &"the displayed OpenMoHAA offer expired; refresh before installing",
            )
        })
}

fn release_summary(
    package: &ReleasePackage,
    offer_id: OpenMohaaOfferId,
) -> OpenMohaaReleaseSummary {
    OpenMohaaReleaseSummary {
        offer_id,
        channel: package.channel,
        version: package.version.clone(),
        prerelease: package.prerelease,
        asset_name: package.asset_name.clone(),
        size: package.size,
        digest: package.digest.to_string(),
    }
}

fn activity_summary(activity: &platform::OpenMohaaActivity) -> OpenMohaaActivitySummary {
    let running = activity
        .running_programs()
        .iter()
        .map(|program| match program {
            platform::OpenMohaaProgram::Game => OpenMohaaRunningProgram::Game,
            platform::OpenMohaaProgram::DedicatedServer => OpenMohaaRunningProgram::DedicatedServer,
            platform::OpenMohaaProgram::Launcher => OpenMohaaRunningProgram::Launcher,
        })
        .collect();
    OpenMohaaActivitySummary {
        state: activity.client_activity(),
        running,
    }
}

pub fn register(app: &mut tauri::App) {
    app.manage(OpenMohaaState::default());
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use reveille_core::install::{IdentificationMethod, Product};
    use reveille_core::platform::openmohaa::{
        OpenMohaaError, PublishedSha256, ReleaseChannel, ReleasePackage, ReleaseSelector,
        ReleaseTarget, ReleaseVersion,
    };

    use super::{
        OpenMohaaFailure, OpenMohaaFailureKind, OpenMohaaState, cache_openmohaa_offer,
        cached_openmohaa_offer,
    };

    #[test]
    fn a_release_without_a_published_file_check_is_not_reported_as_a_bad_download() {
        let digest = PublishedSha256::parse(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        )
        .expect("fixture digest");
        let cases = [
            (
                OpenMohaaError::MissingDigest("openmohaa.zip".to_owned()),
                OpenMohaaFailureKind::ReleaseMetadata,
            ),
            (
                OpenMohaaError::UnsupportedDigest("md5:00".to_owned()),
                OpenMohaaFailureKind::ReleaseMetadata,
            ),
            (
                OpenMohaaError::InvalidDigest("sha256:zz".to_owned()),
                OpenMohaaFailureKind::ReleaseMetadata,
            ),
            (
                OpenMohaaError::AmbiguousAsset(ReleaseSelector::stable(ReleaseTarget::WindowsX64)),
                OpenMohaaFailureKind::ReleaseMetadata,
            ),
            (
                OpenMohaaError::MissingAsset(ReleaseSelector::stable(ReleaseTarget::WindowsX64)),
                OpenMohaaFailureKind::NoAssetForHost,
            ),
            (
                OpenMohaaError::DigestMismatch {
                    expected: digest,
                    actual: digest,
                },
                OpenMohaaFailureKind::CorruptDownload,
            ),
            (
                OpenMohaaError::SizeMismatch {
                    expected: 1,
                    actual: 2,
                },
                OpenMohaaFailureKind::CorruptDownload,
            ),
            (
                OpenMohaaError::DownloadCancelled,
                OpenMohaaFailureKind::Cancelled,
            ),
            (
                OpenMohaaError::EmptyArchive,
                OpenMohaaFailureKind::ArchiveRejected,
            ),
        ];

        for (error, expected) in cases {
            let rendered = error.to_string();
            let failure = OpenMohaaFailure::from(error);
            assert_eq!(failure.kind, expected, "misclassified {rendered:?}");
            assert_eq!(failure.detail, rendered);
        }
    }

    #[test]
    fn installation_reuses_the_exact_release_offer_that_status_returned() {
        let state = OpenMohaaState::default();
        let installation = reveille_core::install::Installation {
            root: Path::new(r"C:\Games\MOHAA").to_path_buf(),
            products: vec![Product::AlliedAssault],
            playable: vec![Product::AlliedAssault],
            binaries: Vec::new(),
            identification: IdentificationMethod::DataDirectoriesOnly,
        };
        let stable = ReleasePackage {
            channel: ReleaseChannel::Stable,
            version: "v0.82.1".to_owned(),
            semver: ReleaseVersion::parse("v0.82.1").expect("stable semver"),
            prerelease: false,
            asset_name: "stable.zip".to_owned(),
            download_url: "https://example.invalid/stable.zip".to_owned(),
            size: 6,
            digest: PublishedSha256::parse(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            )
            .expect("stable digest"),
        };
        let preview = ReleasePackage {
            channel: ReleaseChannel::Preview,
            version: "v0.83.0-rc.1".to_owned(),
            semver: ReleaseVersion::parse("v0.83.0-rc.1").expect("preview semver"),
            prerelease: true,
            asset_name: "preview.zip".to_owned(),
            download_url: "https://example.invalid/preview.zip".to_owned(),
            size: 7,
            digest: PublishedSha256::parse(
                "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            )
            .expect("preview digest"),
        };

        let stable_id = cache_openmohaa_offer(
            &state,
            &installation,
            ReleaseTarget::WindowsX64,
            stable.clone(),
        )
        .expect("cache stable offer");
        let preview_id =
            cache_openmohaa_offer(&state, &installation, ReleaseTarget::WindowsX64, preview)
                .expect("cache preview offer");

        assert_ne!(stable_id, preview_id);
        assert_eq!(
            cached_openmohaa_offer(&state, stable_id)
                .expect("displayed stable offer")
                .package,
            stable
        );
    }
}
