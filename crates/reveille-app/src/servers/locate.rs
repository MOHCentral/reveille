// SPDX-License-Identifier: GPL-3.0-only

use reveille_core::discovery::{self, Located, ServerReference, TargetGame};
use serde::Serialize;
use tracing::info;

use super::PROBE_TIMEOUT;

/// A server found from an address the player typed, in the shape the shell's `openServer` takes.
#[derive(Debug, PartialEq, Serialize)]
pub struct LocatedServer {
    /// The game address, the one a join connects to.
    address: String,
    query_port: u16,
    /// `None` when the server does not say; the shell then asks under the current game.
    game: Option<TargetGame>,
    hostname: Option<String>,
}

/// Read an address the player typed or pasted and find the server behind it.
///
/// The server is not added to the list here: the shell's `openServer` checks it with
/// `check_server`, the same way it opens a server from an alert.
#[tauri::command]
pub async fn locate_server(address: String) -> Result<LocatedServer, String> {
    let reference = ServerReference::parse(&address).map_err(|error| error.to_string())?;
    let target = reference
        .resolve()
        .await
        .map_err(|error| error.to_string())?;
    info!(%target, "locating a server by address");
    found(
        &target.to_string(),
        discovery::locate(target, PROBE_TIMEOUT).await,
    )
}

fn found(address: &str, located: Located) -> Result<LocatedServer, String> {
    match located {
        Located::Found {
            endpoint,
            game,
            hostname,
        } => Ok(LocatedServer {
            address: address.to_owned(),
            query_port: endpoint.query_port.get(),
            game,
            hostname,
        }),
        Located::NoQueryPort => Err(format!(
            "{address} answered, but Reveille could not read its details, so it cannot show it \
             in the list. You can still join from the game's console with: connect {address}"
        )),
        Located::Silent => Err(format!(
            "Nothing answered at {address}. The server may be off or restarting, or the address \
             may be wrong."
        )),
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use reveille_core::discovery::{MasterEndpoint, QueryPort};

    use super::*;

    #[test]
    fn a_found_server_carries_its_game_address_and_query_port() {
        let located = Located::Found {
            endpoint: MasterEndpoint {
                address: Ipv4Addr::new(203, 0, 113, 4),
                query_port: QueryPort::new(12_301),
            },
            game: Some(TargetGame::Breakthrough),
            hostname: Some("Friday Night".to_owned()),
        };
        assert_eq!(
            found("203.0.113.4:12204", located),
            Ok(LocatedServer {
                address: "203.0.113.4:12204".to_owned(),
                query_port: 12_301,
                game: Some(TargetGame::Breakthrough),
                hostname: Some("Friday Night".to_owned()),
            })
        );
    }

    #[test]
    fn a_server_reveille_cannot_read_still_leaves_the_console_route() {
        let error = found("203.0.113.4:12204", Located::NoQueryPort).expect_err("unreadable");
        assert!(error.ends_with("connect 203.0.113.4:12204"), "{error}");
        let error = found("203.0.113.4:12204", Located::Silent).expect_err("silent");
        assert!(
            error.starts_with("Nothing answered at 203.0.113.4:12204."),
            "{error}"
        );
    }
}
