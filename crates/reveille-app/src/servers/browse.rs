// SPDX-License-Identifier: GPL-3.0-only

use std::time::Duration;

use reveille_core::discovery::{
    self, BrowseConfig, BrowseEvent, BrowseSummary, NonResult, NonResultReason, ProbeStage,
};
use reveille_core::mapindex::MapIndex;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::sync::mpsc;
use tracing::info;

use super::failure::BrowseFailure;
use super::{BrowserServer, ListTicket, Listing, PROBE_TIMEOUT, classified};
use crate::session::{Session, installed_maps};
use crate::telemetry::{Event, Telemetry};

#[derive(Serialize)]
pub struct BrowserPayload {
    servers: Vec<BrowserServer>,
    summary: BrowseSummary,
    non_results: Vec<NonResultGroup>,
    cancelled: bool,
}

/// Recorded non-results grouped for display. Individual reasons stay distinguishable; only the
/// repetition is collapsed.
#[derive(Serialize)]
pub struct NonResultGroup {
    stage: ProbeStage,
    reason: &'static str,
    detail: Option<String>,
    count: usize,
}

#[derive(Clone, Serialize)]
pub struct BrowseProgress {
    registered: usize,
    inspected: usize,
    probed: usize,
    answered: usize,
    non_results: usize,
    row: Option<BrowserServer>,
}

/// Stop the sweep currently running, if any. Servers already probed are kept.
#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn cancel_browse(state: tauri::State<'_, Listing>) {
    info!("browse cancellation requested");
    state.cancel.notify_one();
}

/// Sweep the master list for `session`'s game, streaming progress over `on_progress`.
///
/// The channel belongs to this call alone. A message that cannot be delivered is dropped rather
/// than ending the sweep, which still rebuilds the list joins are prepared against. Stopping stays
/// with `cancel_browse`, because a channel only flows towards the frontend. The stream ends when
/// the command returns, and the returned payload supersedes everything it carried.
#[tauri::command]
pub async fn browse_servers(
    session: Session,
    background: Option<bool>,
    on_progress: Channel<BrowseProgress>,
    state: tauri::State<'_, Listing>,
    telemetry: tauri::State<'_, Telemetry>,
) -> Result<BrowserPayload, BrowseFailure> {
    let (game, engine) = (session.game, session.engine);
    let result = sweep_servers(session, background.unwrap_or(false), &on_progress, state).await;
    telemetry.track(&match &result {
        Ok(payload) => Event::ServerListLoaded {
            game,
            engine,
            server_count: payload.servers.len(),
            cancelled: payload.cancelled,
        },
        Err(failure) => Event::ServerListFailed {
            game,
            engine,
            reason: failure.kind,
        },
    });
    result
}

async fn sweep_servers(
    session: Session,
    background: bool,
    on_progress: &Channel<BrowseProgress>,
    state: tauri::State<'_, Listing>,
) -> Result<BrowserPayload, BrowseFailure> {
    info!(game = ?session.game, "starting server browse");
    let index = installed_maps(&session)?;

    // A stop pressed just as the previous sweep ended leaves a permit behind, which would cancel
    // this one before it probed anything. Consume it: polling `notified` once resolves immediately
    // when a permit is stored and times out otherwise.
    drop(tokio::time::timeout(Duration::ZERO, state.cancel.notified()).await);
    // Rows are offered to the player as they stream, so a join prepared mid-sweep must be able to
    // find its server. The list is rebuilt from the authoritative report when the sweep ends.
    let ticket = if background {
        state.begin_background_sweep(session.game)?
    } else {
        state.begin_sweep(session.game)?
    };

    let (sink, mut events) = mpsc::channel(64);
    let sweep = tokio::spawn(discovery::browse_streaming(
        BrowseConfig {
            target: session.game,
            limit: None,
            concurrency: 16,
            master_timeout: Duration::from_secs(15),
            probe_timeout: PROBE_TIMEOUT,
        },
        sink,
    ));

    let cancelled = stream_sweep(on_progress, &state, ticket, &index, &mut events).await?;
    // Dropping the receiver is what stops the sweep. It returns what it already inspected.
    drop(events);

    let report = sweep
        .await
        .map_err(|error| BrowseFailure::from(format!("the server sweep did not finish: {error}")))?
        .map_err(BrowseFailure::from)?;
    info!(
        registered = report.summary().registered,
        inspected = report.summary().inspected,
        non_results = report.summary().non_results,
        cancelled,
        "server browse finished"
    );
    let servers = report
        .outcomes
        .iter()
        .filter_map(|outcome| outcome.server.clone())
        .collect::<Vec<_>>();
    let mut rows = servers
        .iter()
        .map(|server| classified(server, &index))
        .collect::<Vec<_>>();
    // Ordered by the only quantity a server actually reports about its population.
    rows.sort_by_key(|row| {
        std::cmp::Reverse(
            row.server
                .occupancy
                .clients_reported
                .map_or(0, discovery::ClientsReported::get),
        )
    });
    if state
        .update_sweep(ticket, servers, !background || !cancelled)?
        .is_none()
    {
        info!("a newer sweep replaced this one; its servers were not kept");
    }

    Ok(BrowserPayload {
        servers: rows,
        summary: report.summary(),
        non_results: group_non_results(
            report
                .outcomes
                .iter()
                .filter_map(|outcome| outcome.non_result.as_ref()),
        ),
        cancelled,
    })
}

/// Relay sweep events to the frontend until the sweep ends or the player stops it.
///
/// Answered servers land in the shared list as they arrive, because a player can select a row while
/// the sweep is still running and preparing that join has to be able to find the server.
///
/// Returns whether the sweep was stopped early.
async fn stream_sweep(
    on_progress: &Channel<BrowseProgress>,
    state: &tauri::State<'_, Listing>,
    ticket: ListTicket,
    index: &MapIndex,
    events: &mut mpsc::Receiver<BrowseEvent>,
) -> Result<bool, String> {
    let mut progress = BrowseProgress {
        registered: 0,
        inspected: 0,
        probed: 0,
        answered: 0,
        non_results: 0,
        row: None,
    };
    loop {
        let event = tokio::select! {
            event = events.recv() => event,
            () = state.cancel.notified() => {
                info!("stopped streaming browse events after cancellation");
                return Ok(true);
            },
        };
        let Some(event) = event else {
            info!("finished streaming browse events");
            return Ok(false);
        };
        match event {
            BrowseEvent::Registered {
                registered,
                inspected,
            } => {
                progress.registered = registered;
                progress.inspected = inspected;
                progress.row = None;
            }
            BrowseEvent::Outcome(outcome) => {
                progress.probed += 1;
                progress.row = outcome
                    .server
                    .as_ref()
                    .map(|server| classified(server, index));
                if let Some(server) = outcome.server {
                    progress.answered += 1;
                    state.update_sweep(ticket, vec![server], false)?;
                } else {
                    progress.non_results += 1;
                }
            }
        }
        drop(on_progress.send(progress.clone()));
    }
}

pub fn group_non_results<'a>(
    non_results: impl Iterator<Item = &'a NonResult>,
) -> Vec<NonResultGroup> {
    let mut groups: Vec<NonResultGroup> = Vec::new();
    for non_result in non_results {
        let (reason, detail) = describe_non_result(&non_result.reason);
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group.stage == non_result.stage && group.reason == reason)
        {
            group.count += 1;
            continue;
        }
        groups.push(NonResultGroup {
            stage: non_result.stage,
            reason,
            detail,
            count: 1,
        });
    }
    groups.sort_by_key(|group| std::cmp::Reverse(group.count));
    groups
}

fn describe_non_result(reason: &NonResultReason) -> (&'static str, Option<String>) {
    match reason {
        NonResultReason::Timeout => ("timeout", None),
        NonResultReason::Network { message } => ("network", Some(message.clone())),
        NonResultReason::Malformed { message } => ("malformed", Some(message.clone())),
        NonResultReason::MissingHostPort => ("missing_host_port", None),
        NonResultReason::DuplicateEndpoint { game_port } => {
            ("duplicate_endpoint", Some(game_port.get().to_string()))
        }
    }
}
