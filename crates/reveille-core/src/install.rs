// SPDX-License-Identifier: GPL-3.0-only

//! Platform-neutral identification of a user-selected MOHAA installation.

use std::fs::File;
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::discovery::TargetGame;

/// A staging marker left until an installation copy is complete and validated.
pub const INCOMPLETE_COPY_MARKER: &str = ".reveille-copy-incomplete";

/// A game whose asset directory is present.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Product {
    /// Medal of Honor: Allied Assault (`main`).
    AlliedAssault,
    /// Spearhead (`mainta`).
    Spearhead,
    /// Breakthrough (`maintt`).
    Breakthrough,
}

impl Product {
    /// Every product, in base-to-expansion order.
    pub const ALL: [Self; 3] = [Self::AlliedAssault, Self::Spearhead, Self::Breakthrough];

    /// Asset directory whose presence proves this product is installed.
    #[must_use]
    pub const fn data_directory(self) -> &'static str {
        match self {
            Self::AlliedAssault => "main",
            Self::Spearhead => "mainta",
            Self::Breakthrough => "maintt",
        }
    }
}

impl From<TargetGame> for Product {
    /// A master-list family and an installed product are the same three things named twice.
    fn from(value: TargetGame) -> Self {
        match value {
            TargetGame::AlliedAssault => Self::AlliedAssault,
            TargetGame::Spearhead => Self::Spearhead,
            TargetGame::Breakthrough => Self::Breakthrough,
        }
    }
}

/// A recognized client executable and its SHA-256 identity.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct BinaryFingerprint {
    /// Original path to the client binary.
    pub path: PathBuf,
    /// Lowercase hexadecimal SHA-256 digest.
    pub sha256: String,
    /// Curated version label, when this digest is known-good.
    pub known_version: Option<String>,
}

/// How an installation was identified. Consumers must handle uncertainty explicitly.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum IdentificationMethod {
    /// At least one client binary matched the curated known-good digest corpus.
    KnownBinaryHashes,
    /// Client binary names were recognized, but none of their hashes are in the corpus yet.
    RecognizedBinaryUnknownHashes,
    /// Asset directories exist, but no recognized client executable was found.
    DataDirectoriesOnly,
}

/// Result of identifying a path selected by the user.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Installation {
    /// Canonicalized installation root.
    pub root: PathBuf,
    /// Products inferred from data directories, in base-to-expansion order.
    pub products: Vec<Product>,
    /// The subset of `products` this install can actually run, in the same order.
    ///
    /// Different from `products` for one reason: an expansion is playable only over the base
    /// game, because the engine reads `main` underneath it (rule H13). A folder holding `mainta`
    /// and no `main` has Spearhead among its products and nothing among its playable games.
    pub playable: Vec<Product>,
    /// Recognized client binaries and their identities.
    pub binaries: Vec<BinaryFingerprint>,
    /// Evidence used for this identification.
    pub identification: IdentificationMethod,
}

impl Installation {
    /// Whether this install has the assets one game family needs.
    ///
    /// Presence of the data directories is the evidence, exactly as `identify` collected it. It
    /// says nothing about whether a client executable for that product exists.
    ///
    /// An expansion needs **both** directories, not just its own: the engine adds `main` and then
    /// `mainta` or `maintt` on top of it (`join.rs` `search_directories`, rule H13). A folder
    /// holding `mainta` alone would otherwise be offered as Spearhead and then indexed from
    /// `mainta` alone — the exact state H13 exists to prevent.
    #[must_use]
    pub fn provides(&self, target: TargetGame) -> bool {
        let required = Product::from(target);
        self.products.contains(&required)
            && (required == Product::AlliedAssault
                || self.products.contains(&Product::AlliedAssault))
    }
}

/// An error encountered while identifying an install.
#[derive(Debug, Error)]
pub enum Error {
    /// The selected path is not a directory.
    #[error("install path is not a directory: {0}")]
    NotDirectory(PathBuf),
    /// None of the MOHAA asset directories are present.
    #[error("no main, mainta, or maintt data directory found in {0}")]
    NoDataDirectories(PathBuf),
    /// A one-time writable copy did not reach its validated final state.
    #[error("installation copy is incomplete: {0}")]
    IncompleteCopy(PathBuf),
    /// Filesystem metadata could not be read.
    #[error("could not inspect {path}")]
    Io {
        /// Path being inspected.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: io::Error,
    },
}

const CLIENT_BINARIES: [&str; 7] = [
    "mohaa.exe",
    "mohaas.exe",
    "mohaab.exe",
    "moh_spearhead.exe",
    "moh_breakthrough.exe",
    "openmohaa.exe",
    "openmohaa",
];

// Measured from a French retail-disc install on Windows, 19 Aug 2026.
const KNOWN_BINARY_VERSIONS: [(&str, &str); 3] = [
    (
        "ed028e97cb56ea3a89a821635b07e0ed87bcbab751b6e13e88edc9c02dfc88cc",
        "Medal of Honor: Allied Assault 1.11 (retail disc, French)",
    ),
    (
        "74de88a1721277d509172966600fd00c34a71d4003ea008af48e230468154ac6",
        "Medal of Honor: Allied Assault Spearhead 2.15 (retail disc, French)",
    ),
    (
        "7a6ee79a01b82dce2fce36e8eb474cc32718bccb58b039847798c222e0113ccf",
        "Medal of Honor: Allied Assault Breakthrough 2.40 (retail disc, French)",
    ),
];

/// Identify a user-selected install root without applying platform discovery policy.
///
/// # Errors
///
/// Returns an error when the path is not a directory, has no recognized asset directory, or a
/// recognized client binary cannot be read and hashed.
pub fn identify(path: impl AsRef<Path>) -> Result<Installation, Error> {
    let path = path.as_ref();
    if !path.is_dir() {
        return Err(Error::NotDirectory(path.to_path_buf()));
    }

    let root = path.canonicalize().map_err(|source| Error::Io {
        path: path.to_path_buf(),
        source,
    })?;
    if root.join(INCOMPLETE_COPY_MARKER).is_file() {
        return Err(Error::IncompleteCopy(root));
    }
    let products = Product::ALL
        .iter()
        .filter_map(|product| {
            root.join(product.data_directory())
                .is_dir()
                .then_some(*product)
        })
        .collect::<Vec<_>>();
    if products.is_empty() {
        return Err(Error::NoDataDirectories(root));
    }

    let mut binaries = Vec::new();
    for file_name in CLIENT_BINARIES {
        let binary = root.join(file_name);
        if binary.is_file() {
            let sha256 = hash_file(&binary)?;
            let known_version = known_version(&sha256).map(str::to_owned);
            binaries.push(BinaryFingerprint {
                path: binary,
                sha256,
                known_version,
            });
        }
    }

    // Derived here rather than in the interface, so the one rule about what an expansion needs
    // lives in one place (H13/H14).
    let playable = Product::ALL
        .iter()
        .filter(|product| {
            **product == Product::AlliedAssault && products.contains(product)
                || products.contains(product) && products.contains(&Product::AlliedAssault)
        })
        .copied()
        .collect::<Vec<_>>();

    let identification = if binaries.iter().any(|binary| binary.known_version.is_some()) {
        IdentificationMethod::KnownBinaryHashes
    } else if binaries.is_empty() {
        IdentificationMethod::DataDirectoriesOnly
    } else {
        IdentificationMethod::RecognizedBinaryUnknownHashes
    };

    Ok(Installation {
        root,
        products,
        playable,
        binaries,
        identification,
    })
}

/// Identify the folder a player picked, allowing for a pick one level off the game root.
///
/// Players often pick `main` itself, or the folder that holds the game folder. A data directory
/// resolves to the folder above it; otherwise a single child holding a data directory is taken.
/// Two such children are ambiguous, so neither is guessed.
///
/// `Ok(None)` means no game is there, which is the player's answer to correct, not a failure.
///
/// # Errors
///
/// Returns an error when the path is not a directory, a folder cannot be read, or the game found
/// is an incomplete copy.
pub fn identify_selected(path: impl AsRef<Path>) -> Result<Option<Installation>, Error> {
    let root = match identify(path) {
        Err(Error::NoDataDirectories(root)) => root,
        found => return found.map(Some),
    };
    let is_data_directory = root.file_name().is_some_and(|name| {
        Product::ALL
            .iter()
            .any(|product| name.eq_ignore_ascii_case(product.data_directory()))
    });
    if is_data_directory && let Some(parent) = root.parent() {
        return identify(parent).map(Some);
    }
    let entries = std::fs::read_dir(&root).map_err(|source| Error::Io {
        path: root.clone(),
        source,
    })?;
    let mut candidates = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|child| {
            Product::ALL
                .iter()
                .any(|product| child.join(product.data_directory()).is_dir())
        });
    match (candidates.next(), candidates.next()) {
        (Some(child), None) => identify(child).map(Some),
        _ => Ok(None),
    }
}

fn known_version(hash: &str) -> Option<&'static str> {
    KNOWN_BINARY_VERSIONS
        .iter()
        .find_map(|(known_hash, version)| (*known_hash == hash).then_some(*version))
}

fn hash_file(path: &Path) -> Result<String, Error> {
    let file = File::open(path).map_err(|source| Error::Io {
        path: path.to_path_buf(),
        source,
    })?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 8 * 1024];
    loop {
        let read = reader.read(&mut buffer).map_err(|source| Error::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::{
        Error, IdentificationMethod, Product, TargetGame, identify, identify_selected,
        known_version,
    };

    #[test]
    fn identifies_products_and_exposes_an_unknown_binary_hash() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::create_dir(temporary.path().join("mainta")).expect("mainta directory");
        fs::write(temporary.path().join("mohaa.exe"), b"synthetic client").expect("client");

        let install = identify(temporary.path()).expect("identify install");
        assert_eq!(
            install.products,
            vec![Product::AlliedAssault, Product::Spearhead]
        );
        assert_eq!(
            install.identification,
            IdentificationMethod::RecognizedBinaryUnknownHashes
        );
        assert_eq!(install.binaries.len(), 1);
        assert_eq!(
            install.binaries[0].sha256,
            "186cb4adf190a9e198815dc58eadf188c96d5eff95a8eb6f23d5693311a55268"
        );
        assert_eq!(install.binaries[0].known_version, None);
    }

    #[test]
    fn an_expansion_directory_alone_does_not_make_that_expansion_playable() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("mainta")).expect("mainta directory");

        // The directory is there, so the product is detected...
        let install = identify(temporary.path()).expect("identify assets");
        assert_eq!(install.products, vec![Product::Spearhead]);
        // ...but the engine would read `main` underneath it, and there is no `main` (H13).
        assert!(!install.provides(TargetGame::Spearhead));
        assert!(!install.provides(TargetGame::AlliedAssault));
        assert!(install.playable.is_empty());

        fs::create_dir(temporary.path().join("main")).expect("main directory");
        let install = identify(temporary.path()).expect("identify assets");
        assert!(install.provides(TargetGame::Spearhead));
        assert_eq!(
            install.playable,
            vec![Product::AlliedAssault, Product::Spearhead]
        );
        assert!(!install.provides(TargetGame::Breakthrough));
    }

    #[test]
    fn accepts_assets_without_claiming_a_binary_version() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");

        let install = identify(temporary.path()).expect("identify assets");
        assert_eq!(
            install.identification,
            IdentificationMethod::DataDirectoriesOnly
        );
    }

    #[test]
    fn recognizes_the_extensionless_openmohaa_client() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::write(temporary.path().join("openmohaa"), b"macOS client").expect("client");

        let install = identify(temporary.path()).expect("identify install");
        assert_eq!(
            install.identification,
            IdentificationMethod::RecognizedBinaryUnknownHashes
        );
        assert_eq!(install.binaries.len(), 1);
        assert_eq!(install.binaries[0].path, install.root.join("openmohaa"));
    }

    #[test]
    fn rejects_unrelated_directories() {
        let temporary = TempDir::new().expect("temporary directory");
        assert!(matches!(
            identify(temporary.path()),
            Err(Error::NoDataDirectories(_))
        ));
    }

    #[test]
    fn a_picked_folder_without_a_game_is_no_game_rather_than_an_error() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("Screenshots")).expect("unrelated directory");

        assert!(
            identify_selected(temporary.path())
                .expect("readable folder")
                .is_none()
        );
    }

    #[test]
    fn picking_a_data_directory_selects_the_game_folder_above_it() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::create_dir(temporary.path().join("mainta")).expect("mainta directory");

        for picked in ["main", "mainta"] {
            let install = identify_selected(temporary.path().join(picked))
                .expect("identify install")
                .expect("game found above the pick");
            assert_eq!(
                install.root,
                temporary.path().canonicalize().expect("canonical root")
            );
        }
    }

    #[test]
    fn picking_the_folder_that_holds_the_game_selects_the_game_inside() {
        let temporary = TempDir::new().expect("temporary directory");
        let game = temporary.path().join("MOHAA");
        fs::create_dir_all(game.join("main")).expect("main directory");
        fs::create_dir(temporary.path().join("Other game")).expect("unrelated directory");

        let install = identify_selected(temporary.path())
            .expect("identify install")
            .expect("game found below the pick");
        assert_eq!(install.root, game.canonicalize().expect("canonical root"));
    }

    #[test]
    fn two_games_below_the_pick_are_not_guessed_between() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir_all(temporary.path().join("MOHAA/main")).expect("first game");
        fs::create_dir_all(temporary.path().join("MOHAA copy/main")).expect("second game");

        assert!(
            identify_selected(temporary.path())
                .expect("readable folder")
                .is_none()
        );
    }

    #[test]
    fn a_picked_game_folder_is_identified_where_it_is() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::create_dir_all(temporary.path().join("backup/main")).expect("nested copy");

        let install = identify_selected(temporary.path())
            .expect("identify install")
            .expect("game found at the pick");
        assert_eq!(
            install.root,
            temporary.path().canonicalize().expect("canonical root")
        );
    }

    #[test]
    fn a_picked_incomplete_copy_stays_an_error() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::write(temporary.path().join(super::INCOMPLETE_COPY_MARKER), b"").expect("marker");

        assert!(matches!(
            identify_selected(temporary.path()),
            Err(Error::IncompleteCopy(_))
        ));
    }

    #[test]
    fn all_lists_every_product_once_in_base_to_expansion_order() {
        // Adding a variant breaks this match, which is the prompt to extend `ALL`.
        const fn ordinal(product: Product) -> usize {
            match product {
                Product::AlliedAssault => 0,
                Product::Spearhead => 1,
                Product::Breakthrough => 2,
            }
        }
        assert!(
            Product::ALL
                .into_iter()
                .map(ordinal)
                .eq(0..Product::ALL.len())
        );
    }

    #[test]
    fn every_target_game_maps_to_the_product_in_the_same_position() {
        assert!(
            TargetGame::ALL
                .into_iter()
                .map(Product::from)
                .eq(Product::ALL)
        );
    }

    #[test]
    fn identifies_the_measured_retail_disc_hash() {
        assert_eq!(
            known_version("ed028e97cb56ea3a89a821635b07e0ed87bcbab751b6e13e88edc9c02dfc88cc"),
            Some("Medal of Honor: Allied Assault 1.11 (retail disc, French)")
        );
    }
}
