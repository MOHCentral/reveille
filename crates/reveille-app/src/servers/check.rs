// SPDX-License-Identifier: GPL-3.0-only

use std::net::SocketAddrV4;

use reveille_core::discovery::{self, MasterEndpoint, QueryPort, Server, TargetGame};
use serde::Serialize;
use tracing::info;

use super::browse::{NonResultGroup, group_non_results};
use super::{BrowserServer, Listing, PROBE_TIMEOUT, classified};
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
    let index = installed_maps(&session)?;
    let endpoint = MasterEndpoint {
        address: *address.ip(),
        query_port: QueryPort::new(query_port),
    };
    let outcome = discovery::inspect_endpoint(endpoint, PROBE_TIMEOUT).await;

    let Some(server) = outcome.server else {
        // Not an error. Why it did not answer is what the player asked for.
        //
        // The entry goes with it. This list is what `Listing::find` prepares a join from, and a
        // check that ran and got no answer is evidence about now that outranks whatever the sweep
        // saw — the same reason the shell drops the row. Leaving it would keep a join preparable
        // from figures the interface has already withdrawn.
        forget_checked_server(&state, address)?;
        return Ok(CheckResult {
            row: None,
            non_result: outcome
                .non_result
                .as_ref()
                .and_then(|non_result| group_non_results(std::iter::once(non_result)).pop()),
            other_game: None,
        });
    };
    if let Some(published) = answered_for_another_game(&server, session.game) {
        info!(published_game = ?published, "checked server answered for another game");
        // It answered, for a game this session's client cannot join. Not a joinable entry either.
        forget_checked_server(&state, address)?;
        return Ok(CheckResult {
            row: None,
            non_result: None,
            other_game: Some(published),
        });
    }
    // The server publishes its own `hostport`, so a server that moved answers at an address other
    // than the remembered one. The row carries the address it actually answered at; repointing the
    // bookmark at it would be a guess about whether it is the same server.
    let row = classified(&server, &index);
    let mut servers = state
        .servers
        .lock()
        .map_err(|_| "server list state is unavailable".to_owned())?;
    merge_checked_server(&mut servers, server);
    drop(servers);
    info!("checked server answered and was merged into active list");
    Ok(CheckResult {
        row: Some(row),
        non_result: None,
        other_game: None,
    })
}

/// The family a checked server belongs to, when it is not this session's.
///
/// A bookmark is an address, so it outlives the game it was starred under. A server that answers
/// for another family is real and reachable and still cannot be joined from this session: the
/// client this session launches speaks a different protocol and would be dropped at connect. A
/// server that publishes no family at all is not guessed about — it is listed, exactly as the
/// sweep would have listed it.
pub fn answered_for_another_game(server: &Server, game: TargetGame) -> Option<TargetGame> {
    server
        .game_name
        .as_deref()
        .and_then(TargetGame::from_game_name)
        .filter(|published| *published != game)
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
fn forget_checked_server(
    state: &tauri::State<'_, Listing>,
    address: SocketAddrV4,
) -> Result<(), String> {
    let mut servers = state
        .servers
        .lock()
        .map_err(|_| "server list state is unavailable".to_owned())?;
    servers.retain(|existing| {
        (existing.endpoint.address, existing.game_port.get()) != (*address.ip(), address.port())
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use reveille_core::discovery::{MasterEndpoint, QueryPort, Server, TargetGame};

    use super::{answered_for_another_game, merge_checked_server};

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
    fn a_checked_server_from_another_game_is_named_rather_than_listed() {
        let mut server = probed("10.0.0.1", 12300, 12203, "a Spearhead server");
        server.game_name = Some("mohaas".to_owned());

        // Browsing Spearhead, this is an ordinary row.
        assert_eq!(
            answered_for_another_game(&server, TargetGame::Spearhead),
            None
        );
        // Browsing Allied Assault, it answered — for something this session cannot join.
        assert_eq!(
            answered_for_another_game(&server, TargetGame::AlliedAssault),
            Some(TargetGame::Spearhead)
        );

        // A server that publishes no family is not guessed about. The sweep would have listed it,
        // and so does a check.
        server.game_name = None;
        assert_eq!(
            answered_for_another_game(&server, TargetGame::AlliedAssault),
            None
        );
        // Neither is one whose family is not a MOHAA family at all.
        server.game_name = Some("quake3".to_owned());
        assert_eq!(
            answered_for_another_game(&server, TargetGame::AlliedAssault),
            None
        );
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
}
