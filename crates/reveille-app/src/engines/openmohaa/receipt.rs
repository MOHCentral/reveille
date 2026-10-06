// SPDX-License-Identifier: GPL-3.0-only

use std::cmp;
use std::fs;
use std::io::{self, Read as _};
use std::path::{Path, PathBuf};

use reveille_core::platform::openmohaa::{
    ReleaseChannel, ReleasePackage, ReleaseTarget, ReleaseVersion,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use thiserror::Error;

use super::{OfferRelation, OpenMohaaInstalledBuild};

const OPENMOHAA_RECEIPT_FILENAME: &str = ".reveille-openmohaa.json";
const OPENMOHAA_RECEIPT_FORMAT: OpenMohaaReceiptFormat = OpenMohaaReceiptFormat(1);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(transparent)]
pub struct OpenMohaaReceiptFormat(u8);

#[derive(Debug, Deserialize, Serialize)]
pub struct OpenMohaaInstallReceipt {
    format: OpenMohaaReceiptFormat,
    channel: ReleaseChannel,
    version: String,
    asset_name: String,
    release_digest: String,
    client_sha256: String,
}

#[derive(Debug, Error)]
pub enum OpenMohaaReceiptError {
    #[error("could not access OpenMoHAA receipt data at {path}")]
    Filesystem {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("could not encode or decode the OpenMoHAA receipt")]
    Json(#[from] serde_json::Error),
}

pub fn installed_openmohaa_build(
    root: &Path,
    target: ReleaseTarget,
    selected: &ReleasePackage,
) -> OpenMohaaInstalledBuild {
    let client_path = openmohaa_client_path(root, target);
    if !client_path.is_file() {
        return OpenMohaaInstalledBuild::Absent;
    }
    let Some(receipt) = validated_openmohaa_receipt(root, &client_path) else {
        return OpenMohaaInstalledBuild::Unknown;
    };
    if receipt.version == selected.version
        && receipt.asset_name == selected.asset_name
        && receipt.release_digest == selected.digest.to_string()
    {
        OpenMohaaInstalledBuild::Current
    } else {
        let relation = match ReleaseVersion::parse(&receipt.version) {
            Some(installed) => match installed.cmp(&selected.semver) {
                cmp::Ordering::Less => OfferRelation::Newer,
                cmp::Ordering::Greater => OfferRelation::Older,
                cmp::Ordering::Equal => OfferRelation::SameVersion,
            },
            None => OfferRelation::Incomparable,
        };
        OpenMohaaInstalledBuild::KnownOther {
            channel: receipt.channel,
            version: receipt.version,
            relation,
        }
    }
}

fn validated_openmohaa_receipt(root: &Path, client_path: &Path) -> Option<OpenMohaaInstallReceipt> {
    let receipt_path = root.join(OPENMOHAA_RECEIPT_FILENAME);
    let bytes = fs::read(&receipt_path).ok()?;
    let receipt = serde_json::from_slice::<OpenMohaaInstallReceipt>(&bytes).ok()?;
    if receipt.format != OPENMOHAA_RECEIPT_FORMAT {
        return None;
    }
    let client_sha256 = sha256_file(client_path).ok()?;
    (receipt.client_sha256 == client_sha256).then_some(receipt)
}

pub fn record_openmohaa_install(
    root: &Path,
    target: ReleaseTarget,
    package: &ReleasePackage,
) -> Result<(), OpenMohaaReceiptError> {
    let client_path = openmohaa_client_path(root, target);
    let receipt = OpenMohaaInstallReceipt {
        format: OPENMOHAA_RECEIPT_FORMAT,
        channel: package.channel,
        version: package.version.clone(),
        asset_name: package.asset_name.clone(),
        release_digest: package.digest.to_string(),
        client_sha256: sha256_file(&client_path)?,
    };
    let encoded = serde_json::to_vec_pretty(&receipt)?;
    let receipt_path = root.join(OPENMOHAA_RECEIPT_FILENAME);
    fs::write(&receipt_path, encoded).map_err(|source| OpenMohaaReceiptError::Filesystem {
        path: receipt_path,
        source,
    })
}

fn sha256_file(path: &Path) -> Result<String, OpenMohaaReceiptError> {
    let mut file = fs::File::open(path).map_err(|source| OpenMohaaReceiptError::Filesystem {
        path: path.to_path_buf(),
        source,
    })?;
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|source| OpenMohaaReceiptError::Filesystem {
                path: path.to_path_buf(),
                source,
            })?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn openmohaa_client_path(root: &Path, target: ReleaseTarget) -> PathBuf {
    // openmoh/openmohaa v0.82.1 release archive layout: Windows uses `openmohaa.exe`; every Unix
    // archive uses the extensionless `openmohaa` binary at its root.
    let filename = match target {
        ReleaseTarget::WindowsX64 | ReleaseTarget::WindowsX86 | ReleaseTarget::WindowsArm64 => {
            "openmohaa.exe"
        }
        ReleaseTarget::LinuxAmd64
        | ReleaseTarget::LinuxArm64
        | ReleaseTarget::LinuxArmhf
        | ReleaseTarget::LinuxI686
        | ReleaseTarget::MacosArm64
        | ReleaseTarget::MacosX64 => "openmohaa",
    };
    root.join(filename)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use reveille_core::platform::openmohaa::{
        PublishedSha256, ReleaseChannel, ReleasePackage, ReleaseTarget, ReleaseVersion,
    };
    use tempfile::TempDir;

    use super::{
        OfferRelation, OpenMohaaInstalledBuild, installed_openmohaa_build, openmohaa_client_path,
        record_openmohaa_install,
    };

    #[test]
    fn openmohaa_client_path_matches_the_published_archive_layout() {
        let root = Path::new(r"C:\Games\MOHAA");
        for target in [
            ReleaseTarget::WindowsX64,
            ReleaseTarget::WindowsX86,
            ReleaseTarget::WindowsArm64,
        ] {
            assert_eq!(
                openmohaa_client_path(root, target),
                root.join("openmohaa.exe")
            );
        }
        for target in [
            ReleaseTarget::LinuxAmd64,
            ReleaseTarget::LinuxArm64,
            ReleaseTarget::LinuxArmhf,
            ReleaseTarget::LinuxI686,
            ReleaseTarget::MacosArm64,
            ReleaseTarget::MacosX64,
        ] {
            assert_eq!(openmohaa_client_path(root, target), root.join("openmohaa"));
        }
    }

    #[test]
    fn identical_openmohaa_packages_are_current_across_channels() {
        let temporary = TempDir::new().expect("temporary directory");
        let root = temporary.path();
        fs::write(root.join("openmohaa.exe"), b"installed stable").expect("client fixture");
        let mut package = reveille_core::platform::openmohaa::parse_latest_release(
            include_str!("../../../../reveille-core/tests/fixtures/openmohaa_latest_release.json"),
            ReleaseTarget::WindowsX64,
        )
        .expect("stable package");
        for channel in [ReleaseChannel::Preview, ReleaseChannel::Stable] {
            package.channel = channel;
            record_openmohaa_install(root, ReleaseTarget::WindowsX64, &package).expect("receipt");
            package.channel = match channel {
                ReleaseChannel::Preview => ReleaseChannel::Stable,
                ReleaseChannel::Stable => ReleaseChannel::Preview,
            };
            assert_eq!(
                installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &package),
                OpenMohaaInstalledBuild::Current
            );
            for changed in [
                ReleasePackage {
                    version: "v0.82.2".into(),
                    ..package.clone()
                },
                ReleasePackage {
                    asset_name: "another-windows-x64.zip".into(),
                    ..package.clone()
                },
                ReleasePackage {
                    digest: PublishedSha256::parse(&format!("sha256:{}", "0".repeat(64)))
                        .expect("digest"),
                    ..package.clone()
                },
            ] {
                assert!(matches!(
                    installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &changed),
                    OpenMohaaInstalledBuild::KnownOther { .. }
                ));
            }
        }
        fs::write(root.join("openmohaa.exe"), b"externally replaced").expect("changed client");
        assert_eq!(
            installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &package),
            OpenMohaaInstalledBuild::Unknown
        );
    }

    #[test]
    fn legacy_dev_receipts_keep_their_installed_build_identity() {
        let temporary = TempDir::new().expect("temporary directory");
        let root = temporary.path();
        let client = root.join("openmohaa.exe");
        fs::write(&client, b"legacy preview").expect("client fixture");
        let receipt = serde_json::json!({
            "format": super::OPENMOHAA_RECEIPT_FORMAT,
            "channel": "dev",
            "version": "Development build 2026-08-20",
            "asset_name": "openmohaa-dev-windows-x64-pdb.zip",
            "release_digest": format!("sha256:{}", "0".repeat(64)),
            "client_sha256": super::sha256_file(&client).expect("client hash"),
        });
        fs::write(
            root.join(super::OPENMOHAA_RECEIPT_FILENAME),
            receipt.to_string(),
        )
        .expect("legacy receipt");
        let validated =
            super::validated_openmohaa_receipt(root, &client).expect("legacy receipt recognized");
        assert_eq!(validated.channel, ReleaseChannel::Preview);
        assert_eq!(validated.version, "Development build 2026-08-20");
        assert_eq!(
            serde_json::to_value(&validated).expect("serialized receipt")["channel"],
            "preview"
        );
        let selected = reveille_core::platform::openmohaa::parse_latest_release(
            include_str!("../../../../reveille-core/tests/fixtures/openmohaa_latest_release.json"),
            ReleaseTarget::WindowsX64,
        )
        .expect("selected package");
        assert_eq!(
            installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &selected),
            OpenMohaaInstalledBuild::KnownOther {
                channel: ReleaseChannel::Preview,
                version: validated.version,
                relation: OfferRelation::Incomparable,
            }
        );
        fs::write(&client, b"externally replaced").expect("changed client");
        assert!(super::validated_openmohaa_receipt(root, &client).is_none());
    }

    #[test]
    fn a_receipt_only_identifies_the_unchanged_client_and_exact_release() {
        let temporary = TempDir::new().expect("temporary directory");
        let root = temporary.path();
        fs::write(root.join("openmohaa.exe"), b"installed preview").expect("client fixture");
        let preview = ReleasePackage {
            channel: ReleaseChannel::Preview,
            version: "v0.83.0-rc.1".to_owned(),
            semver: ReleaseVersion::parse("v0.83.0-rc.1").expect("preview semver"),
            prerelease: true,
            asset_name: "openmohaa-v0.83.0-rc.1-windows-x64.zip".to_owned(),
            download_url: "https://example.invalid/preview.zip".to_owned(),
            size: 7,
            digest: PublishedSha256::parse(
                "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            )
            .expect("preview digest"),
        };

        assert_eq!(
            installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &preview),
            OpenMohaaInstalledBuild::Unknown
        );
        record_openmohaa_install(root, ReleaseTarget::WindowsX64, &preview).expect("write receipt");
        assert_eq!(
            installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &preview),
            OpenMohaaInstalledBuild::Current
        );

        let stable = ReleasePackage {
            channel: ReleaseChannel::Stable,
            version: "v0.82.1".to_owned(),
            semver: ReleaseVersion::parse("v0.82.1").expect("stable semver"),
            prerelease: false,
            asset_name: "openmohaa-v0.82.1-windows-x64.zip".to_owned(),
            download_url: "https://example.invalid/stable.zip".to_owned(),
            size: 6,
            digest: PublishedSha256::parse(
                "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            )
            .expect("stable digest"),
        };
        assert_eq!(
            installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &stable),
            OpenMohaaInstalledBuild::KnownOther {
                channel: ReleaseChannel::Preview,
                version: preview.version.clone(),
                relation: OfferRelation::Older,
            }
        );

        fs::write(root.join("openmohaa.exe"), b"externally replaced")
            .expect("replace client fixture");
        assert_eq!(
            installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &preview),
            OpenMohaaInstalledBuild::Unknown
        );
    }

    /// The interface takes its word for the action from this ordering, so a channel switch that
    /// offers a lower version cannot be called an update.
    #[test]
    fn the_offered_release_is_ordered_against_the_installed_one() {
        let temporary = TempDir::new().expect("temporary directory");
        let root = temporary.path();
        fs::write(root.join("openmohaa.exe"), b"installed build").expect("client fixture");
        let installed = ReleasePackage {
            channel: ReleaseChannel::Preview,
            version: "v0.83.0-rc.2".to_owned(),
            semver: ReleaseVersion::parse("v0.83.0-rc.2").expect("installed semver"),
            prerelease: true,
            asset_name: "openmohaa-v0.83.0-rc.2-windows-x64.zip".to_owned(),
            download_url: "https://example.invalid/installed.zip".to_owned(),
            size: 9,
            digest: PublishedSha256::parse(&format!("sha256:{}", "2".repeat(64)))
                .expect("installed digest"),
        };
        record_openmohaa_install(root, ReleaseTarget::WindowsX64, &installed).expect("receipt");

        // A different published file every time, so the same-version case is a rebuilt release
        // rather than the current one.
        let offered = |tag: &str| ReleasePackage {
            version: tag.to_owned(),
            semver: ReleaseVersion::parse(tag).expect("offered semver"),
            asset_name: format!("openmohaa-{tag}-windows-x64.zip"),
            digest: PublishedSha256::parse(&format!("sha256:{}", "3".repeat(64)))
                .expect("offered digest"),
            ..installed.clone()
        };
        for (tag, relation) in [
            ("v0.84.0-rc.1", OfferRelation::Newer),
            ("v0.82.1", OfferRelation::Older),
            ("v0.83.0-rc.2", OfferRelation::SameVersion),
        ] {
            assert_eq!(
                installed_openmohaa_build(root, ReleaseTarget::WindowsX64, &offered(tag)),
                OpenMohaaInstalledBuild::KnownOther {
                    channel: ReleaseChannel::Preview,
                    version: installed.version.clone(),
                    relation,
                },
                "offering {tag} against an installed {}",
                installed.version
            );
        }
    }
}
