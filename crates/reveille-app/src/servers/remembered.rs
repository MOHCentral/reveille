// SPDX-License-Identifier: GPL-3.0-only

//! The registrations the master last returned for each game, kept so a sweep can still probe them
//! when the master is down.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::net::SocketAddrV4;
use std::path::{Path, PathBuf};

use reveille_core::discovery::{MasterEndpoint, QueryPort, TargetGame};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

pub const FILENAME: &str = "remembered-servers.json";

#[derive(Debug, Default, Deserialize, Serialize)]
struct RememberedFile {
    v: u32,
    /// `ip:query_port` per game, as the master listed them.
    games: HashMap<TargetGame, Vec<String>>,
}

/// The file, or nothing when the app has no data directory to keep it in.
#[derive(Debug, Default)]
pub struct Remembered {
    path: Option<PathBuf>,
}

impl Remembered {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: Some(directory.join(FILENAME)),
        }
    }

    /// What the master last listed for `game`. A missing or unreadable file reads as none.
    pub fn endpoints(&self, game: TargetGame) -> Vec<MasterEndpoint> {
        self.read()
            .games
            .remove(&game)
            .unwrap_or_default()
            .iter()
            .filter_map(|text| text.parse::<SocketAddrV4>().ok())
            .map(|address| MasterEndpoint {
                address: *address.ip(),
                query_port: QueryPort::new(address.port()),
            })
            .collect()
    }

    /// Replace what is kept for `game` with a complete list the master just returned.
    pub fn remember(&self, game: TargetGame, endpoints: &[MasterEndpoint]) -> io::Result<()> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        let mut file = self.read();
        file.v = 1;
        file.games.insert(
            game,
            endpoints
                .iter()
                .map(|endpoint| {
                    SocketAddrV4::new(endpoint.address, endpoint.query_port.get()).to_string()
                })
                .collect(),
        );
        let directory = path
            .parent()
            .ok_or_else(|| io::Error::other("the remembered list has no directory"))?;
        fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec(&file).map_err(io::Error::other)?;
        // Renamed over the list, so a crash mid-write never leaves half a file that reads as none.
        let mut temporary = NamedTempFile::new_in(directory)?;
        io::Write::write_all(&mut temporary, &bytes)?;
        temporary.persist(path).map_err(|error| error.error)?;
        Ok(())
    }

    fn read(&self) -> RememberedFile {
        self.path
            .as_ref()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::net::Ipv4Addr;

    use reveille_core::discovery::{MasterEndpoint, QueryPort, TargetGame};
    use tempfile::TempDir;

    use super::{FILENAME, Remembered};

    fn endpoint(last: u8) -> MasterEndpoint {
        MasterEndpoint {
            address: Ipv4Addr::new(10, 0, 0, last),
            query_port: QueryPort::new(12300),
        }
    }

    #[test]
    fn each_game_keeps_its_own_last_list() {
        let directory = TempDir::new().expect("data directory");
        let remembered = Remembered::new(directory.path());
        remembered
            .remember(TargetGame::AlliedAssault, &[endpoint(1), endpoint(2)])
            .expect("allied assault");
        remembered
            .remember(TargetGame::Spearhead, &[endpoint(3)])
            .expect("spearhead");
        remembered
            .remember(TargetGame::AlliedAssault, &[endpoint(4)])
            .expect("newer allied assault");

        assert_eq!(
            remembered.endpoints(TargetGame::AlliedAssault),
            [endpoint(4)]
        );
        assert_eq!(remembered.endpoints(TargetGame::Spearhead), [endpoint(3)]);
        assert!(remembered.endpoints(TargetGame::Breakthrough).is_empty());
    }

    #[test]
    fn a_damaged_file_reads_as_nothing_remembered_and_is_replaced() {
        let directory = TempDir::new().expect("data directory");
        fs::write(directory.path().join(FILENAME), b"{ not json").expect("damaged file");
        let remembered = Remembered::new(directory.path());

        assert!(remembered.endpoints(TargetGame::AlliedAssault).is_empty());
        remembered
            .remember(TargetGame::AlliedAssault, &[endpoint(1)])
            .expect("rewritten");
        assert_eq!(
            remembered.endpoints(TargetGame::AlliedAssault),
            [endpoint(1)]
        );
    }

    #[test]
    fn without_a_data_directory_nothing_is_kept_and_nothing_fails() {
        let remembered = Remembered::default();
        remembered
            .remember(TargetGame::AlliedAssault, &[endpoint(1)])
            .expect("no-op");
        assert!(remembered.endpoints(TargetGame::AlliedAssault).is_empty());
    }
}
