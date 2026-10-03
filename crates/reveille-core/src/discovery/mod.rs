// SPDX-License-Identifier: GPL-3.0-only

//! Public-server discovery over the `GameSpy` and MOHAA protocols.

mod client;
mod model;
mod protocol;
mod rcon;
mod rcon_parse;

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
pub use rcon::{
    RconCommand, RconError, RconInputError, RconPassword, RconReply, RconTiming, RconVerdict,
    send_rcon,
};
pub use rcon_parse::{RconPlayer, RconPlayerState, is_safe_map_name, parse_status_players};
