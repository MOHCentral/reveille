// SPDX-License-Identifier: GPL-3.0-only

//! Platform-neutral content and compatibility logic for Reveille.

#![forbid(unsafe_code)]
// The boundaries AGENTS.md states, made mechanical (issue #9). `cfg_attr(not(test), …)` rather
// than a bare `deny`: `cargo clippy --all-targets` compiles this crate twice, once plain and once
// with `cfg(test)`. The plain build still denies every production site, so nothing is weakened —
// but unit tests keep `unwrap`/`expect` with explicit messages, in one line here instead of an
// `#[allow]` on every `mod tests`. Integration tests are separate crates and are untouched.
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::dbg_macro,
        clippy::todo,
        clippy::unimplemented,
        clippy::print_stdout,
        clippy::print_stderr,
    )
)]

pub mod bsp;
pub mod content;
pub mod discovery;
pub mod engine;
pub mod install;
pub mod join;
pub mod mapindex;
pub mod platform;
pub mod preflight;
