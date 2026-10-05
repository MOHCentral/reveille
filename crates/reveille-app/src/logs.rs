// SPDX-License-Identifier: GPL-3.0-only

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;
use thiserror::Error;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

const APP_LOG_FILENAME: &str = "reveille.log";
const PREVIOUS_APP_LOG_FILENAME: &str = "reveille.previous.log";

#[derive(Serialize)]
pub struct AppLogFiles {
    current: String,
    previous: String,
}

#[derive(Debug, Error)]
enum AppLoggingError {
    #[error("could not access the app log at {path}")]
    Filesystem {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("could not install the app log subscriber: {0}")]
    Subscriber(String),
}

#[tauri::command]
#[expect(
    clippy::needless_pass_by_value,
    reason = "Tauri resolves the app handle only for by-value command parameters"
)]
pub fn app_log_files(app: tauri::AppHandle) -> Result<AppLogFiles, String> {
    let directory = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    let (current, previous) = app_log_paths(&directory);
    Ok(AppLogFiles {
        current: current.to_string_lossy().into_owned(),
        previous: previous.to_string_lossy().into_owned(),
    })
}

fn app_log_paths(directory: &Path) -> (PathBuf, PathBuf) {
    (
        directory.join(APP_LOG_FILENAME),
        directory.join(PREVIOUS_APP_LOG_FILENAME),
    )
}

fn prepare_app_log(directory: &Path) -> Result<(fs::File, PathBuf), AppLoggingError> {
    fs::create_dir_all(directory).map_err(|source| AppLoggingError::Filesystem {
        path: directory.to_path_buf(),
        source,
    })?;
    let (current, previous) = app_log_paths(directory);
    let current_exists = current
        .try_exists()
        .map_err(|source| AppLoggingError::Filesystem {
            path: current.clone(),
            source,
        })?;
    if current_exists {
        match fs::remove_file(&previous) {
            Ok(()) => {}
            Err(source) if source.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(AppLoggingError::Filesystem {
                    path: previous,
                    source,
                });
            }
        }
        fs::rename(&current, &previous).map_err(|source| AppLoggingError::Filesystem {
            path: current.clone(),
            source,
        })?;
    }
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&current)
        .map_err(|source| AppLoggingError::Filesystem {
            path: current.clone(),
            source,
        })?;
    Ok((file, current))
}

fn logging_filter() -> EnvFilter {
    EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn,reveille=info"))
}

fn init_logging(directory: &Path) -> Result<PathBuf, AppLoggingError> {
    let (file, path) = prepare_app_log(directory)?;
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_env_filter(logging_filter())
        .with_writer(file)
        .try_init()
        .map_err(|error| AppLoggingError::Subscriber(error.to_string()))?;
    Ok(path)
}

fn init_stderr_logging() {
    let filter =
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("warn,reveille=info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

pub fn init(app: &tauri::App) {
    match app.path().app_log_dir() {
        Ok(directory) => match init_logging(&directory) {
            Ok(path) => info!(log_path = %path.display(), "starting Reveille app shell"),
            Err(error) => {
                init_stderr_logging();
                warn!(%error, "persistent app logging is unavailable");
            }
        },
        Err(error) => {
            init_stderr_logging();
            warn!(%error, "could not resolve the app log directory");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::Write as _;

    use tempfile::TempDir;

    use super::{APP_LOG_FILENAME, PREVIOUS_APP_LOG_FILENAME, prepare_app_log};

    #[test]
    fn app_logging_retains_the_previous_session() {
        let directory = TempDir::new().expect("temporary log directory");
        let current = directory.path().join(APP_LOG_FILENAME);
        fs::write(&current, "previous session\n").expect("seed current log");

        let (mut file, path) = prepare_app_log(directory.path()).expect("prepare app log");
        file.write_all(b"current session\n")
            .expect("write current log");
        drop(file);

        assert_eq!(path, current);
        assert_eq!(
            fs::read_to_string(directory.path().join(PREVIOUS_APP_LOG_FILENAME))
                .expect("read previous log"),
            "previous session\n"
        );
        assert_eq!(
            fs::read_to_string(current).expect("read current log"),
            "current session\n"
        );
    }
}
