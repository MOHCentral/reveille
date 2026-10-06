// SPDX-License-Identifier: GPL-3.0-only

use std::path::PathBuf;

use reveille_core::discovery::TargetGame;
use reveille_core::engine::EngineChoice;
use reveille_core::install::{self, Installation};
use reveille_core::mapindex::MapIndex;
use reveille_platform as platform;
use serde::Deserialize;
use thiserror::Error;

/// What every server-facing command needs before it can say anything: which game folder, which
/// engine program, and which of the three games.
///
/// One struct rather than three repeated parameters, so a command cannot be given the folder and
/// the engine and quietly left with the wrong game.
#[derive(Clone, Deserialize)]
pub struct Session {
    pub path: String,
    pub engine: EngineChoice,
    pub game: TargetGame,
}

/// Resolve the installation, confirm the engine it will run, and index the maps on disk.
///
/// This path is deliberately read-only. Browsing and joining a server whose map is already on disk
/// need no writable destination, so a Program Files installation must reach them without a probe.
/// The index still covers every directory the engine reads, including `main` beneath an expansion.
pub fn installed_maps(session: &Session) -> Result<MapIndex, SessionError> {
    let search = session_search_path(session)?;
    MapIndex::scan_chain(&search).map_err(SessionError::Maps)
}

pub fn session_search_path(session: &Session) -> Result<Vec<PathBuf>, SessionError> {
    let installation = session_installation(session)?;
    Ok(platform::content_search_path(
        &installation.root,
        session.game,
        platform::ClientKind::from(session.engine),
    ))
}

/// Why a saved session no longer matches the PC it runs on: the folder, the game in it, the engine
/// program, or the maps it holds. Typed so the server list can tell a player which one to fix.
#[derive(Debug, Error)]
pub enum SessionError {
    #[error(transparent)]
    Folder(install::Error),
    // The directory name is what the check actually looked at, and it is exactly the detail a
    // newcomer cannot act on. Say which game is missing from the folder they picked.
    #[error("{} cannot be run from this game folder: its game files are not there.", .0.label())]
    GameMissing(TargetGame),
    #[error(transparent)]
    Engine(platform::engine::EngineError),
    #[error(transparent)]
    Maps(reveille_core::mapindex::Error),
}

impl From<SessionError> for String {
    fn from(error: SessionError) -> Self {
        error.to_string()
    }
}

pub fn session_installation(session: &Session) -> Result<Installation, SessionError> {
    let installation = install::identify(&session.path).map_err(SessionError::Folder)?;
    if !installation.provides(session.game) {
        return Err(SessionError::GameMissing(session.game));
    }
    platform::engine::resolve_choice(
        &installation.root,
        Some(session.engine),
        &platform::HostCapabilities::current(),
    )
    .map_err(SessionError::Engine)?;
    Ok(installation)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use reveille_core::discovery::TargetGame;
    use reveille_core::engine::EngineChoice;
    use reveille_platform as platform;
    use tempfile::TempDir;

    use super::{Session, installed_maps};

    #[test]
    fn the_session_payload_matches_what_the_shell_sends() {
        // `lib/api.js` sends `{ session: { path, engine, game } }`, and both enums travel as the
        // snake_case names the rest of the payloads already use. A rename on either side is a
        // silent "invalid args" on every command, so it is pinned here rather than found by hand.
        let session: Session = serde_json::from_str(
            r#"{"path":"D:\\Games\\MOHAA","engine":"openmohaa","game":"breakthrough"}"#,
        )
        .expect("the shell's session payload");

        assert_eq!(session.path, r"D:\Games\MOHAA");
        assert_eq!(session.engine, EngineChoice::Openmohaa);
        assert_eq!(session.game, TargetGame::Breakthrough);
    }

    #[test]
    fn a_game_the_folder_has_no_files_for_is_refused_before_anything_is_probed() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::write(
            platform::default_client(
                temporary.path(),
                TargetGame::AlliedAssault,
                platform::ClientKind::OpenMohaa,
            ),
            [],
        )
        .expect("client marker");
        let path = temporary.path().to_string_lossy().into_owned();

        // Allied Assault is what this folder has, and it indexes.
        installed_maps(&Session {
            path: path.clone(),
            engine: EngineChoice::Openmohaa,
            game: TargetGame::AlliedAssault,
        })
        .expect("the base game indexes");

        // Spearhead is not, and saying so beats an empty map index that would report every map
        // on the server as missing. The message names the game, never the engine's directory:
        // `mainta` is what the check looked at and is not something a player can act on.
        let refusal = installed_maps(&Session {
            path: path.clone(),
            engine: EngineChoice::Openmohaa,
            game: TargetGame::Spearhead,
        })
        .expect_err("an absent expansion is refused")
        .to_string();
        assert!(refusal.contains("Spearhead"), "{refusal}");
        assert!(!refusal.contains("mainta"), "{refusal}");

        // "Before anything is probed" is the load-bearing half: this folder has no retail
        // executable either, so asking for Original as well proves which check runs first. A
        // writability probe or a home fallback must never happen for a game that was never
        // runnable from this folder.
        let refusal = installed_maps(&Session {
            path,
            engine: EngineChoice::Original,
            game: TargetGame::Spearhead,
        })
        .expect_err("an absent expansion is refused whatever the engine")
        .to_string();
        assert!(refusal.contains("Spearhead"), "{refusal}");
    }

    #[test]
    fn read_only_indexing_does_not_resolve_or_create_a_write_target() {
        let temporary = TempDir::new().expect("temporary directory");
        let root = temporary.path();
        fs::create_dir_all(root.join("main/maps/dm")).expect("map directory");
        let client_name = if cfg!(windows) {
            "openmohaa.exe"
        } else {
            "openmohaa"
        };
        fs::write(root.join(client_name), b"openmohaa client").expect("openmohaa client");
        let bsp = [
            b"2015".as_slice(),
            &19_i32.to_le_bytes(),
            &42_i32.to_le_bytes(),
        ]
        .concat();
        fs::write(root.join("main/maps/dm/stock.bsp"), bsp).expect("stock map");
        let mut before = fs::read_dir(root)
            .expect("installation entries")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        before.sort();

        let index = installed_maps(&Session {
            path: root.to_string_lossy().into_owned(),
            engine: EngineChoice::Openmohaa,
            game: TargetGame::AlliedAssault,
        })
        .expect("read-only index");

        assert!(index.get("dm/stock").is_some());
        let mut after = fs::read_dir(root)
            .expect("installation entries")
            .map(|entry| entry.expect("entry").file_name())
            .collect::<Vec<_>>();
        after.sort();
        assert_eq!(after, before);
        assert!(!root.join(".reveille-engines").exists());
        assert!(
            fs::read_dir(root.join("main"))
                .expect("main entries")
                .all(|entry| !entry
                    .expect("main entry")
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".reveille-write-probe"))
        );
    }
}
