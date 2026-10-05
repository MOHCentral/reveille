// SPDX-License-Identifier: GPL-3.0-only

use std::net::SocketAddrV4;

use reveille_core::discovery::{self, MasterEndpoint, QueryPort, TargetGame};
use reveille_platform as platform;
use serde::Serialize;

use crate::servers::PROBE_TIMEOUT;
use crate::servers::check::answered_for_another_game;

/// Whether a game client is running now; null when the process list cannot be read.
#[tauri::command]
pub async fn game_client_running() -> Option<bool> {
    tokio::task::spawn_blocking(platform::game_client_running)
        .await
        .ok()
        .flatten()
}

/// What one probe of a watched server saw: enough to decide an alert and to word its toast.
#[derive(Serialize)]
pub struct WatchReading {
    clients: Option<u32>,
    bots: Option<u32>,
    map: Option<String>,
    mode: Option<String>,
    round_trip: u32,
}

/// Read a watched endpoint's occupancy and current round. Unlike `check_server`, this does not
/// index maps or alter the browse list behind a pending join.
#[tauri::command]
pub async fn read_watched_server(
    address: String,
    query_port: u16,
    game: TargetGame,
) -> Option<WatchReading> {
    let address = address.parse::<SocketAddrV4>().ok()?;
    if query_port == 0 {
        return None;
    }
    let endpoint = MasterEndpoint {
        address: *address.ip(),
        query_port: QueryPort::new(query_port),
    };
    let server = discovery::inspect_endpoint(endpoint, PROBE_TIMEOUT)
        .await
        .server?;
    if answered_for_another_game(&server, game).is_some()
        || SocketAddrV4::new(server.endpoint.address, server.game_port.get()) != address
    {
        return None;
    }
    Some(WatchReading {
        clients: server
            .occupancy
            .clients_reported
            .map(discovery::ClientsReported::get),
        bots: server
            .occupancy
            .bots_reported
            .map(discovery::BotsReported::get),
        map: server.current_map,
        mode: server.game_type,
        round_trip: server.status_round_trip.get(),
    })
}
