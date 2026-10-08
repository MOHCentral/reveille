// SPDX-License-Identifier: GPL-3.0-only

//! One server's remote console: a request, its possibly split reply, and the pace between them.

use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::Duration;

use thiserror::Error;
use tokio::net::UdpSocket;
use tokio::sync::Mutex;
use tokio::time::{Instant, sleep_until, timeout_at};
use zeroize::Zeroizing;

use super::command::{RconAction, RconPassword};
use super::reply::{RconStatus, ReplyError, parse_print_packet, parse_status, reply_outcome};
use crate::discovery::OOB_SEND_HEADER;

/// Time between two requests to one server. `OpenMoHAA` drops more than ten a second from one
/// address (`sv_main.c:685`); the original Quake III server drops a request within 180 ms of the
/// last one, or 500 ms after a wrong password, and a dropped request reads as a dead server.
const SPACING: Duration = Duration::from_millis(500);
/// How long the first packet of a reply may take. The server answers once the command has run.
const FIRST_REPLY: Duration = Duration::from_secs(3);
/// The same, for a command that loads a map before it returns.
const FIRST_REPLY_AFTER_LOAD: Duration = Duration::from_secs(20);
/// Silence after which a reply is complete. Output longer than one buffer arrives as several
/// `print` packets sent back to back (`sv_main.c:680`), and nothing marks the last one.
const QUIET_GAP: Duration = Duration::from_millis(300);
/// Longest a reply may keep arriving after its first packet was due.
const MAX_TRICKLE: Duration = Duration::from_secs(5);
/// Most console output read for one request. `status` on a full server is a few kilobytes.
const MAX_REPLY: usize = 64 * 1024;
const MAX_UDP_PACKET: usize = 65_535;

/// Why a request got no usable answer.
#[derive(Debug, Error)]
pub enum RconError {
    /// Nothing came back in time.
    #[error("the server did not answer")]
    Timeout,
    /// The socket failed.
    #[error("network request failed")]
    Network(#[source] io::Error),
    /// The server answered, but refused the request.
    #[error(transparent)]
    Reply(#[from] ReplyError),
    /// The reply went on past the size Reveille reads.
    #[error("the server's reply was longer than {MAX_REPLY} bytes")]
    TooLarge,
}

/// The remote console of one server.
///
/// Requests to it are serialised: the lock is held for the whole exchange and the pause after it,
/// so a status poll and a click never race each other into the server's rate limit.
pub struct RconClient {
    address: SocketAddrV4,
    password: RconPassword,
    last: Mutex<Option<Instant>>,
}

impl RconClient {
    /// A console for the server at `address`, its game port.
    #[must_use]
    pub fn new(address: SocketAddrV4, password: RconPassword) -> Self {
        Self {
            address,
            password,
            last: Mutex::new(None),
        }
    }

    /// The server's game address.
    #[must_use]
    pub const fn address(&self) -> SocketAddrV4 {
        self.address
    }

    /// The password, for the credential store once the server has accepted it.
    #[must_use]
    pub const fn password(&self) -> &RconPassword {
        &self.password
    }

    /// Run `action`, returning what the console printed for each of its lines.
    ///
    /// # Errors
    ///
    /// Stops at the first line that times out, fails or is refused.
    pub async fn run(&self, action: &RconAction) -> Result<String, RconError> {
        let wait = if action.waits_on_map_load() {
            FIRST_REPLY_AFTER_LOAD
        } else {
            FIRST_REPLY
        };
        let mut output = String::new();
        for line in action.command_lines() {
            output.push_str(&self.exchange(&line, wait).await?);
        }
        Ok(output)
    }

    /// The map and clients as `status` lists them.
    ///
    /// # Errors
    ///
    /// As [`RconClient::run`].
    pub async fn status(&self) -> Result<RconStatus, RconError> {
        Ok(parse_status(&self.run(&RconAction::Status).await?))
    }

    async fn exchange(&self, line: &str, wait: Duration) -> Result<String, RconError> {
        let mut last = self.last.lock().await;
        if let Some(previous) = *last {
            sleep_until(previous + SPACING).await;
        }
        let result = self.send(line, wait).await;
        *last = Some(Instant::now());
        result
    }

    async fn send(&self, line: &str, wait: Duration) -> Result<String, RconError> {
        let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0))
            .await
            .map_err(RconError::Network)?;
        socket
            .connect(SocketAddr::V4(self.address))
            .await
            .map_err(RconError::Network)?;
        // `rcon <password> <command>`; the server takes the command as the rest of the line
        // after the password (`sv_main.c:720`), so the command is never re-quoted.
        let mut request = Zeroizing::new(Vec::from(OOB_SEND_HEADER));
        request.extend_from_slice(b"rcon ");
        request.extend_from_slice(self.password.expose().as_bytes());
        request.push(b' ');
        request.extend_from_slice(line.as_bytes());
        socket.send(&request).await.map_err(RconError::Network)?;

        let mut buffer = vec![0_u8; MAX_UDP_PACKET];
        let mut text = String::new();
        let mut answered = false;
        let mut deadline = Instant::now() + wait;
        // However the reply trickles in, reading it ends here.
        let end = deadline + MAX_TRICKLE;
        loop {
            let length = match timeout_at(deadline, socket.recv(&mut buffer)).await {
                Ok(received) => received.map_err(RconError::Network)?,
                Err(_) if answered => break,
                Err(_) => return Err(RconError::Timeout),
            };
            // Anything but console output is not part of this reply, and does not extend it.
            let Ok(chunk) = parse_print_packet(&buffer[..length]) else {
                continue;
            };
            text.push_str(&chunk);
            if text.len() > MAX_REPLY {
                return Err(RconError::TooLarge);
            }
            answered = true;
            deadline = (Instant::now() + QUIET_GAP).min(end);
        }
        reply_outcome(&text)?;
        Ok(text)
    }
}
