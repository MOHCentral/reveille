// SPDX-License-Identifier: GPL-3.0-only

//! Public-server discovery over the `GameSpy` and MOHAA protocols.

mod client;
mod model;
mod protocol;

pub use client::{
    BrowseConfig, BrowseEvent, DiscoveryError, RequestError, browse, browse_streaming,
    inspect_endpoint, query_getinfo, query_getstatus,
};
pub use model::{
    BotsReported, BrowseReport, BrowseSummary, ClientCapacity, ClientsReported, Deaths,
    DownloadFlags, GamePort, JoinWindowSeconds, Kills, MasterEndpoint, NonResult, NonResultReason,
    PingMillis, Player, PlayerPing, ProbeOutcome, ProbeStage, QueryPort, ReportedOccupancy,
    ReservedSlots, RoundTripMillis, Server, TargetGame,
};
pub use protocol::{
    CryptoError, FieldMap, ParseError, StatusResponse, build_master_query, gamespy_players,
    gs_encode, gs_encrypt, parse_gamespy_status, parse_master_challenge, parse_master_response,
    parse_oob_getinfo, parse_oob_getstatus,
};

pub(crate) use client::is_openmohaa_version;
pub(crate) use protocol::{OOB_RECV_HEADER, OOB_SEND_HEADER};
