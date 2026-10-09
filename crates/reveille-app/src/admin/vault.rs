// SPDX-License-Identifier: GPL-3.0-only

//! Where RCON passwords are kept between runs: the operating system's own credential store.
//!
//! Reveille's files hold a server's address and name, never its password. Where no store is
//! available the password lives only as long as the run.

use reveille_core::rcon::RconPassword;
use serde::Serialize;

/// The service name every entry is filed under; the server's address is the account.
#[cfg(any(windows, target_os = "macos"))]
const SERVICE: &str = "Reveille RCON";

/// Which store keeps passwords, so the page can say where they are.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultKind {
    /// Windows Credential Manager.
    CredentialManager,
    /// The macOS login keychain.
    Keychain,
    /// Nowhere: the password is asked for again on the next run.
    Memory,
}

pub const KIND: VaultKind = if cfg!(windows) {
    VaultKind::CredentialManager
} else if cfg!(target_os = "macos") {
    VaultKind::Keychain
} else {
    VaultKind::Memory
};

#[cfg(any(windows, target_os = "macos"))]
fn entry(address: &str) -> Result<keyring_core::Entry, keyring_core::Error> {
    use keyring_core::api::CredentialStoreApi;
    #[cfg(windows)]
    {
        // Local, not the default Enterprise: a server's password stays on this PC rather than
        // roaming with a domain profile.
        let modifiers = std::collections::HashMap::from([("persistence", "Local")]);
        windows_native_keyring_store::Store::new()?.build(SERVICE, address, Some(&modifiers))
    }
    #[cfg(target_os = "macos")]
    {
        apple_native_keyring_store::keychain::Store::new()?.build(SERVICE, address, None)
    }
}

/// Keep `password` for `address`. Errors carry no part of the password.
#[cfg(any(windows, target_os = "macos"))]
pub fn save(address: &str, password: &RconPassword) -> Result<(), String> {
    entry(address)
        .and_then(|entry| entry.set_password(password.expose()))
        .map_err(|error| error.to_string())
}

/// The password kept for `address`, if there is one.
#[cfg(any(windows, target_os = "macos"))]
pub fn load(address: &str) -> Option<RconPassword> {
    let password = entry(address).ok()?.get_password().ok()?;
    RconPassword::new(password).ok()
}

/// Forget the password kept for `address`. One that was never kept is already forgotten.
#[cfg(any(windows, target_os = "macos"))]
pub fn forget(address: &str) -> Result<(), String> {
    match entry(address).and_then(|entry| entry.delete_credential()) {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn save(_address: &str, _password: &RconPassword) -> Result<(), String> {
    Err("this system has no credential store Reveille can use".to_owned())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn load(_address: &str) -> Option<RconPassword> {
    None
}

#[cfg(not(any(windows, target_os = "macos")))]
#[expect(
    clippy::unnecessary_wraps,
    reason = "the same signature as the stores that can fail"
)]
pub fn forget(_address: &str) -> Result<(), String> {
    Ok(())
}
