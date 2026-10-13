// SPDX-License-Identifier: GPL-3.0-only

//! Discord Rich Presence: once the player has chosen to share, their Discord friends see the game
//! Reveille launched and the server's name while it runs.
//!
//! Discord clears an activity when the connection that set it closes, so the open connection is
//! the presence: dropping it ends the status, and so does Reveille exiting by any means, a crash
//! included.

use std::io;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reveille_core::discovery::TargetGame;
use serde_json::{Value, json};
use tauri::Manager;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::oneshot;
use tracing::{debug, info, warn};

/// The Reveille application in the Discord Developer Portal. An application ID is public.
const CLIENT_ID: &str = "1559612097757839461";
/// The logo uploaded to that application's art assets.
const LOGO_ASSET: &str = "reveille";
/// discord.com/developers/docs/events/gateway-events#activity-object: `details` and `state` are
/// limited to 128 characters, and Discord rejects the whole activity when either is shorter than 2.
const TEXT_LIMIT: usize = 128;
const TEXT_MINIMUM: usize = 2;
/// Opcodes of Discord's local RPC framing.
const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
const PING: u32 = 3;
const PONG: u32 = 4;
/// Discord's replies are small JSON objects; a length beyond this is not Discord.
const REPLY_LIMIT: usize = 64 * 1024;
/// A Discord that has not answered by now is starting, updating or stuck; the match goes on
/// without a status.
const DEADLINE: Duration = Duration::from_secs(5);

#[cfg(windows)]
type Pipe = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(unix)]
type Pipe = tokio::net::UnixStream;

/// Identifies one launched match, so a game that closes cannot end a later match's status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatchId(u64);

/// Whether the player shares their match, the match being played, and the connection holding
/// its status. Off until the player says otherwise.
#[derive(Default)]
pub struct Presence {
    state: Mutex<State<Hold>>,
}

/// Holds a status open: dropping it stops the task that owns Discord's connection, which closes it.
type Hold = oneshot::Sender<()>;

/// An exchange to start with Discord: show `activity`, keeping the connection only if `attempt`
/// is still the latest when it answers.
struct Publish {
    attempt: u64,
    activity: Activity,
}

/// Generic over the connection so the transitions are testable without Discord.
struct State<C> {
    enabled: bool,
    last_match: u64,
    current: Option<(MatchId, Activity)>,
    /// Bumped by every change, so an exchange that finishes after one keeps nothing.
    attempt: u64,
    connection: Option<C>,
}

impl<C> Default for State<C> {
    fn default() -> Self {
        Self {
            enabled: false,
            last_match: 0,
            current: None,
            attempt: 0,
            connection: None,
        }
    }
}

impl<C> State<C> {
    fn set_enabled(&mut self, enabled: bool) -> Option<Publish> {
        if self.enabled == enabled {
            return None;
        }
        self.enabled = enabled;
        self.reset()
    }

    fn begin(&mut self, activity: Activity) -> (MatchId, Option<Publish>) {
        self.last_match += 1;
        let id = MatchId(self.last_match);
        self.current = Some((id, activity));
        (id, self.reset())
    }

    fn end(&mut self, id: MatchId) {
        if self
            .current
            .as_ref()
            .is_some_and(|(current, _)| *current == id)
        {
            self.current = None;
            self.reset();
        }
    }

    /// Keep the connection of a finished exchange, unless something changed while it ran.
    fn keep(&mut self, attempt: u64, connection: C) -> bool {
        let current = self.attempt == attempt;
        if current {
            self.connection = Some(connection);
        }
        current
    }

    /// Drop the status showing and say what, if anything, should show instead.
    fn reset(&mut self) -> Option<Publish> {
        self.attempt += 1;
        self.connection = None;
        let (_, activity) = self.current.as_ref().filter(|_| self.enabled)?;
        Some(Publish {
            attempt: self.attempt,
            activity: activity.clone(),
        })
    }
}

pub fn register(app: &mut tauri::App) {
    app.manage(Presence::default());
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves managed state only for by-value command parameters"
)]
pub fn set_discord_presence(
    app: tauri::AppHandle,
    presence: tauri::State<'_, Presence>,
    enabled: bool,
) {
    let next = presence
        .state
        .lock()
        .ok()
        .and_then(|mut state| state.set_enabled(enabled));
    if let Some(next) = next {
        publish(&app, next);
    }
}

/// The match the player's friends see.
#[derive(Clone)]
pub struct Activity {
    pub game: TargetGame,
    pub server: String,
    pub started: SystemTime,
}

impl Activity {
    fn payload(&self) -> Value {
        let state = displayable(&self.server);
        let mut payload = json!({
            "details": clip(&format!("Playing {}", self.game.label())),
            "timestamps": {
                "start": self.started.duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs()),
            },
            "assets": { "large_image": LOGO_ASSET, "large_text": "Reveille" },
        });
        if state.chars().count() >= TEXT_MINIMUM {
            payload["state"] = Value::String(clip(&state));
        }
        payload
    }
}

/// A server names itself: drop the control and direction-override characters that would let it
/// garble or reorder the player's own status.
fn displayable(text: &str) -> String {
    text.split(|c: char| c.is_control() || c.is_whitespace() || is_bidi_control(c))
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn clip(text: &str) -> String {
    text.chars().take(TEXT_LIMIT).collect()
}

/// A match has started: it replaces any status showing, and is shown when the player shares.
pub fn begin(app: &tauri::AppHandle, activity: Activity) -> Option<MatchId> {
    let (id, next) = app.state::<Presence>().state.lock().ok()?.begin(activity);
    if let Some(next) = next {
        publish(app, next);
    }
    Some(id)
}

/// The game of match `id` has closed. A later match keeps its status.
pub fn end(app: &tauri::AppHandle, id: MatchId) {
    if let Ok(mut state) = app.state::<Presence>().state.lock() {
        state.end(id);
    }
}

/// Whether a Discord app is listening on this computer, so the page may offer to share the match.
/// Opening the endpoint is enough; nothing is sent.
#[tauri::command]
pub async fn discord_running() -> bool {
    match tokio::time::timeout(DEADLINE, connect()).await {
        Ok(Ok(_)) => true,
        Ok(Err(error)) => busy(&error),
        Err(_) => false,
    }
}

/// winerror.h `ERROR_PIPE_BUSY`: Discord is there, serving another client.
#[cfg(windows)]
fn busy(error: &io::Error) -> bool {
    error.raw_os_error() == Some(231)
}

#[cfg(unix)]
fn busy(_: &io::Error) -> bool {
    false
}

fn publish(app: &tauri::AppHandle, Publish { attempt, activity }: Publish) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut pipe = match tokio::time::timeout(DEADLINE, connect()).await {
            Ok(Ok(pipe)) => pipe,
            // Discord not running here is the ordinary case, not a fault.
            Ok(Err(error)) => return debug!(%error, "Discord is not listening"),
            Err(_) => return warn!("Discord did not accept the connection in time"),
        };
        let nonce = uuid::Uuid::new_v4().to_string();
        match tokio::time::timeout(DEADLINE, set_activity(&mut pipe, &activity, &nonce)).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return warn!(%error, "Discord refused the activity"),
            Err(_) => return warn!("Discord did not answer the activity in time"),
        }
        let (hold, stop) = oneshot::channel();
        let kept = app
            .state::<Presence>()
            .state
            .lock()
            .is_ok_and(|mut state| state.keep(attempt, hold));
        if kept && serve(&mut pipe, stop).await == Served::Closed {
            info!("Discord closed the status connection");
        }
    });
}

#[derive(Debug, PartialEq, Eq)]
enum Served {
    /// The status was ended from this side.
    Stopped,
    /// Discord closed or broke the connection.
    Closed,
}

/// Keep the connection that holds the status: answer Discord's pings, and notice when it goes.
async fn serve(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    mut stop: oneshot::Receiver<()>,
) -> Served {
    loop {
        tokio::select! {
            _ = &mut stop => return Served::Stopped,
            frame = read_frame(stream) => match frame {
                Ok((PING, body)) => {
                    if write_frame(stream, PONG, &body).await.is_err() {
                        return Served::Closed;
                    }
                }
                Ok((FRAME, _)) => {}
                Ok(_) | Err(_) => return Served::Closed,
            },
        }
    }
}

async fn set_activity(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    activity: &Activity,
    nonce: &str,
) -> io::Result<()> {
    write_frame(
        stream,
        HANDSHAKE,
        &json!({ "v": 1, "client_id": CLIENT_ID }),
    )
    .await?;
    await_reply(stream, |reply| {
        reply.get("evt").and_then(Value::as_str) == Some("READY")
    })
    .await?;
    write_frame(
        stream,
        FRAME,
        &json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity.payload() },
            "nonce": nonce,
        }),
    )
    .await?;
    await_reply(stream, |reply| {
        reply.get("nonce").and_then(Value::as_str) == Some(nonce)
    })
    .await
}

/// Read until the frame `wanted` picks out, answering pings and skipping unrelated events on the
/// way. An `evt` of `ERROR`, a `CLOSE` frame, or any other opcode is a refusal.
async fn await_reply(
    stream: &mut (impl AsyncRead + AsyncWrite + Unpin),
    wanted: impl Fn(&Value) -> bool,
) -> io::Result<()> {
    loop {
        let (opcode, reply) = read_frame(stream).await?;
        let error = reply.get("evt").and_then(Value::as_str) == Some("ERROR");
        match opcode {
            PING => write_frame(stream, PONG, &reply).await?,
            FRAME if !error && wanted(&reply) => return Ok(()),
            FRAME if !error => {}
            _ => return Err(io::Error::other(format!("Discord refused: {reply}"))),
        }
    }
}

/// One message, header and body, in a single write: a Windows pipe in message mode takes each
/// write as a message of its own.
async fn write_frame(
    stream: &mut (impl AsyncWrite + Unpin),
    opcode: u32,
    body: &Value,
) -> io::Result<()> {
    let body = serde_json::to_vec(body)?;
    let length = u32::try_from(body.len()).map_err(io::Error::other)?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend(opcode.to_le_bytes());
    frame.extend(length.to_le_bytes());
    frame.extend(body);
    stream.write_all(&frame).await
}

async fn read_frame(stream: &mut (impl AsyncRead + Unpin)) -> io::Result<(u32, Value)> {
    let mut header = [0; 8];
    stream.read_exact(&mut header).await?;
    let [o0, o1, o2, o3, l0, l1, l2, l3] = header;
    let length = usize::try_from(u32::from_le_bytes([l0, l1, l2, l3])).map_err(io::Error::other)?;
    if length > REPLY_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized Discord reply",
        ));
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).await?;
    Ok((
        u32::from_le_bytes([o0, o1, o2, o3]),
        serde_json::from_slice(&body)?,
    ))
}

/// Discord listens on the first free of ten numbered endpoints.
async fn connect() -> io::Result<Pipe> {
    let mut last = io::Error::from(io::ErrorKind::NotFound);
    for n in 0..10 {
        match open(n).await {
            Ok(pipe) => return Ok(pipe),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// Tokio opens the client with `SECURITY_IDENTIFICATION`, so a program squatting on Discord's pipe
/// name cannot act as the player.
#[cfg(windows)]
#[expect(clippy::unused_async, reason = "the Unix connect awaits")]
async fn open(n: u8) -> io::Result<Pipe> {
    tokio::net::windows::named_pipe::ClientOptions::new().open(format!(r"\\.\pipe\discord-ipc-{n}"))
}

#[cfg(unix)]
async fn open(n: u8) -> io::Result<Pipe> {
    let mut last = io::Error::from(io::ErrorKind::NotFound);
    for dir in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(std::path::PathBuf::from)
        .chain([std::path::PathBuf::from("/tmp")])
    {
        match Pipe::connect(dir.join(format!("discord-ipc-{n}"))).await {
            Ok(pipe) => return Ok(pipe),
            Err(error) => last = error,
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use tokio::io::Join;

    use super::*;

    fn activity(server: &str) -> Activity {
        Activity {
            game: TargetGame::Spearhead,
            server: server.to_owned(),
            started: UNIX_EPOCH + Duration::from_secs(1_700_000_000),
        }
    }

    async fn frame(opcode: u32, body: &Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, opcode, body).await.expect("frame");
        bytes
    }

    /// Discord's side of the exchange: canned replies in, whatever Reveille wrote out.
    type FakeDiscord = Join<Cursor<Vec<u8>>, Vec<u8>>;

    async fn discord(replies: &[(u32, Value)]) -> FakeDiscord {
        let mut bytes = Vec::new();
        for (opcode, body) in replies {
            bytes.extend(frame(*opcode, body).await);
        }
        tokio::io::join(Cursor::new(bytes), Vec::new())
    }

    async fn sent(discord: FakeDiscord) -> Vec<(u32, Value)> {
        let (_, written) = discord.into_inner();
        let length = written.len() as u64;
        let mut written = Cursor::new(written);
        let mut frames = Vec::new();
        while written.position() < length {
            frames.push(read_frame(&mut written).await.expect("sent frame"));
        }
        frames
    }

    fn sharing() -> State<&'static str> {
        let mut state = State::default();
        assert!(
            state.set_enabled(true).is_none(),
            "no match yet, nothing to show"
        );
        state
    }

    #[test]
    fn nothing_is_shared_until_the_player_turns_it_on() {
        let mut state = State::<&str>::default();
        let (_, next) = state.begin(activity("Some Server"));
        assert!(next.is_none());
        let next = state.set_enabled(true).expect("the match now shows");
        assert_eq!(next.activity.server, "Some Server");
    }

    #[test]
    fn a_game_that_closes_during_the_exchange_keeps_no_status() {
        let mut state = sharing();
        let (id, next) = state.begin(activity("Some Server"));
        let next = next.expect("shown");
        state.end(id);
        assert!(!state.keep(next.attempt, "pipe"));
        assert!(state.connection.is_none());
    }

    #[test]
    fn turning_it_off_during_the_exchange_keeps_no_status() {
        let mut state = sharing();
        let next = state.begin(activity("Some Server")).1.expect("shown");
        assert!(state.set_enabled(false).is_none());
        assert!(!state.keep(next.attempt, "pipe"));
    }

    #[test]
    fn turning_it_back_on_shows_the_match_still_running() {
        let mut state = sharing();
        let next = state.begin(activity("Some Server")).1.expect("shown");
        assert!(state.keep(next.attempt, "pipe"));
        state.set_enabled(false);
        assert!(state.connection.is_none());
        let next = state.set_enabled(true).expect("shown again");
        assert!(state.keep(next.attempt, "pipe"));
    }

    #[test]
    fn an_earlier_game_closing_leaves_the_later_match_showing() {
        let mut state = sharing();
        let (first, _) = state.begin(activity("First"));
        let next = state.begin(activity("Second")).1.expect("shown");
        assert!(state.keep(next.attempt, "pipe"));
        state.end(first);
        assert_eq!(state.connection, Some("pipe"));
    }

    #[tokio::test]
    async fn a_held_status_answers_pings_until_it_is_dropped() {
        let (mut ours, mut discord) = tokio::io::duplex(1024);
        let (hold, stop) = oneshot::channel();
        let served = tokio::spawn(async move { serve(&mut ours, stop).await });

        write_frame(&mut discord, PING, &json!({ "n": 1 }))
            .await
            .expect("ping");
        assert_eq!(
            read_frame(&mut discord).await.expect("pong"),
            (PONG, json!({ "n": 1 }))
        );
        drop(hold);
        assert_eq!(served.await.expect("served"), Served::Stopped);
    }

    #[tokio::test]
    async fn a_held_status_notices_discord_leaving() {
        let (mut ours, discord) = tokio::io::duplex(1024);
        let (_hold, stop) = oneshot::channel();
        drop(discord);
        assert_eq!(serve(&mut ours, stop).await, Served::Closed);
    }

    #[tokio::test]
    async fn a_frame_is_a_little_endian_opcode_and_length_before_the_json() {
        let bytes = frame(FRAME, &json!({ "a": 1 })).await;
        assert_eq!(&bytes[..8], &[1, 0, 0, 0, 7, 0, 0, 0]);
        assert_eq!(&bytes[8..], br#"{"a":1}"#);
    }

    #[test]
    fn the_status_names_the_game_and_server() {
        let payload = activity("[EU] Some Server ").payload();
        assert_eq!(payload["details"], "Playing Spearhead");
        assert_eq!(payload["state"], "[EU] Some Server");
        assert_eq!(payload["timestamps"]["start"], 1_700_000_000);
        assert_eq!(payload["assets"]["large_image"], LOGO_ASSET);
    }

    #[test]
    fn a_server_name_cannot_garble_the_status() {
        let payload = activity("Evil\u{202E}revreS\n\tName\u{0}").payload();
        assert_eq!(payload["state"], "Evil revreS Name");
    }

    #[test]
    fn a_state_discord_would_reject_as_too_short_is_left_out() {
        let payload = activity(" \u{200F} ").payload();
        assert!(payload.get("state").is_none());
    }

    #[test]
    fn long_names_are_cut_to_discords_limit_on_a_character_boundary() {
        let payload = activity(&"é".repeat(200)).payload();
        let state = payload["state"].as_str().expect("state");
        assert_eq!(state.chars().count(), TEXT_LIMIT);
    }

    #[tokio::test]
    async fn a_ready_discord_receives_the_handshake_then_the_activity() {
        let mut fake = discord(&[
            (FRAME, json!({ "cmd": "DISPATCH", "evt": "READY" })),
            (
                FRAME,
                json!({ "cmd": "SET_ACTIVITY", "evt": null, "nonce": "n1" }),
            ),
        ])
        .await;
        set_activity(&mut fake, &activity("Some Server"), "n1")
            .await
            .expect("accepted");
        let sent = sent(fake).await;
        assert_eq!(
            sent[0],
            (HANDSHAKE, json!({ "v": 1, "client_id": CLIENT_ID }))
        );
        assert_eq!(sent[1].0, FRAME);
        assert_eq!(sent[1].1["cmd"], "SET_ACTIVITY");
        assert_eq!(sent[1].1["nonce"], "n1");
        assert_eq!(sent[1].1["args"]["activity"]["state"], "Some Server");
    }

    #[tokio::test]
    async fn an_answer_to_another_request_does_not_accept_the_activity() {
        let mut fake = discord(&[
            (FRAME, json!({ "evt": "READY" })),
            (FRAME, json!({ "cmd": "SET_ACTIVITY", "nonce": "other" })),
        ])
        .await;
        assert!(
            set_activity(&mut fake, &activity("Some Server"), "n1")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn a_ping_is_answered_with_its_own_payload() {
        let mut fake = discord(&[
            (PING, json!({ "n": 7 })),
            (FRAME, json!({ "evt": "READY" })),
        ])
        .await;
        await_reply(&mut fake, |reply| reply["evt"] == "READY")
            .await
            .expect("ready");
        assert_eq!(sent(fake).await, vec![(PONG, json!({ "n": 7 }))]);
    }

    #[tokio::test]
    async fn a_closed_handshake_is_a_refusal() {
        let mut fake =
            discord(&[(2, json!({ "code": 4000, "message": "Invalid Client ID" }))]).await;
        assert!(
            set_activity(&mut fake, &activity("Some Server"), "n1")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn an_error_event_is_a_refusal() {
        let mut fake = discord(&[
            (FRAME, json!({ "evt": "READY" })),
            (
                FRAME,
                json!({ "evt": "ERROR", "data": { "message": "bad" } }),
            ),
        ])
        .await;
        assert!(
            set_activity(&mut fake, &activity("Some Server"), "n1")
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn an_oversized_reply_is_refused_before_it_is_read() {
        let mut header = FRAME.to_le_bytes().to_vec();
        header.extend(u32::MAX.to_le_bytes());
        assert!(read_frame(&mut Cursor::new(header)).await.is_err());
    }
}
