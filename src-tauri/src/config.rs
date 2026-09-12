//! Settings, persistent state and the on-disk locations of both.
//!
//! Settings are what the user chose (the Provisioning panel edits them).
//! State is what the app remembers between passes — which lists it has
//! already processed, by content hash — and is never edited by hand.
//!
//! Both are JSON under the app's config / data directories:
//!
//!   macOS    ~/Library/Application Support/com.stoatworks.openfontmanager/
//!   Windows  %APPDATA%\com.stoatworks.openfontmanager\
//!   Linux    ~/.config/com.stoatworks.openfontmanager/  (settings)
//!            ~/.local/share/com.stoatworks.openfontmanager/  (state, log)
//!
//! `OPENFONT_HOME` overrides both directories — for the tests, and for a
//! portable install.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const APP_DIR: &str = "com.stoatworks.openfontmanager";

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceConfig {
    pub id: String,
    pub label: String,
    /// `dir` or `webdav`.
    pub kind: String,
    /// Directory path, or the WebDAV collection URL.
    pub path: String,
    #[serde(default)]
    pub username: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "yes")]
    pub install_fonts: bool,
    #[serde(default = "yes")]
    pub read_lists: bool,
}

fn yes() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub lists_dir: Option<String>,
    #[serde(default = "yes")]
    pub sync_on_startup: bool,
    /// 0 = only at startup and on demand.
    #[serde(default = "default_interval")]
    pub sync_interval_minutes: u32,
    #[serde(default)]
    pub autostart: bool,
    #[serde(default)]
    pub sources: Vec<SourceConfig>,
}

fn default_interval() -> u32 {
    60
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            lists_dir: None,
            sync_on_startup: true,
            sync_interval_minutes: 60,
            autostart: false,
            sources: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct State {
    /// list path -> sha256 of its content when it was last fully processed.
    #[serde(default)]
    pub processed_lists: BTreeMap<String, String>,
    #[serde(default)]
    pub last_sync: Option<serde_json::Value>,
}

pub struct Paths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn locate() -> Result<Paths, String> {
        if let Some(home) = std::env::var_os("OPENFONT_HOME") {
            let home = PathBuf::from(home);
            return Ok(Paths {
                config_dir: home.clone(),
                data_dir: home,
            });
        }
        let config_dir = dirs::config_dir()
            .ok_or("Could not locate the config directory.")?
            .join(APP_DIR);
        let data_dir = dirs::data_dir()
            .ok_or("Could not locate the data directory.")?
            .join(APP_DIR);
        Ok(Paths {
            config_dir,
            data_dir,
        })
    }

    pub fn settings_file(&self) -> PathBuf {
        self.config_dir.join("settings.json")
    }

    pub fn state_file(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }

    pub fn log_file(&self) -> PathBuf {
        self.data_dir.join("sync.log")
    }

    /// Where a Linux build keeps WebDAV passwords (0600), lacking a keychain.
    pub fn secrets_file(&self) -> PathBuf {
        self.config_dir.join("secrets.json")
    }
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => T::default(),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // Write-then-rename, so a crash mid-write cannot leave a half file.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Could not replace {}: {e}", path.display()))?;
    Ok(())
}

pub fn load_settings(paths: &Paths) -> Settings {
    read_json(&paths.settings_file())
}

pub fn save_settings(paths: &Paths, settings: &Settings) -> Result<(), String> {
    write_json(&paths.settings_file(), settings)
}

pub fn load_state(paths: &Paths) -> State {
    read_json(&paths.state_file())
}

pub fn save_state(paths: &Paths, state: &State) -> Result<(), String> {
    write_json(&paths.state_file(), state)
}

/// Append lines to the sync log, keeping it under about a megabyte.
pub fn append_log(paths: &Paths, lines: &[String]) {
    let path = paths.log_file();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 1_000_000 {
            let _ = fs::rename(&path, path.with_extension("log.1"));
        }
    }
    use std::io::Write;
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        for line in lines {
            let _ = writeln!(f, "{line}");
        }
    }
}

pub fn read_log_tail(paths: &Paths, lines: usize) -> String {
    let text = fs::read_to_string(paths.log_file()).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_round_trip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("openfont-cfg-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let paths = Paths {
            config_dir: dir.clone(),
            data_dir: dir.clone(),
        };
        assert_eq!(load_settings(&paths), Settings::default());
        let mut s = Settings {
            lists_dir: Some("/tmp/lists".into()),
            ..Settings::default()
        };
        s.sources.push(SourceConfig {
            id: "a".into(),
            label: "NAS".into(),
            kind: "dir".into(),
            path: "/Volumes/fonts".into(),
            username: String::new(),
            enabled: true,
            install_fonts: true,
            read_lists: false,
        });
        save_settings(&paths, &s).unwrap();
        assert_eq!(load_settings(&paths), s);

        // Unknown or missing fields fall back to defaults rather than failing.
        fs::write(
            paths.settings_file(),
            r#"{"listsDir": null, "sources": [{"id":"x","label":"x","kind":"dir","path":"/x"}]}"#,
        )
        .unwrap();
        let loaded = load_settings(&paths);
        assert_eq!(loaded.sync_interval_minutes, 60);
        assert!(loaded.sources[0].enabled && loaded.sources[0].install_fonts);

        append_log(&paths, &["one".into(), "two".into()]);
        assert_eq!(read_log_tail(&paths, 1), "two");
        let _ = fs::remove_dir_all(&dir);
    }
}
