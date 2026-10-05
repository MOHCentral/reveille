// SPDX-License-Identifier: GPL-3.0-only

pub mod browse;
pub mod check;
pub mod failure;

use std::net::SocketAddrV4;
use std::sync::Mutex;
use std::time::Duration;

use reveille_core::discovery::Server;
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
    servers: Mutex<Vec<Server>>,
    /// Raised to stop an in-flight sweep.
    cancel: Notify,
}

impl Listing {
    pub fn find(&self, address: &str) -> Result<Server, String> {
        let address = address
            .parse::<SocketAddrV4>()
            .map_err(|error| format!("Reveille could not read the address {address}: {error}"))?;
        self.servers
            .lock()
            .map_err(|_| "server list state is unavailable".to_owned())?
            .iter()
            .find(|server| {
                SocketAddrV4::new(server.endpoint.address, server.game_port.get()) == address
            })
            .cloned()
            .ok_or_else(|| {
                "This server is no longer in the current list. Refresh and try again.".to_owned()
            })
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
