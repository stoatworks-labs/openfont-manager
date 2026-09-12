//! WebDAV passwords.
//!
//! macOS and Windows have a keychain, and the password goes there under the
//! source's id — never into settings.json, which is plain text a user may
//! well copy into a bug report. Linux has no dependable equivalent that
//! builds without desktop libraries, so there the password lives in
//! `secrets.json` next to the settings, mode 0600, and the UI says so.

use crate::config::Paths;

const SERVICE: &str = "com.stoatworks.openfontmanager";

#[cfg(any(target_os = "macos", windows))]
pub fn set(_paths: &Paths, id: &str, password: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, id).map_err(|e| e.to_string())?;
    if password.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    } else {
        entry.set_password(password).map_err(|e| e.to_string())
    }
}

#[cfg(any(target_os = "macos", windows))]
pub fn get(_paths: &Paths, id: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, id).ok()?.get_password().ok()
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn set(paths: &Paths, id: &str, password: &str) -> Result<(), String> {
    use std::collections::BTreeMap;
    let file = paths.secrets_file();
    let mut map: BTreeMap<String, String> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if password.is_empty() {
        map.remove(id);
    } else {
        map.insert(id.to_string(), password.to_string());
    }
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(
        &file,
        serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600));
    }
    let _ = SERVICE;
    Ok(())
}

#[cfg(not(any(target_os = "macos", windows)))]
pub fn get(paths: &Paths, id: &str) -> Option<String> {
    use std::collections::BTreeMap;
    let map: BTreeMap<String, String> =
        serde_json::from_str(&std::fs::read_to_string(paths.secrets_file()).ok()?).ok()?;
    map.get(id).cloned()
}
