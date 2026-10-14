// SPDX-License-Identifier: GPL-3.0-only

//! Sweeps against a loopback master that misbehaves the way the community master can.

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use reveille_core::discovery::{
    BrowseConfig, DiscoveryError, MasterAddress, MasterEndpoint, QueryPort, RequestError, browse,
    browse_streaming_remembering,
};
use reveille_core::retry::RetryPolicy;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::{TcpListener, UdpSocket};
use tokio::sync::mpsc;

const INSTANT: RetryPolicy = RetryPolicy::new(&[Duration::ZERO, Duration::ZERO]);

/// What the master does with one connection.
#[derive(Clone, Copy)]
enum Greeting {
    /// Accept, then close before saying anything.
    HangUp,
    /// Run the `GameSpy` exchange and list `query_port` on loopback.
    List { query_port: u16 },
}

async fn master(greetings: Vec<Greeting>) -> (MasterAddress, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("master");
    let port = listener.local_addr().expect("address").port();
    let connections = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&connections);
    tokio::spawn(async move {
        for greeting in greetings {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            counted.fetch_add(1, Ordering::SeqCst);
            match greeting {
                Greeting::HangUp => drop(stream),
                Greeting::List { query_port } => {
                    let _ = stream.write_all(b"\\basic\\\\secure\\ABCDEF\\").await;
                    let mut query = [0_u8; 512];
                    let _ = stream.read(&mut query).await;
                    let mut list = Ipv4Addr::LOCALHOST.octets().to_vec();
                    list.extend_from_slice(&query_port.to_be_bytes());
                    list.extend_from_slice(b"\\final\\");
                    let _ = stream.write_all(&list).await;
                }
            }
        }
    });
    (
        MasterAddress {
            host: "127.0.0.1",
            port,
        },
        connections,
    )
}

/// A master that hangs up on every attempt the policy allows. Not a closed port: Windows takes
/// about two seconds to report a refused loopback connection, which races the master deadline.
async fn down() -> (MasterAddress, Arc<AtomicUsize>) {
    master(vec![Greeting::HangUp; INSTANT.attempts()]).await
}

/// A UDP port that is bound but never answers, standing in for a server that went offline.
async fn silent_server() -> (UdpSocket, MasterEndpoint) {
    let socket = UdpSocket::bind("127.0.0.1:0").await.expect("server");
    let port = socket.local_addr().expect("address").port();
    (
        socket,
        MasterEndpoint {
            address: Ipv4Addr::LOCALHOST,
            query_port: QueryPort::new(port),
        },
    )
}

fn config(master: MasterAddress) -> BrowseConfig {
    BrowseConfig {
        master,
        master_retry: INSTANT,
        master_timeout: Duration::from_secs(2),
        probe_timeout: Duration::from_millis(100),
        ..BrowseConfig::default()
    }
}

#[tokio::test]
async fn a_master_that_hangs_up_once_is_asked_again() {
    let (_server, endpoint) = silent_server().await;
    let (address, connections) = master(vec![
        Greeting::HangUp,
        Greeting::List {
            query_port: endpoint.query_port.get(),
        },
    ])
    .await;

    let report = browse(config(address))
        .await
        .expect("second exchange lists");

    assert_eq!(connections.load(Ordering::SeqCst), 2);
    assert_eq!(report.registered, 1);
    assert_eq!(report.master_unavailable, None);
}

#[tokio::test]
async fn an_unreachable_master_falls_back_to_the_remembered_registrations() {
    let (_server, endpoint) = silent_server().await;
    let (sink, mut events) = mpsc::channel(8);
    let drain = tokio::spawn(async move { while events.recv().await.is_some() {} });

    let (address, connections) = down().await;
    let report = browse_streaming_remembering(config(address), &[endpoint], sink)
        .await
        .expect("remembered servers are probed");
    drain.await.expect("drained");

    assert_eq!(connections.load(Ordering::SeqCst), INSTANT.attempts());
    assert!(report.master_unavailable.is_some());
    assert_eq!(report.registered, 1);
    assert_eq!(report.outcomes.len(), 1);
    assert_eq!(report.outcomes[0].endpoint, endpoint);
    // Probed live: a silent server is reported offline, not listed from memory.
    assert!(report.outcomes[0].server.is_none());
}

#[tokio::test]
async fn an_unreachable_master_with_nothing_remembered_still_fails() {
    let (sink, _events) = mpsc::channel(8);
    let (address, connections) = down().await;
    let error = browse_streaming_remembering(config(address), &[], sink)
        .await
        .expect_err("nothing to fall back on");

    assert_eq!(connections.load(Ordering::SeqCst), INSTANT.attempts());
    // A hang-up reads as an empty greeting, or as a reset where the platform sends one.
    assert!(matches!(
        error,
        DiscoveryError::Master {
            source: RequestError::EmptyMasterGreeting | RequestError::Network(_),
            ..
        }
    ));
}
