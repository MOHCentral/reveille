// SPDX-License-Identifier: GPL-3.0-only

pub mod browse;
pub mod check;
pub mod failure;

use std::net::SocketAddrV4;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use reveille_core::discovery::{Server, TargetGame};
use reveille_core::join::CompatibilityAssessment;
use reveille_core::mapindex::MapIndex;
use serde::Serialize;
use tauri::Manager;
use tokio::sync::Notify;

/// Deadline for one per-server UDP probe.
///
/// The sweep and the single-server check share it deliberately: a remembered server checked on a
/// gentler deadline than the sweep uses would be listed on terms the list itself never offered.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(2_500);

#[derive(Default)]
pub struct Listing {
    /// The servers behind the current list, keyed on by address when a join is prepared.
    list: Mutex<List>,
    /// Raised to stop an in-flight sweep.
    cancel: Notify,
}

#[derive(Default)]
struct List {
    /// The game the servers were gathered for. A game endpoint is only a join target for the game
    /// that answered there, so an address alone does not identify an entry.
    game: Option<TargetGame>,
    /// Bumped whenever a sweep replaces the list. Work that awaited the network holds the
    /// generation it began under and writes nothing once it has moved on.
    generation: u64,
    servers: Vec<Server>,
}

/// The list a piece of work began against.
#[derive(Clone, Copy)]
pub struct ListTicket {
    game: TargetGame,
    generation: u64,
}

impl Listing {
    pub fn find(&self, address: &str, game: TargetGame) -> Result<Server, String> {
        let address = address
            .parse::<SocketAddrV4>()
            .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
        let gone =
            || "This server is no longer in the current list. Refresh and try again.".to_owned();
        let list = self.lock()?;
        if list.game != Some(game) {
            return Err(gone());
        }
        list.servers
            .iter()
            .find(|server| {
                SocketAddrV4::new(server.endpoint.address, server.game_port.get()) == address
            })
            .cloned()
            .ok_or_else(gone)
    }

    /// Start a new list for `game`, retiring every ticket issued against the old one.
    fn begin_sweep(&self, game: TargetGame) -> Result<ListTicket, String> {
        let mut list = self.lock()?;
        list.generation = list.generation.wrapping_add(1);
        list.game = Some(game);
        list.servers.clear();
        Ok(ListTicket {
            game,
            generation: list.generation,
        })
    }

    /// The current list, as seen by work for `game` that is about to await the network.
    fn ticket(&self, game: TargetGame) -> Result<ListTicket, String> {
        Ok(ListTicket {
            game,
            generation: self.lock()?.generation,
        })
    }

    /// Change the list only if it is still the one `ticket` was issued against.
    ///
    /// Returns `None` when a sweep or a game switch has replaced it since: what the work found is
    /// about a list nobody is looking at any more.
    fn update<R>(
        &self,
        ticket: ListTicket,
        change: impl FnOnce(&mut Vec<Server>) -> R,
    ) -> Result<Option<R>, String> {
        let mut list = self.lock()?;
        if list.generation != ticket.generation || list.game.is_some_and(|game| game != ticket.game)
        {
            return Ok(None);
        }
        list.game = Some(ticket.game);
        Ok(Some(change(&mut list.servers)))
    }

    fn lock(&self) -> Result<MutexGuard<'_, List>, String> {
        self.list
            .lock()
            .map_err(|_| "server list state is unavailable".to_owned())
    }
}

#[derive(Clone, Serialize)]
pub struct BrowserServer {
    address: SocketAddrV4,
    server: Server,
    compatibility: CompatibilityAssessment,
}

pub fn classified(server: &Server, index: &MapIndex) -> BrowserServer {
    BrowserServer {
        address: SocketAddrV4::new(server.endpoint.address, server.game_port.get()),
        compatibility: reveille_core::join::classify_server(index, server, None),
        server: server.clone(),
    }
}

pub fn register(app: &mut tauri::App) {
    app.manage(Listing::default());
}

#[cfg(test)]
mod tests {
    use reveille_core::discovery::{
        GamePort, MasterEndpoint, QueryPort, ReportedOccupancy, RoundTripMillis, Server, TargetGame,
    };

    use super::Listing;

    fn server(address: &str) -> Server {
        Server {
            endpoint: MasterEndpoint {
                address: address.parse().expect("address"),
                query_port: QueryPort::new(12300),
            },
            game_port: GamePort::new(12203),
            hostname: address.to_owned(),
            game_name: None,
            game_version: None,
            version: None,
            protocol: None,
            current_map: None,
            game_type: None,
            rotation: Vec::new(),
            allow_download: None,
            map_checksum: None,
            pr_downloads: None,
            minimum_ping: None,
            maximum_ping: None,
            join_window: None,
            reserved_slots: None,
            occupancy: ReportedOccupancy::default(),
            client_capacity: None,
            players: Vec::new(),
            pure: None,
            status_round_trip: RoundTripMillis::new(12),
        }
    }

    #[test]
    fn a_server_listed_for_one_game_is_not_found_for_another() {
        let listing = Listing::default();
        let sweep = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        listing
            .update(sweep, |servers| servers.push(server("10.0.0.1")))
            .expect("update");

        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_ok()
        );
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::Spearhead)
                .is_err()
        );
    }

    #[test]
    fn a_superseded_sweep_writes_nothing_into_the_list_that_replaced_it() {
        let listing = Listing::default();
        let old = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        let new = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");

        let late = listing
            .update(old, |servers| *servers = vec![server("10.0.0.1")])
            .expect("update");
        listing
            .update(new, |servers| servers.push(server("10.0.0.2")))
            .expect("update");

        assert!(late.is_none());
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_err()
        );
        assert!(
            listing
                .find("10.0.0.2:12203", TargetGame::AlliedAssault)
                .is_ok()
        );
    }
}
