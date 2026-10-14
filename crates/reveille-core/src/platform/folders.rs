// SPDX-License-Identifier: GPL-3.0-only

//! Folders a Medal of Honor install commonly lives in, for when the registry names none.
//!
//! A disc install copied from another PC, a GOG offline installer run without Galaxy, or a store
//! uninstall that left the files behind all leave a playable game the registry does not mention.
//! Each candidate is only a place to look: [`crate::install::identify`] still decides whether it
//! holds a game.

use std::ffi::OsString;
use std::path::PathBuf;

/// Install folders below a Program Files directory or a drive root, as the disc installer, the
/// EA App, Origin and GOG name them by default, plus the short names players pick by hand.
const RELATIVE_ROOTS: &[&str] = &[
    "EA Games/MOHAA",
    "EA Games/Medal of Honor Allied Assault",
    "EA Games/Medal of Honor Allied Assault War Chest",
    "Origin Games/Medal of Honor Allied Assault War Chest",
    "Origin Games/Medal of Honor Allied Assault",
    "GOG Galaxy/Games/Medal of Honor Allied Assault War Chest",
    "GOG Games/Medal of Honor Allied Assault War Chest",
    "GOG.com/Medal of Honor Allied Assault War Chest",
    "Medal of Honor Allied Assault War Chest",
    "Medal of Honor Allied Assault",
    "Games/MOHAA",
    "Games/Medal of Honor Allied Assault",
    "MOHAA",
];

/// The environment variables that name Program Files directories on Windows.
const PROGRAM_FILES: &[&str] = &["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"];

/// Every candidate install folder below `bases`, in order and without repeats.
#[must_use]
pub fn common_install_roots(bases: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for base in bases {
        for relative in RELATIVE_ROOTS {
            let root = relative
                .split('/')
                .fold(base.clone(), |path, part| path.join(part));
            if !roots.contains(&root) {
                roots.push(root);
            }
        }
    }
    roots
}

/// The Program Files directories `environment` names, then, on Windows, each drive root.
///
/// `environment` reads one variable, as [`std::env::var_os`] does; it is a parameter so the order
/// can be tested without depending on the machine running the test.
#[must_use]
pub fn common_bases(environment: impl Fn(&str) -> Option<OsString>) -> Vec<PathBuf> {
    let mut bases = Vec::new();
    for name in PROGRAM_FILES {
        if let Some(value) = environment(name).filter(|value| !value.is_empty()) {
            let base = PathBuf::from(value);
            if !bases.contains(&base) {
                bases.push(base);
            }
        }
    }
    if cfg!(windows) {
        bases.extend((b'C'..=b'Z').map(|drive| PathBuf::from(format!("{}:\\", char::from(drive)))));
    }
    bases
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::path::PathBuf;

    use super::{RELATIVE_ROOTS, common_bases, common_install_roots};

    #[test]
    fn program_files_come_first_and_are_not_repeated() {
        let environment = |name: &str| match name {
            "ProgramFiles(x86)" => Some(OsString::from("/pf86")),
            "ProgramFiles" | "ProgramW6432" => Some(OsString::from("/pf")),
            _ => None,
        };
        let bases = common_bases(environment);
        assert_eq!(bases[..2], [PathBuf::from("/pf86"), PathBuf::from("/pf")]);
        assert_eq!(
            bases
                .iter()
                .filter(|base| base.as_path() == std::path::Path::new("/pf"))
                .count(),
            1
        );
    }

    #[test]
    fn an_empty_variable_names_no_folder() {
        let bases = common_bases(|_| Some(OsString::new()));
        assert!(!bases.iter().any(|base| base.as_os_str().is_empty()));
    }

    #[test]
    fn every_known_folder_is_tried_below_every_base() {
        let bases = [PathBuf::from("/a"), PathBuf::from("/b")];
        let roots = common_install_roots(&bases);
        assert_eq!(roots.len(), 2 * RELATIVE_ROOTS.len());
        assert_eq!(roots[0], PathBuf::from("/a/EA Games/MOHAA"));
        assert!(roots.contains(&PathBuf::from(
            "/b/GOG Games/Medal of Honor Allied Assault War Chest"
        )));
    }
}
