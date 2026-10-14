// SPDX-License-Identifier: GPL-3.0-only

//! Downloads against a loopback host that fails the way real file hosts do.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use md5::{Digest, Md5};
use reveille_core::content::{
    FileSize, Md5Digest, MohDbClient, MohDbError, MohDbFile, PakRadarEntry, PakRadarError,
    download_mohdb_file_reporting, download_pakradar_archive_retrying,
};
use reveille_core::retry::RetryPolicy;
use tempfile::TempDir;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::net::TcpListener;

const BODY: &[u8] = b"PK\x03\x04 a stand-in for a map archive, long enough to cut in half";
const INSTANT: RetryPolicy = RetryPolicy::new(&[Duration::ZERO, Duration::ZERO, Duration::ZERO]);

/// What the host does with one request.
#[derive(Clone, Copy)]
enum Reply {
    /// Declare the whole body, send half of it, then hang up.
    CutOff,
    /// Answer with this status and no body.
    Status(&'static str),
    /// Send the whole body.
    Whole,
}

/// Serve `replies` in order, one per connection, and count the requests that arrived.
async fn host(replies: Vec<Reply>) -> (String, Arc<AtomicUsize>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("loopback host");
    let url = format!(
        "http://{}/maps/obj_test.pk3",
        listener.local_addr().expect("address")
    );
    let requests = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&requests);
    tokio::spawn(async move {
        for reply in replies {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            counted.fetch_add(1, Ordering::SeqCst);
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                if stream.read_exact(&mut byte).await.is_err() {
                    break;
                }
                request.push(byte[0]);
            }
            let head = |status: &str, length: usize| {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n"
                )
            };
            let response = match reply {
                Reply::CutOff => [
                    head("200 OK", BODY.len()).as_bytes(),
                    &BODY[..BODY.len() / 2],
                ]
                .concat(),
                Reply::Status(status) => head(status, 0).into_bytes(),
                Reply::Whole => [head("200 OK", BODY.len()).as_bytes(), BODY].concat(),
            };
            let _ = stream.write_all(&response).await;
            let _ = stream.shutdown().await;
        }
    });
    (url, requests)
}

fn mohdb_file(url: String) -> MohDbFile {
    MohDbFile {
        filename: "obj_test.pk3".to_owned(),
        file_size: FileSize::new(BODY.len() as u64),
        download_url: url,
    }
}

fn mohdb_client() -> MohDbClient {
    MohDbClient::new(Duration::from_secs(5))
        .expect("client")
        .with_retry(INSTANT)
}

fn pakradar_entry(url: String) -> PakRadarEntry {
    let digest = Md5::digest(BODY);
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    PakRadarEntry {
        alias: "obj_test".to_owned(),
        md5: Md5Digest::parse(&hex).expect("digest"),
        url,
    }
}

#[tokio::test]
async fn a_moh_db_download_survives_a_cut_connection_and_a_busy_host() {
    let (url, requests) = host(vec![
        Reply::CutOff,
        Reply::Status("503 Service Unavailable"),
        Reply::Whole,
    ])
    .await;
    let staging = TempDir::new().expect("staging");
    let mut restarts = 0;
    let archive = download_mohdb_file_reporting(
        &mohdb_client(),
        &mohdb_file(url),
        staging.path(),
        |progress| {
            if progress.received == 0 {
                restarts += 1;
            }
        },
    )
    .await
    .expect("third attempt succeeds");

    assert_eq!(std::fs::read(&archive.path).expect("staged"), BODY);
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    // The second attempt failed before its body began, so only two attempts reported progress.
    assert_eq!(restarts, 2);
}

#[tokio::test]
async fn a_moh_db_file_that_is_gone_is_asked_for_once() {
    let (url, requests) = host(vec![Reply::Status("404 Not Found"), Reply::Whole]).await;
    let staging = TempDir::new().expect("staging");
    let error =
        download_mohdb_file_reporting(&mohdb_client(), &mohdb_file(url), staging.path(), |_| {})
            .await
            .expect_err("404 is final");

    assert!(matches!(error, MohDbError::Status(status) if status.as_u16() == 404));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read_dir(staging.path()).expect("staging").count(),
        0
    );
}

#[tokio::test]
async fn a_moh_db_host_that_never_recovers_fails_after_the_last_retry() {
    let (url, requests) = host(vec![Reply::Status("502 Bad Gateway"); 4]).await;
    let staging = TempDir::new().expect("staging");
    let error =
        download_mohdb_file_reporting(&mohdb_client(), &mohdb_file(url), staging.path(), |_| {})
            .await
            .expect_err("host stays down");

    assert!(error.is_transient());
    assert_eq!(requests.load(Ordering::SeqCst), INSTANT.attempts());
}

#[tokio::test]
async fn a_pakradar_download_survives_a_cut_connection() {
    let (url, requests) = host(vec![Reply::CutOff, Reply::Whole]).await;
    let staging = TempDir::new().expect("staging");
    let archive = download_pakradar_archive_retrying(
        &reveille_core::content::pakradar_client(Duration::from_secs(5)).expect("client"),
        &pakradar_entry(url),
        staging.path(),
        |_| {},
        INSTANT,
    )
    .await
    .expect("second attempt succeeds");

    assert_eq!(std::fs::read(&archive.path).expect("staged"), BODY);
    assert_eq!(requests.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_pakradar_refusal_is_not_retried() {
    let (url, requests) = host(vec![Reply::Status("403 Forbidden"), Reply::Whole]).await;
    let staging = TempDir::new().expect("staging");
    let error = download_pakradar_archive_retrying(
        &reveille_core::content::pakradar_client(Duration::from_secs(5)).expect("client"),
        &pakradar_entry(url),
        staging.path(),
        |_| {},
        INSTANT,
    )
    .await
    .expect_err("403 is final");

    assert!(matches!(error, PakRadarError::HttpStatus(403)));
    assert_eq!(requests.load(Ordering::SeqCst), 1);
}
