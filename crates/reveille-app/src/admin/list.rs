// SPDX-License-Identifier: GPL-3.0-only

//! The servers the player said they run: address and name, kept in the app data directory.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

pub const FILENAME: &str = "admin-servers.json";

/// One server added to Admin. No password: that is in the credential store.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AdminServer {
    /// Game address, `ip:port`.
    pub address: String,
    /// The name the server gave when it was added.
    pub name: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct ListFile {
    v: u32,
    servers: Vec<AdminServer>,
}

#[derive(Clone, Debug)]
pub struct AdminList {
    path: PathBuf,
}

impl AdminList {
    pub fn new(directory: &Path) -> Self {
        Self {
            path: directory.join(FILENAME),
        }
    }

    /// Every server added, in the order they were. A missing or unreadable file reads as none.
    pub fn servers(&self) -> Vec<AdminServer> {
        fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<ListFile>(&bytes).ok())
            .map(|file| file.servers)
            .unwrap_or_default()
    }

    /// Add `server`, or rename it if its address is already there.
    pub fn add(&self, server: AdminServer) -> io::Result<()> {
        let mut servers = self.servers();
        if let Some(known) = servers
            .iter_mut()
            .find(|known| known.address == server.address)
        {
            *known = server;
        } else {
            servers.push(server);
        }
        self.write(&ListFile { v: 1, servers })
    }

    pub fn remove(&self, address: &str) -> io::Result<()> {
        let mut servers = self.servers();
        servers.retain(|known| known.address != address);
        self.write(&ListFile { v: 1, servers })
    }

    fn write(&self, file: &ListFile) -> io::Result<()> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("the admin list has no directory"))?;
        fs::create_dir_all(directory)?;
        let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
        // Renamed over the list, so a crash mid-write never leaves half a file that reads as none.
        let mut temporary = NamedTempFile::new_in(directory)?;
        io::Write::write_all(&mut temporary, &bytes)?;
        temporary.persist(&self.path).map_err(|error| error.error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::{AdminList, AdminServer};

    fn server(address: &str, name: &str) -> AdminServer {
        AdminServer {
            address: address.to_owned(),
            name: name.to_owned(),
        }
    }

    #[test]
    fn servers_are_kept_in_order_and_re_adding_renames() {
        let data = TempDir::new().expect("temp");
        let list = AdminList::new(&data.path().join("nested"));
        assert!(list.servers().is_empty());
        list.add(server("203.0.113.4:12203", "harzCore"))
            .expect("add");
        list.add(server("198.51.100.2:12203", "[DSB]Clan DM"))
            .expect("add");
        list.add(server("203.0.113.4:12203", "harzCore | Stock Maps"))
            .expect("add");
        assert_eq!(
            list.servers(),
            vec![
                server("203.0.113.4:12203", "harzCore | Stock Maps"),
                server("198.51.100.2:12203", "[DSB]Clan DM"),
            ]
        );
        list.remove("203.0.113.4:12203").expect("remove");
        assert_eq!(
            list.servers(),
            vec![server("198.51.100.2:12203", "[DSB]Clan DM")]
        );
    }

    #[test]
    fn the_file_never_holds_a_password_field() {
        let data = TempDir::new().expect("temp");
        let list = AdminList::new(data.path());
        list.add(server("203.0.113.4:12203", "harzCore"))
            .expect("add");
        let text = std::fs::read_to_string(data.path().join(super::FILENAME)).expect("read");
        assert!(!text.to_lowercase().contains("password"), "{text}");
    }
}
