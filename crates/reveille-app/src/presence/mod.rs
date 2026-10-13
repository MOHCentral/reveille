// SPDX-License-Identifier: GPL-3.0-only

//! Discord Rich Presence: while a game Reveille launched is running, the player's Discord friends
//! see the game, the server's name and its map — never its address.
//!
//! Discord clears an activity when the connection that set it closes, so the open connection is
//! the presence: dropping it ends the status, and so does Reveille exiting by any means, a crash
//! included.

use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use reveille_core::discovery::TargetGame;
use serde_json::{Value, json};
use tauri::Manager;
use tracing::debug;

/// The Reveille application in the Discord Developer Portal; an application ID is public. Discord
/// refuses the placeholder `0`, so no status is shown until the real ID is set.
const CLIENT_ID: &str = "0";
/// The logo uploaded to that application's art assets.
const LOGO_ASSET: &str = "reveille";
/// discord.com/developers/docs/events/gateway-events#activity-object: `details` and `state` are
/// limited to 128 characters, and Discord rejects the whole activity when either is shorter than 2.
const TEXT_LIMIT: usize = 128;
const TEXT_MINIMUM: usize = 2;
/// Opcodes of Discord's local RPC framing.
const HANDSHAKE: u32 = 0;
const FRAME: u32 = 1;
/// Discord's replies are small JSON objects; a length beyond this is not Discord.
const REPLY_LIMIT: usize = 64 * 1024;

#[cfg(windows)]
type Pipe = std::fs::File;
#[cfg(unix)]
type Pipe = std::os::unix::net::UnixStream;

/// Whether the player shares their match, and the connection holding the status while they do.
/// Off until the page sends the saved choice, so nothing is shared before it has loaded.
#[derive(Default)]
pub struct Presence {
    enabled: AtomicBool,
    connection: Mutex<Option<Pipe>>,
}

impl Presence {
    fn clear(&self) {
        if let Ok(mut connection) = self.connection.lock() {
            connection.take();
        }
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
pub fn set_discord_presence(presence: tauri::State<'_, Presence>, enabled: bool) {
    presence.enabled.store(enabled, Ordering::SeqCst);
    if !enabled {
        presence.clear();
    }
}

/// The match the player's friends see.
pub struct Activity {
    pub game: TargetGame,
    pub server: String,
    pub map: Option<String>,
    pub started: SystemTime,
}

impl Activity {
    fn payload(&self) -> Value {
        let server = self.server.trim();
        let state = match self.map.as_deref() {
            Some(map) if server.is_empty() => map.to_owned(),
            Some(map) => format!("{server} · {map}"),
            None => server.to_owned(),
        };
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

fn clip(text: &str) -> String {
    text.chars().take(TEXT_LIMIT).collect()
}

/// Show `activity` when the player shares their matches and Discord is running here. Returns
/// whether Discord accepted it.
pub async fn show(app: &tauri::AppHandle, activity: Activity) -> bool {
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        let presence = app.state::<Presence>();
        if !presence.enabled.load(Ordering::SeqCst) {
            return false;
        }
        match connect().and_then(|mut pipe| set_activity(&mut pipe, &activity).map(|()| pipe)) {
            Ok(pipe) => {
                if let Ok(mut connection) = presence.connection.lock() {
                    *connection = Some(pipe);
                    return true;
                }
                false
            }
            Err(error) => {
                debug!(%error, "Discord did not take the activity");
                false
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// End the status once the match is over.
pub fn clear(app: &tauri::AppHandle) {
    app.state::<Presence>().clear();
}

fn set_activity(stream: &mut (impl Read + Write), activity: &Activity) -> io::Result<()> {
    write_frame(
        stream,
        HANDSHAKE,
        &json!({ "v": 1, "client_id": CLIENT_ID }),
    )?;
    expect_reply(stream, Some("READY"))?;
    write_frame(
        stream,
        FRAME,
        &json!({
            "cmd": "SET_ACTIVITY",
            "args": { "pid": std::process::id(), "activity": activity.payload() },
            "nonce": uuid::Uuid::new_v4().to_string(),
        }),
    )?;
    expect_reply(stream, None)
}

/// Read Discord's answer: an `evt` of `ERROR`, or a `CLOSE` frame, is a refusal.
fn expect_reply(stream: &mut impl Read, event: Option<&str>) -> io::Result<()> {
    let (opcode, reply) = read_frame(stream)?;
    let received = reply.get("evt").and_then(Value::as_str);
    if opcode == FRAME && received != Some("ERROR") && (event.is_none() || received == event) {
        return Ok(());
    }
    Err(io::Error::other(format!("Discord refused: {reply}")))
}

/// One message, header and body, in a single write: a Windows pipe in message mode takes each
/// write as a message of its own.
fn write_frame(stream: &mut impl Write, opcode: u32, body: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(body)?;
    let length = u32::try_from(body.len()).map_err(io::Error::other)?;
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend(opcode.to_le_bytes());
    frame.extend(length.to_le_bytes());
    frame.extend(body);
    stream.write_all(&frame)
}

fn read_frame(stream: &mut impl Read) -> io::Result<(u32, Value)> {
    let mut header = [0; 8];
    stream.read_exact(&mut header)?;
    let [o0, o1, o2, o3, l0, l1, l2, l3] = header;
    let length = usize::try_from(u32::from_le_bytes([l0, l1, l2, l3])).map_err(io::Error::other)?;
    if length > REPLY_LIMIT {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized Discord reply",
        ));
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body)?;
    Ok((
        u32::from_le_bytes([o0, o1, o2, o3]),
        serde_json::from_slice(&body)?,
    ))
}

/// Discord listens on the first free of ten numbered endpoints.
fn connect() -> io::Result<Pipe> {
    let mut last = io::Error::from(io::ErrorKind::NotFound);
    for path in endpoints() {
        match open(&path) {
            Ok(pipe) => return Ok(pipe),
            Err(error) => last = error,
        }
    }
    Err(last)
}

#[cfg(windows)]
fn endpoints() -> Vec<PathBuf> {
    (0..10)
        .map(|n| PathBuf::from(format!(r"\\.\pipe\discord-ipc-{n}")))
        .collect()
}

#[cfg(windows)]
fn open(path: &std::path::Path) -> io::Result<Pipe> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
}

#[cfg(unix)]
fn endpoints() -> Vec<PathBuf> {
    ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .chain([PathBuf::from("/tmp")])
        .flat_map(|dir| (0..10).map(move |n| dir.join(format!("discord-ipc-{n}"))))
        .collect()
}

#[cfg(unix)]
fn open(path: &std::path::Path) -> io::Result<Pipe> {
    let pipe = Pipe::connect(path)?;
    pipe.set_read_timeout(Some(std::time::Duration::from_secs(5)))?;
    Ok(pipe)
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    fn activity(server: &str, map: Option<&str>) -> Activity {
        Activity {
            game: TargetGame::Spearhead,
            server: server.to_owned(),
            map: map.map(str::to_owned),
            started: UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000),
        }
    }

    fn frame(opcode: u32, body: &Value) -> Vec<u8> {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, opcode, body).expect("frame");
        bytes
    }

    /// Discord's side of the exchange: canned replies in, whatever Reveille wrote out.
    struct FakeDiscord {
        replies: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl FakeDiscord {
        fn replying(replies: &[(u32, Value)]) -> Self {
            Self {
                replies: Cursor::new(
                    replies
                        .iter()
                        .flat_map(|(op, body)| frame(*op, body))
                        .collect(),
                ),
                written: Vec::new(),
            }
        }

        fn sent(&self) -> Vec<(u32, Value)> {
            let mut written = Cursor::new(self.written.clone());
            let mut frames = Vec::new();
            while written.position() < self.written.len() as u64 {
                frames.push(read_frame(&mut written).expect("sent frame"));
            }
            frames
        }
    }

    impl Read for FakeDiscord {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.replies.read(buf)
        }
    }

    impl Write for FakeDiscord {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.written.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_frame_is_a_little_endian_opcode_and_length_before_the_json() {
        let bytes = frame(FRAME, &json!({ "a": 1 }));
        assert_eq!(&bytes[..8], &[1, 0, 0, 0, 7, 0, 0, 0]);
        assert_eq!(&bytes[8..], br#"{"a":1}"#);
    }

    #[test]
    fn the_status_names_the_game_server_and_map() {
        let payload = activity("[EU] Some Server ", Some("obj/obj_team2")).payload();
        assert_eq!(payload["details"], "Playing Spearhead");
        assert_eq!(payload["state"], "[EU] Some Server · obj/obj_team2");
        assert_eq!(payload["timestamps"]["start"], 1_700_000_000);
        assert_eq!(payload["assets"]["large_image"], LOGO_ASSET);
    }

    #[test]
    fn a_server_without_a_published_map_shows_its_name_alone() {
        let payload = activity("Some Server", None).payload();
        assert_eq!(payload["state"], "Some Server");
    }

    #[test]
    fn a_state_discord_would_reject_as_too_short_is_left_out() {
        let payload = activity(" ", None).payload();
        assert!(payload.get("state").is_none());
    }

    #[test]
    fn long_names_are_cut_to_discords_limit_on_a_character_boundary() {
        let payload = activity(&"é".repeat(200), None).payload();
        let state = payload["state"].as_str().expect("state");
        assert_eq!(state.chars().count(), TEXT_LIMIT);
    }

    #[test]
    fn a_ready_discord_receives_the_handshake_then_the_activity() {
        let mut discord = FakeDiscord::replying(&[
            (FRAME, json!({ "cmd": "DISPATCH", "evt": "READY" })),
            (FRAME, json!({ "cmd": "SET_ACTIVITY", "evt": null })),
        ]);
        set_activity(&mut discord, &activity("Some Server", None)).expect("accepted");
        let sent = discord.sent();
        assert_eq!(
            sent[0],
            (HANDSHAKE, json!({ "v": 1, "client_id": CLIENT_ID }))
        );
        assert_eq!(sent[1].0, FRAME);
        assert_eq!(sent[1].1["cmd"], "SET_ACTIVITY");
        assert_eq!(sent[1].1["args"]["activity"]["state"], "Some Server");
    }

    #[test]
    fn a_closed_handshake_is_a_refusal() {
        let mut discord =
            FakeDiscord::replying(&[(2, json!({ "code": 4000, "message": "Invalid Client ID" }))]);
        assert!(set_activity(&mut discord, &activity("Some Server", None)).is_err());
    }

    #[test]
    fn an_error_event_for_the_activity_is_a_refusal() {
        let mut discord = FakeDiscord::replying(&[
            (FRAME, json!({ "evt": "READY" })),
            (
                FRAME,
                json!({ "evt": "ERROR", "data": { "message": "bad" } }),
            ),
        ]);
        assert!(set_activity(&mut discord, &activity("Some Server", None)).is_err());
    }

    #[test]
    fn an_oversized_reply_is_refused_before_it_is_read() {
        let mut header = FRAME.to_le_bytes().to_vec();
        header.extend(u32::MAX.to_le_bytes());
        assert!(read_frame(&mut Cursor::new(header)).is_err());
    }
}
