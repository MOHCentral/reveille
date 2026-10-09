// SPDX-License-Identifier: GPL-3.0-only

//! The remote console against a loopback stand-in for a server: split replies, a refused password,
//! silence, and the pace between requests.
//!
//! The `status` fixtures are laid out by the format strings of each engine's `SV_Status_f`
//! (`OpenMoHAA`'s `sv_ccmds.c:1217`, and Quake III 1.32's, which the original servers inherit). They
//! were not captured from a live server: Reveille holds no server's password to capture one with.

use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::time::{Duration, Instant};

use reveille_core::rcon::{
    ChatText, ClientSlot, RconAction, RconClient, RconError, RconPassword, ReplyError, parse_status,
};
use tokio::net::UdpSocket;
use tokio::task::JoinHandle;

const OPENMOHAA_STATUS: &str = include_str!("fixtures/rcon_status_openmohaa.txt");
const QUAKE3_STATUS: &str = include_str!("fixtures/rcon_status_quake3.txt");
const PASSWORD: &str = "s3cret!";

/// How the stand-in answers one request: each entry is one `print` packet, sent back to back.
type Script = fn(&str) -> Vec<String>;

/// A server on loopback that answers every request with `script`, returning what it was sent.
async fn server(script: Script) -> (SocketAddrV4, JoinHandle<Vec<(Vec<u8>, Instant)>>) {
    let socket = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind");
    let SocketAddr::V4(address) = socket.local_addr().expect("address") else {
        unreachable!("bound to IPv4")
    };
    let task = tokio::spawn(async move {
        let mut received = Vec::new();
        let mut buffer = [0_u8; 2048];
        while let Ok(Ok((length, from))) =
            tokio::time::timeout(Duration::from_secs(3), socket.recv_from(&mut buffer)).await
        {
            let request = buffer[..length].to_vec();
            received.push((request.clone(), Instant::now()));
            let line = String::from_utf8_lossy(&request[5..]).into_owned();
            for chunk in script(&line) {
                let mut packet = vec![0xff, 0xff, 0xff, 0xff, 0x01];
                packet.extend_from_slice(b"print\n");
                packet.extend_from_slice(chunk.as_bytes());
                socket.send_to(&packet, from).await.expect("send");
            }
        }
        received
    });
    (address, task)
}

fn client(address: SocketAddrV4) -> RconClient {
    RconClient::new(
        address,
        RconPassword::new(PASSWORD.to_owned()).expect("valid"),
    )
}

/// Answers as `SVC_RemoteCommand` does: refused unless the second token is the password.
fn checked(line: &str, output: Vec<String>) -> Vec<String> {
    match line.split(' ').nth(1) {
        Some(PASSWORD) => output,
        _ => vec!["Bad rconpassword.\n".to_owned()],
    }
}

#[tokio::test]
async fn status_split_over_two_packets_reads_as_one_reply() {
    let (address, server) = server(|line| {
        let (first, second) = OPENMOHAA_STATUS.split_at(OPENMOHAA_STATUS.len() / 2);
        checked(line, vec![first.to_owned(), second.to_owned()])
    })
    .await;
    let status = client(address).status().await.expect("status");
    assert_eq!(status, parse_status(OPENMOHAA_STATUS));
    assert_eq!(status.map.as_deref(), Some("dm/mohdm6"));
    assert_eq!(status.players.len(), 5);
    let requests = server.await.expect("server");
    assert_eq!(
        requests[0].0,
        [b"\xff\xff\xff\xff\x02rcon s3cret! status".as_slice()].concat()
    );
}

#[tokio::test]
async fn both_status_layouts_list_the_same_players() {
    let opm = parse_status(OPENMOHAA_STATUS);
    let q3 = parse_status(QUAKE3_STATUS);
    assert_eq!(opm.players, q3.players);
    let connecting = &q3.players[3];
    assert_eq!(connecting.slot, ClientSlot::new(4));
    assert_eq!(connecting.name, "Unknown Soldier");
    assert_eq!(connecting.ping, None);
}

#[tokio::test]
async fn a_wrong_password_is_reported_as_such() {
    let (address, _server) = server(|_| vec!["Bad rconpassword.\n".to_owned()]).await;
    let error = client(address).status().await.expect_err("refused");
    assert!(
        matches!(error, RconError::Reply(ReplyError::BadPassword)),
        "{error:?}"
    );
}

#[tokio::test]
async fn a_server_without_rcon_says_so() {
    let (address, _server) =
        server(|_| vec!["No rconpassword set on the server.\n".to_owned()]).await;
    let error = client(address).status().await.expect_err("refused");
    assert!(
        matches!(error, RconError::Reply(ReplyError::NotEnabled)),
        "{error:?}"
    );
}

#[tokio::test]
async fn silence_is_a_timeout_not_an_empty_reply() {
    let (address, _server) = server(|_| Vec::new()).await;
    let started = Instant::now();
    let error = client(address).status().await.expect_err("silent");
    assert!(matches!(error, RconError::Timeout), "{error:?}");
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[tokio::test]
async fn a_ban_sends_two_requests_spaced_for_the_rate_limit() {
    let (address, server) = server(|line| checked(line, vec![format!("ran {line}\n")])).await;
    let console = client(address);
    let output = console
        .run(&RconAction::Ban(ClientSlot::new(2)))
        .await
        .expect("ban");
    assert!(
        output.contains("banaddr 2") && output.contains("clientkick 2"),
        "{output}"
    );
    let requests = server.await.expect("server");
    let lines: Vec<String> = requests
        .iter()
        .map(|(bytes, _)| String::from_utf8_lossy(&bytes[5..]).into_owned())
        .collect();
    assert_eq!(
        lines,
        ["rcon s3cret! banaddr 2", "rcon s3cret! clientkick 2"]
    );
    assert!(requests[1].1 - requests[0].1 >= Duration::from_millis(450));
}

#[tokio::test]
async fn a_chat_line_reaches_the_server_as_typed() {
    let (address, server) =
        server(|line| checked(line, vec!["console: hi there\n".to_owned()])).await;
    let text = ChatText::new("hi there").expect("valid");
    let output = client(address)
        .run(&RconAction::Say(text))
        .await
        .expect("say");
    assert_eq!(output, "console: hi there\n");
    let requests = server.await.expect("server");
    assert_eq!(&requests[0].0[5..], b"rcon s3cret! say hi there");
}
