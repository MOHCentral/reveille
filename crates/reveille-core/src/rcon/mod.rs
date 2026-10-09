// SPDX-License-Identifier: GPL-3.0-only

//! Remote console for a server the player runs: typed actions in, parsed replies out.
//!
//! Nothing here builds a command line from a free string except [`RawCommand`], the console's
//! explicit escape hatch. Every other value is a newtype that refuses what could end its argument
//! early, so a map name or a chat line can never become a second command.

mod client;
mod command;
mod reply;

pub use client::{RconClient, RconError};
pub use command::{
    ChatText, ClientSlot, CvarName, InvalidValue, MapName, RawCommand, RconAction, RconEngine,
    RconPassword, Rotation,
};
pub use reply::{
    RconPlayer, RconStatus, ReplyError, parse_cvar, parse_print_packet, parse_status, reply_outcome,
};
