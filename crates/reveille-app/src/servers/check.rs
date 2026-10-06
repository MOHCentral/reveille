// SPDX-License-Identifier: GPL-3.0-only

use std::net::SocketAddrV4;

use reveille_core::discovery::{self, MasterEndpoint, ProbeOutcome, QueryPort, Server, TargetGame};
use reveille_core::mapindex::MapIndex;
use serde::Serialize;
use tracing::info;

use super::browse::{NonResultGroup, group_non_results};
use super::{BrowserServer, ListTicket, Listing, PROBE_TIMEOUT, classified};
use crate::session::{Session, installed_maps};

/// What checking one remembered server found.
///
/// Never an error and never an empty success: either the server answered and is now joinable, or
/// the reason it did not is recorded.
#[derive(Serialize)]
pub struct CheckResult {
    row: Option<BrowserServer>,
    non_result: Option<NonResultGroup>,
    /// The server answered, but for another of the three games.
    other_game: Option<TargetGame>,
}

/// Check one remembered server directly, with no master list involved.
///
/// A favorite is often not in the current sweep — the master never registered it, or it did not
/// answer in time. Without this the bookmark would be a dead row: `install_and_launch` resolves
/// its target out of the sweep's list, so a server missing from that list cannot be joined at all.
/// A server that answers here is merged into the same list and becomes joinable like any other.
#[tauri::command]
pub async fn check_server(
    session: Session,
    address: String,
    query_port: u16,
    state: tauri::State<'_, Listing>,
) -> Result<CheckResult, String> {
    info!(%address, query_port, game = ?session.game, "checking saved server");
    let address = address
        .parse::<SocketAddrV4>()
        .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
    // Taken before anything is awaited: a sweep that starts while the probe is out replaces the
    // list this check was asked about.
    let ticket = state.ticket(session.game)?;
    let index = installed_maps(&session)?;
    let endpoint = MasterEndpoint {
        address: *address.ip(),
        query_port: QueryPort::new(query_port),
    };
    let outcome = discovery::inspect_endpoint(endpoint, PROBE_TIMEOUT).await;
    settle_check(&state, ticket, &index, address, outcome)
}

/// Record what a check found in the list it was asked about, if that list is still current.
fn settle_check(
    listing: &Listing,
    ticket: ListTicket,
    index: &MapIndex,
    address: SocketAddrV4,
    outcome: ProbeOutcome,
) -> Result<CheckResult, String> {
    let Some(server) = outcome.server else {
        // Not an error. Why it did not answer is what the player asked for.
        //
        // The entry goes with it. This list is what `Listing::find` prepares a join from, and a
        // check that ran and got no answer is evidence about now that outranks whatever the sweep
        // saw — the same reason the shell drops the row. Leaving it would keep a join preparable
        // from figures the interface has already withdrawn.
        settle(listing.update(ticket, |servers| {
            forget_checked_server(servers, address);
        })?);
        return Ok(CheckResult {
            row: None,
            non_result: outcome
                .non_result
                .as_ref()
                .and_then(|non_result| group_non_results(std::iter::once(non_result)).pop()),
            other_game: None,
        });
    };
    if let Some(published) = server.answered_for_another_game(ticket.game) {
        info!(published_game = ?published, "checked server answered for another game");
        // It answered, for a game this session's client cannot join. Not a joinable entry either.
        settle(listing.update(ticket, |servers| {
            forget_checked_server(servers, address);
        })?);
        return Ok(CheckResult {
            row: None,
            non_result: None,
            other_game: Some(published),
        });
    }
    // The server publishes its own `hostport`, so a server that moved answers at an address other
    // than the remembered one. The row carries the address it actually answered at; repointing the
    // bookmark at it would be a guess about whether it is the same server.
    let row = classified(&server, index);
    if settle(listing.update(ticket, |servers| merge_checked_server(servers, server))?) {
        info!("checked server answered and was merged into active list");
    }
    Ok(CheckResult {
        row: Some(row),
        non_result: None,
        other_game: None,
    })
}

/// Whether a check's change landed. One that outlived its list still reports what it found; the
/// shell discards that answer for the same reason.
fn settle(applied: Option<()>) -> bool {
    if applied.is_none() {
        info!("the server list was replaced while the check ran; it was left as it is");
    }
    applied.is_some()
}

/// Merge a freshly checked server into the current list, replacing any entry for the same game
/// endpoint.
///
/// Appending would leave `Listing::find` resolving whichever copy it reached first, so a join could
/// be prepared from figures this check has already superseded.
fn merge_checked_server(servers: &mut Vec<Server>, server: Server) {
    let endpoint = (server.endpoint.address, server.game_port);
    servers.retain(|existing| (existing.endpoint.address, existing.game_port) != endpoint);
    servers.push(server);
}

/// Drop the entry for a game endpoint a check has just found nothing at.
///
/// Deliberately keyed on the game address the check was asked about, not on the query port: the
/// caller asked about one join target and learned that it is not there.
fn forget_checked_server(servers: &mut Vec<Server>, address: SocketAddrV4) {
    servers.retain(|existing| {
        (existing.endpoint.address, existing.game_port.get()) != (*address.ip(), address.port())
    });
}

#[cfg(test)]
mod tests {
    use reveille_core::discovery::{MasterEndpoint, ProbeOutcome, QueryPort, Server, TargetGame};
    use reveille_core::mapindex::MapIndex;

    use super::{merge_checked_server, settle_check};
    use crate::servers::Listing;

    /// The minimum of a `Server` this test needs: the two fields that identify a game endpoint,
    /// plus a hostname to tell two answers apart.
    fn probed(address: &str, query_port: u16, game_port: u16, hostname: &str) -> Server {
        Server {
            endpoint: MasterEndpoint {
                address: address.parse().expect("address"),
                query_port: QueryPort::new(query_port),
            },
            game_port: reveille_core::discovery::GamePort::new(game_port),
            hostname: hostname.to_owned(),
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
            occupancy: reveille_core::discovery::ReportedOccupancy::default(),
            client_capacity: None,
            players: Vec::new(),
            pure: None,
            status_round_trip: reveille_core::discovery::RoundTripMillis::new(12),
        }
    }

    #[test]
    fn checking_a_server_replaces_its_entry_rather_than_adding_a_second() {
        let mut servers = vec![
            probed("10.0.0.1", 12300, 12203, "stale"),
            probed("10.0.0.2", 12300, 12203, "another server"),
        ];

        merge_checked_server(&mut servers, probed("10.0.0.1", 12300, 12203, "fresh"));

        assert_eq!(servers.len(), 2);
        // `Listing::find` takes the first match, so a stale copy left behind would be the one a
        // join is prepared from.
        assert!(servers.iter().all(|server| server.hostname != "stale"));
        assert!(servers.iter().any(|server| server.hostname == "fresh"));
        assert!(
            servers
                .iter()
                .any(|server| server.hostname == "another server")
        );
    }

    #[test]
    fn a_server_reregistered_under_a_new_query_port_leaves_no_duplicate_game_endpoint() {
        // The master can hand out a different query port for the same server. Identity is the
        // game endpoint, because that is what a join connects to.
        let mut servers = vec![probed("10.0.0.1", 12300, 12203, "stale")];

        merge_checked_server(&mut servers, probed("10.0.0.1", 12400, 12203, "fresh"));

        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].hostname, "fresh");
    }

    #[test]
    fn a_server_that_moved_to_another_game_port_is_kept_alongside_the_old_entry() {
        // Different game endpoint, so it is a different join target. Collapsing the two would be
        // a guess that the server merely moved rather than that a second one exists.
        let mut servers = vec![probed("10.0.0.1", 12300, 12203, "old port")];

        merge_checked_server(&mut servers, probed("10.0.0.1", 12300, 12204, "new port"));

        assert_eq!(servers.len(), 2);
    }

    fn answered(server: Server) -> ProbeOutcome {
        ProbeOutcome {
            endpoint: server.endpoint,
            gamespy_reachable: true,
            server: Some(server),
            non_result: None,
        }
    }

    #[test]
    fn a_check_delayed_across_a_game_switch_leaves_the_new_list_alone() {
        let listing = Listing::default();
        listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        // The probe goes out while Allied Assault is listed...
        let ticket = listing.ticket(TargetGame::AlliedAssault).expect("ticket");
        // ...and the player switches to Spearhead before it answers.
        let spearhead = listing.begin_sweep(TargetGame::Spearhead).expect("sweep");
        listing
            .update(spearhead, |servers| {
                servers.push(probed("10.0.0.2", 12300, 12203, "a Spearhead server"));
            })
            .expect("update");

        let result = settle_check(
            &listing,
            ticket,
            &MapIndex::default(),
            "10.0.0.1:12203".parse().expect("address"),
            answered(probed("10.0.0.1", 12300, 12203, "an Allied Assault server")),
        )
        .expect("check");

        // The answer is still reported; the shell drops it by its own generation.
        assert!(result.row.is_some());
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::Spearhead)
                .is_err()
        );
        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_err()
        );
        assert!(
            listing
                .find("10.0.0.2:12203", TargetGame::Spearhead)
                .is_ok()
        );
    }

    #[test]
    fn an_unanswered_check_delayed_across_a_sweep_does_not_drop_the_new_entry() {
        let listing = Listing::default();
        let ticket = listing.ticket(TargetGame::AlliedAssault).expect("ticket");
        let sweep = listing
            .begin_sweep(TargetGame::AlliedAssault)
            .expect("sweep");
        listing
            .update(sweep, |servers| {
                servers.push(probed("10.0.0.1", 12300, 12203, "answered the sweep"));
            })
            .expect("update");

        settle_check(
            &listing,
            ticket,
            &MapIndex::default(),
            "10.0.0.1:12203".parse().expect("address"),
            ProbeOutcome {
                endpoint: MasterEndpoint {
                    address: "10.0.0.1".parse().expect("address"),
                    query_port: QueryPort::new(12300),
                },
                gamespy_reachable: false,
                server: None,
                non_result: None,
            },
        )
        .expect("check");

        assert!(
            listing
                .find("10.0.0.1:12203", TargetGame::AlliedAssault)
                .is_ok()
        );
    }

    #[test]
    fn a_check_on_the_current_list_is_joinable() {
        let listing = Listing::default();
        listing.begin_sweep(TargetGame::Spearhead).expect("sweep");
        let ticket = listing.ticket(TargetGame::Spearhead).expect("ticket");

        settle_check(
            &listing,
            ticket,
            &MapIndex::default(),
            "10.0.0.1:12203".parse().expect("address"),
            answered(probed("10.0.0.1", 12300, 12203, "a favourite")),
        )
        .expect("check");

        assert_eq!(
            listing
                .find("10.0.0.1:12203", TargetGame::Spearhead)
                .expect("joinable")
                .hostname,
            "a favourite"
        );
    }
}
