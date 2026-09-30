// SPDX-License-Identifier: GPL-3.0-only

//! Start Reveille when the player signs in, straight to the tray, so watches survive a restart.
//!
//! Each platform's own per-user mechanism is written directly — a `Run` value on Windows, a launch
//! agent on macOS, an XDG autostart entry elsewhere — because the autostart plugin would pull a
//! second generation of several crates into a graph that `cargo deny` keeps to one.

#[cfg(not(windows))]
use std::io;
#[cfg(not(windows))]
use std::path::PathBuf;

/// Passed by the sign-in entry, so a launch the player did not start opens hidden.
pub const BACKGROUND_ARG: &str = "--background";

#[tauri::command]
pub fn start_at_login() -> Result<bool, String> {
    imp::enabled().map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_start_at_login(enabled: bool) -> Result<(), String> {
    let result = if enabled {
        std::env::current_exe().and_then(|exe| imp::enable(&exe))
    } else {
        imp::disable()
    };
    result.map_err(|error| error.to_string())
}

pub fn in_background() -> bool {
    std::env::args().skip(1).any(|arg| arg == BACKGROUND_ARG)
}

#[cfg(windows)]
mod imp {
    use std::io;
    use std::os::windows::process::CommandExt as _;
    use std::path::Path;
    use std::process::Command;

    use super::BACKGROUND_ARG;

    const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    const VALUE: &str = "Reveille";
    /// learn.microsoft.com/windows/win32/procthread/process-creation-flags
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    fn reg(args: &[&str]) -> io::Result<bool> {
        let status = Command::new("reg")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()?
            .status;
        Ok(status.success())
    }

    pub fn enabled() -> io::Result<bool> {
        reg(&["query", RUN_KEY, "/v", VALUE])
    }

    pub fn enable(exe: &Path) -> io::Result<()> {
        let command = format!("\"{}\" {BACKGROUND_ARG}", exe.display());
        if reg(&[
            "add", RUN_KEY, "/v", VALUE, "/t", "REG_SZ", "/d", &command, "/f",
        ])? {
            Ok(())
        } else {
            Err(io::Error::other("Windows refused the sign-in entry"))
        }
    }

    pub fn disable() -> io::Result<()> {
        if !enabled()? {
            return Ok(());
        }
        if reg(&["delete", RUN_KEY, "/v", VALUE, "/f"])? {
            Ok(())
        } else {
            Err(io::Error::other(
                "Windows refused to remove the sign-in entry",
            ))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use std::fs;
    use std::io;
    use std::path::Path;

    use super::{BACKGROUND_ARG, entry_path};

    pub fn enabled() -> io::Result<bool> {
        Ok(entry_path()?.is_file())
    }

    pub fn enable(exe: &Path) -> io::Result<()> {
        let path = entry_path()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, entry(exe)?)
    }

    pub fn disable() -> io::Result<()> {
        match fs::remove_file(entry_path()?) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }

    fn exe_text(exe: &Path) -> io::Result<&str> {
        exe.to_str()
            .ok_or_else(|| io::Error::other("Reveille's path is not valid Unicode"))
    }

    #[cfg(target_os = "macos")]
    fn entry(exe: &Path) -> io::Result<String> {
        let escaped = exe_text(exe)?
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;");
        Ok(format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>org.reveille.launcher</string>
  <key>ProgramArguments</key>
  <array>
    <string>{escaped}</string>
    <string>{BACKGROUND_ARG}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
        ))
    }

    /// specifications.freedesktop.org/desktop-entry-spec — `Exec` arguments are quoted, with `"`,
    /// `` ` ``, `$` and `\` escaped inside the quotes and `%` doubled.
    #[cfg(not(target_os = "macos"))]
    fn entry(exe: &Path) -> io::Result<String> {
        let mut quoted = String::new();
        for character in exe_text(exe)?.chars() {
            match character {
                '"' | '`' | '$' | '\\' => {
                    quoted.push('\\');
                    quoted.push(character);
                }
                '%' => quoted.push_str("%%"),
                _ => quoted.push(character),
            }
        }
        Ok(format!(
            "[Desktop Entry]\nType=Application\nName=Reveille\nExec=\"{quoted}\" {BACKGROUND_ARG}\nX-GNOME-Autostart-enabled=true\n"
        ))
    }
}

#[cfg(not(windows))]
fn entry_path() -> io::Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::other("no home folder to add a sign-in entry to"))?;
    #[cfg(target_os = "macos")]
    return Ok(home.join("Library/LaunchAgents/org.reveille.launcher.plist"));
    #[cfg(not(target_os = "macos"))]
    Ok(std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".config"))
        .join("autostart/org.reveille.launcher.desktop"))
}
