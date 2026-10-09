// SPDX-License-Identifier: GPL-3.0-only

pub mod browse;
pub mod check;
pub mod failure;

use std::collections::{HashMap, HashSet};
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
    /// Bumped whenever a foreground sweep replaces the list. Work that awaited the network holds the
    /// generation it began under and writes nothing once it has moved on.
    generation: u64,
    servers: Vec<Server>,
    /// Endpoints a direct check or join owns until the next sweep starts, including absent answers.
    checked: HashSet<SocketAddrV4>,
    joining: HashMap<SocketAddrV4, usize>,
}

/// The list a piece of work began against.
#[derive(Clone, Copy)]
pub struct ListTicket {
    game: TargetGame,
    generation: u64,
}

impl List {
    fn find(&self, address: &str, game: TargetGame) -> Result<Server, String> {
        let address = address
            .parse::<SocketAddrV4>()
            .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
        let gone =
            || "This server is no longer in the current list. Refresh and try again.".to_owned();
        if self.game != Some(game) {
            return Err(gone());
        }
        self.servers
            .iter()
            .find(|server| {
                SocketAddrV4::new(server.endpoint.address, server.game_port.get()) == address
            })
            .cloned()
            .ok_or_else(gone)
    }
}

pub struct JoinOwnership<'a> {
    listing: &'a Listing,
    ticket: ListTicket,
    address: SocketAddrV4,
}

impl Drop for JoinOwnership<'_> {
    fn drop(&mut self) {
        let _ = self.listing.update_list(self.ticket, |list| {
            if let Some(count) = list.joining.get_mut(&self.address) {
                *count -= 1;
                if *count == 0 {
                    list.joining.remove(&self.address);
                }
            }
        });
    }
}

impl Listing {
    pub fn find(&self, address: &str, game: TargetGame) -> Result<Server, String> {
        self.lock()?.find(address, game)
    }

    /// Keep the command's target through overlapping sweeps, until a later refresh starts.
    pub fn find_for_join(
        &self,
        address: &str,
        game: TargetGame,
    ) -> Result<(Server, JoinOwnership<'_>), String> {
        let mut list = self.lock()?;
        let server = list.find(address, game)?;
        let address = SocketAddrV4::new(server.endpoint.address, server.game_port.get());
        list.checked.insert(address);
        *list.joining.entry(address).or_default() += 1;
        let ownership = JoinOwnership {
            listing: self,
            ticket: ListTicket {
                game,
                generation: list.generation,
            },
            address,
        };
        Ok((server, ownership))
    }

    /// Start a new list for `game`, retiring every ticket issued against the old one.
    fn begin_sweep(&self, game: TargetGame) -> Result<ListTicket, String> {
        let mut list = self.lock()?;
        list.generation = list.generation.wrapping_add(1);
        list.game = Some(game);
        list.servers.clear();
        list.checked.clear();
        list.joining.clear();
        Ok(ListTicket {
            game,
            generation: list.generation,
        })
    }

    fn begin_background_sweep(&self, game: TargetGame) -> Result<ListTicket, String> {
        let mut list = self.lock()?;
        if list.game != Some(game) {
            drop(list);
            return self.begin_sweep(game);
        }
        list.checked.clear();
        let joining: Vec<_> = list.joining.keys().copied().collect();
        list.checked.extend(joining);
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

    fn update_checked<R>(
        &self,
        ticket: ListTicket,
        addresses: impl IntoIterator<Item = SocketAddrV4>,
        change: impl FnOnce(&mut Vec<Server>) -> R,
    ) -> Result<Option<R>, String> {
        self.update_list(ticket, |list| {
            list.checked.extend(addresses);
            change(&mut list.servers)
        })
    }

    fn update_sweep(
        &self,
        ticket: ListTicket,
        servers: Vec<Server>,
        replace: bool,
    ) -> Result<Option<()>, String> {
        self.update_list(ticket, |list| {
            let address = |server: &Server| {
                SocketAddrV4::new(server.endpoint.address, server.game_port.get())
            };
            let incoming: Vec<_> = servers
                .into_iter()
                .filter(|server| !list.checked.contains(&address(server)))
                .collect();
            if replace {
                list.servers
                    .retain(|server| list.checked.contains(&address(server)));
            } else {
                let replaced: HashSet<_> = incoming.iter().map(address).collect();
                list.servers
                    .retain(|server| !replaced.contains(&address(server)));
            }
            list.servers.extend(incoming);
        })
    }

    fn update_list<R>(
        &self,
        ticket: ListTicket,
        change: impl FnOnce(&mut List) -> R,
    ) -> Result<Option<R>, String> {
        let mut list = self.lock()?;
        if list.generation != ticket.generation || list.game.is_some_and(|game| game != ticket.game)
        {
            return Ok(None);
        }
        list.game = Some(ticket.game);
        Ok(Some(change(&mut list)))
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
            .update_sweep(sweep, vec![server("10.0.0.1")], false)
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
    fn a_background_sweep_keeps_the_current_servers_and_check_tickets() {
        let listing = Listing::default();
        let first = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        listing
            .update_sweep(first, vec![server("10.0.0.1")], true)
            .expect("list");
        let check = listing.ticket(TargetGame::AlliedAssault).expect("ticket");
        listing
            .begin_background_sweep(TargetGame::AlliedAssault)
            .expect("background sweep");
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_ok()
        );
        assert!(
            listing
                .update_checked(
                    check,
                    ["10.0.0.2:12203".parse().expect("address")],
                    |servers| servers.push(server("10.0.0.2"))
                )
                .expect("check")
                .is_some()
        );
        assert!(
            listing
                .find("10.0.0.2:12203", TargetGame::AlliedAssault)
                .is_ok()
        );
    }

    #[test]
    fn partial_background_results_keep_servers_not_yet_probed_joinable() {
        let listing = Listing::default();
        let first = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        listing
            .update_sweep(first, vec![server("10.0.0.1"), server("10.0.0.2")], true)
            .expect("list");
        let behind = listing
            .begin_background_sweep(TargetGame::AlliedAssault)
            .expect("background sweep");
        listing
            .update_sweep(behind, vec![server("10.0.0.2")], false)
            .expect("partial results");
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_ok()
        );
        assert!(
            listing
                .find("10.0.0.2:12203", TargetGame::AlliedAssault)
                .is_ok()
        );
    }

    #[test]
    fn a_join_target_survives_a_background_sweep_that_misses_it() {
        let listing = Listing::default();
        let first = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        listing
            .update_sweep(first, vec![server("10.0.0.1"), server("10.0.0.2")], true)
            .expect("list");
        let background = listing
            .begin_background_sweep(TargetGame::AlliedAssault)
            .expect("background sweep");
        let (target, ownership) = listing
            .find_for_join("10.0.0.1:12203", TargetGame::AlliedAssault)
            .expect("join target");
        listing
            .update_sweep(background, Vec::new(), true)
            .expect("missed targets");
        drop(ownership);

        assert_eq!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .expect("target remains joinable")
                .hostname,
            target.hostname
        );
        assert!(
            listing
                .find("10.0.0.2:12203", TargetGame::AlliedAssault)
                .is_err()
        );
        let next = listing
            .begin_background_sweep(TargetGame::AlliedAssault)
            .expect("next refresh");
        listing
            .update_sweep(next, Vec::new(), true)
            .expect("refresh");
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_err()
        );
    }

    #[test]
    fn a_join_started_before_a_refresh_keeps_its_original_server() {
        let listing = Listing::default();
        let first = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        listing
            .update_sweep(first, vec![server("10.0.0.1")], true)
            .expect("list");
        let (target, ownership) = listing
            .find_for_join("10.0.0.1:12203", TargetGame::AlliedAssault)
            .expect("join target");
        let (_, overlapping) = listing
            .find_for_join("10.0.0.1:12203", TargetGame::AlliedAssault)
            .expect("overlapping join");
        drop(ownership);
        let background = listing
            .begin_background_sweep(TargetGame::AlliedAssault)
            .expect("background sweep");
        drop(overlapping);
        let mut changed = server("10.0.0.1");
        changed.hostname = "sweep answer".to_owned();
        listing
            .update_sweep(background, vec![changed], false)
            .expect("partial results");
        listing
            .update_sweep(background, Vec::new(), true)
            .expect("final results");
        assert_eq!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .expect("joinable")
                .hostname,
            target.hostname
        );
    }

    #[test]
    fn a_retired_join_cannot_release_ownership_in_a_new_list() {
        let listing = Listing::default();
        let first = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        listing
            .update_sweep(first, vec![server("10.0.0.1")], true)
            .expect("list");
        let (_, retired) = listing
            .find_for_join("10.0.0.1:12203", TargetGame::AlliedAssault)
            .expect("join");
        let new = listing
            .begin_sweep(TargetGame::Spearhead)
            .expect("new game");
        assert!(
            listing
                .find_for_join("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_err()
        );
        listing
            .update_sweep(new, vec![server("10.0.0.1")], true)
            .expect("new list");
        let (_, current) = listing
            .find_for_join("10.0.0.1:12203", TargetGame::Spearhead)
            .expect("new join");
        drop(retired);
        let background = listing
            .begin_background_sweep(TargetGame::Spearhead)
            .expect("refresh");
        listing
            .update_sweep(background, Vec::new(), true)
            .expect("results");
        drop(current);
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::Spearhead)
                .is_ok()
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
            .update_sweep(old, vec![server("10.0.0.1")], true)
            .expect("update");
        listing
            .update_sweep(new, vec![server("10.0.0.2")], false)
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
