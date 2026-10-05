// SPDX-License-Identifier: GPL-3.0-only

use std::io;

use reveille_core::discovery::{DiscoveryError, RequestError};
use serde::Serialize;

use crate::session::SessionError;
use crate::telemetry::BrowseFailureKind;

#[derive(Clone, Debug, Serialize)]
pub struct BrowseFailure {
    pub kind: BrowseFailureKind,
    detail: String,
}

/// Separate I/O failures that establish a local networking problem from failures that can be the
/// remote master's doing. `RequestError::Network` is shared by TCP connect/read/write and the
/// per-server UDP path, so treating the whole variant as "this PC is offline" invents a cause.
pub fn classify_master_network_error(error: &io::Error) -> BrowseFailureKind {
    use io::ErrorKind;

    match error.kind() {
        ErrorKind::PermissionDenied
        | ErrorKind::AddrNotAvailable
        | ErrorKind::NetworkUnreachable
        | ErrorKind::HostUnreachable => BrowseFailureKind::NoNetwork,
        _ => BrowseFailureKind::MasterUnreachable,
    }
}

impl From<DiscoveryError> for BrowseFailure {
    fn from(error: DiscoveryError) -> Self {
        use BrowseFailureKind as Kind;

        let kind = match &error {
            DiscoveryError::Master { source, .. } => match source {
                RequestError::Network(source) => classify_master_network_error(source),
                RequestError::Timeout => Kind::MasterUnreachable,
                RequestError::Parse(_)
                | RequestError::EmptyMasterGreeting
                | RequestError::MasterResponseTooLarge => Kind::MasterUnreadable,
                // Encoding the validation cannot fail on any input this crate supplies, so a
                // failure here is a bug in Reveille and not a fact about the network.
                RequestError::Crypto(_) => Kind::Internal,
            },
            DiscoveryError::Task(_) => Kind::Internal,
        };
        Self {
            kind,
            detail: error.to_string(),
        }
    }
}

impl From<SessionError> for BrowseFailure {
    fn from(error: SessionError) -> Self {
        let kind = match &error {
            SessionError::Folder(_) | SessionError::GameMissing(_) => {
                BrowseFailureKind::GameUnavailable
            }
            SessionError::Engine(_) => BrowseFailureKind::EngineUnavailable,
            SessionError::Maps(_) => BrowseFailureKind::MapsUnreadable,
        };
        Self {
            kind,
            detail: error.to_string(),
        }
    }
}

/// Every other way `browse_servers` can stop: a poisoned lock or a sweep that did not finish. These
/// carry their own message and are not classified as anything about the network.
impl From<String> for BrowseFailure {
    fn from(detail: String) -> Self {
        Self {
            kind: BrowseFailureKind::Internal,
            detail,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;

    use reveille_core::discovery::{ParseError, TargetGame};
    use reveille_core::engine::EngineChoice;
    use reveille_platform as platform;
    use tempfile::TempDir;

    use super::{BrowseFailure, BrowseFailureKind, DiscoveryError, RequestError};
    use crate::session::{Session, installed_maps};

    #[test]
    fn a_saved_session_that_no_longer_fits_the_pc_is_not_reported_as_internal() {
        let temporary = TempDir::new().expect("temporary directory");
        fs::create_dir(temporary.path().join("main")).expect("main directory");
        fs::write(
            platform::default_client(
                temporary.path(),
                TargetGame::AlliedAssault,
                platform::ClientKind::OpenMohaa,
            ),
            [],
        )
        .expect("client marker");
        let path = temporary.path().to_string_lossy().into_owned();
        let browse_kind = |path: &str, engine, game| {
            let error = installed_maps(&Session {
                path: path.to_owned(),
                engine,
                game,
            })
            .expect_err("the session is refused");
            BrowseFailure::from(error).kind
        };

        assert_eq!(
            browse_kind(
                &temporary.path().join("moved").to_string_lossy(),
                EngineChoice::Openmohaa,
                TargetGame::AlliedAssault,
            ),
            BrowseFailureKind::GameUnavailable
        );
        assert_eq!(
            browse_kind(&path, EngineChoice::Openmohaa, TargetGame::Spearhead),
            BrowseFailureKind::GameUnavailable
        );
        assert_eq!(
            browse_kind(&path, EngineChoice::Reborn, TargetGame::AlliedAssault),
            BrowseFailureKind::EngineUnavailable
        );
    }

    #[test]
    fn a_sweep_failure_says_which_of_the_four_things_went_wrong() {
        // The whole point of classifying here rather than in JavaScript: a local networking
        // failure, a master that is down, and a master whose reply was truncated are different
        // situations, and matching on message text is how they became one unreadable line in the
        // status bar.
        let unreadable = BrowseFailure::from(DiscoveryError::Master {
            target: TargetGame::AlliedAssault,
            source: RequestError::Parse(ParseError::MisalignedMasterBody { length: 42 }),
        });
        assert_eq!(unreadable.kind, BrowseFailureKind::MasterUnreadable);

        let silent = BrowseFailure::from(DiscoveryError::Master {
            target: TargetGame::AlliedAssault,
            source: RequestError::Timeout,
        });
        assert_eq!(silent.kind, BrowseFailureKind::MasterUnreachable);

        let offline = BrowseFailure::from(DiscoveryError::Master {
            target: TargetGame::AlliedAssault,
            source: RequestError::Network(io::Error::from(io::ErrorKind::PermissionDenied)),
        });
        assert_eq!(offline.kind, BrowseFailureKind::NoNetwork);

        // Refusal and reset are observations about the remote TCP exchange, not evidence that the
        // player's PC is offline. Both used to be folded into `NoNetwork` with every other I/O
        // error because `fetch_master` wraps connect, read, and write failures in one variant.
        let master_io_failure = |kind| {
            BrowseFailure::from(DiscoveryError::Master {
                target: TargetGame::AlliedAssault,
                source: RequestError::Network(io::Error::from(kind)),
            })
            .kind
        };
        assert_eq!(
            master_io_failure(io::ErrorKind::ConnectionRefused),
            BrowseFailureKind::MasterUnreachable
        );
        assert_eq!(
            master_io_failure(io::ErrorKind::ConnectionReset),
            BrowseFailureKind::MasterUnreachable
        );

        // Whatever the classification, the original message survives for a bug report. It is
        // simply no longer the only thing the player is given.
        assert!(unreadable.detail.contains("42"));
    }
}
