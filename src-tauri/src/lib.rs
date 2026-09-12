//! OpenFont Manager — desktop shell.
//!
//! The web app in a window, plus the four things a web page cannot do:
//! install fonts, start at login, watch a folder, read a share. The window is
//! optional — the app lives in the tray, runs a sync pass at startup and on a
//! timer, and `--sync` runs one with no window at all.

pub mod catalogue;
pub mod config;
pub mod download;
pub mod fonts;
pub mod lists;
pub mod provision;
pub mod secrets;
pub mod webdav;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::DialogExt;

use config::{Paths, Settings, SourceConfig};
use download::{Item, Progress};
use provision::SyncReport;

pub struct AppState {
    pub paths: Paths,
    pub settings: Mutex<Settings>,
    pub state: Mutex<config::State>,
    pub syncing: AtomicBool,
    /// Set to stop the current download or sync; cleared when it ends.
    pub cancel: Arc<AtomicBool>,
    pub last_report: Mutex<Option<SyncReport>>,
    /// A list handed over on the command line, waiting for the window.
    pub pending_list: Mutex<Option<(String, String)>>,
    pub last_run: Mutex<Option<Instant>>,
}

impl AppState {
    pub fn load(pending_list: Option<(String, String)>) -> Result<AppState, String> {
        let paths = Paths::locate()?;
        let settings = config::load_settings(&paths);
        let state = config::load_state(&paths);
        let last_report = state
            .last_sync
            .clone()
            .and_then(|v| serde_json::from_value(v).ok());
        Ok(AppState {
            paths,
            settings: Mutex::new(settings),
            state: Mutex::new(state),
            syncing: AtomicBool::new(false),
            cancel: Arc::new(AtomicBool::new(false)),
            last_report: Mutex::new(last_report),
            pending_list: Mutex::new(pending_list),
            last_run: Mutex::new(None),
        })
    }

    fn context(&self, app: Option<AppHandle>) -> Result<provision::Context, String> {
        Ok(provision::Context {
            paths: Paths::locate()?,
            install_dir: fonts::default_install_dir()?,
            register: true,
            cancel: Arc::clone(&self.cancel),
            on_line: Box::new(move |line| {
                if let Some(app) = &app {
                    let _ = app.emit("sync-line", line);
                }
            }),
        })
    }
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */

/// Run one pass. Refuses to overlap with a running one.
pub fn run_sync(app: &AppHandle, trigger: &str) -> Result<SyncReport, String> {
    let st = app.state::<AppState>();
    if st.syncing.swap(true, Ordering::SeqCst) {
        return Err("A sync is already running.".into());
    }
    st.cancel.store(false, Ordering::SeqCst);
    let settings = st.settings.lock().unwrap().clone();
    let result = (|| {
        let ctx = st.context(Some(app.clone()))?;
        let mut state = st.state.lock().unwrap();
        Ok::<_, String>(provision::run_pass(&ctx, &settings, &mut state, trigger))
    })();
    st.syncing.store(false, Ordering::SeqCst);
    st.cancel.store(false, Ordering::SeqCst);
    *st.last_run.lock().unwrap() = Some(Instant::now());
    match result {
        Ok(report) => {
            *st.last_report.lock().unwrap() = Some(report.clone());
            let _ = app.emit("sync-report", &report);
            Ok(report)
        }
        Err(e) => {
            let _ = app.emit("sync-line", &format!("sync failed: {e}"));
            Err(e)
        }
    }
}

/// Startup pass plus the interval timer, on its own thread.
fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        let st = app.state::<AppState>();
        let on_startup = st.settings.lock().unwrap().sync_on_startup;
        if on_startup {
            // Give the network a moment after login before the first pull.
            std::thread::sleep(Duration::from_secs(8));
            let _ = run_sync(&app, "startup");
        }
        loop {
            std::thread::sleep(Duration::from_secs(30));
            let minutes = st.settings.lock().unwrap().sync_interval_minutes;
            if minutes == 0 {
                continue;
            }
            let due = st.last_run.lock().unwrap().map_or(true, |t| {
                t.elapsed() >= Duration::from_secs(u64::from(minutes) * 60)
            });
            if due && !st.syncing.load(Ordering::SeqCst) {
                let _ = run_sync(&app, "interval");
            }
        }
    });
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    version: String,
    install_dir: String,
    config_path: String,
    state_path: String,
    log_path: String,
    autostart_enabled: bool,
    syncing: bool,
    last_sync: Option<SyncReport>,
}

#[tauri::command]
fn get_settings(st: State<AppState>) -> Settings {
    st.settings.lock().unwrap().clone()
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    st: State<AppState>,
    settings: Settings,
) -> Result<Settings, String> {
    config::save_settings(&st.paths, &settings)?;
    // Autostart is an OS registration, applied here so the checkbox and the
    // registry can never disagree for long.
    let launcher = app.autolaunch();
    let enabled = launcher.is_enabled().unwrap_or(false);
    if settings.autostart && !enabled {
        launcher
            .enable()
            .map_err(|e| format!("Could not register the login item: {e}"))?;
    } else if !settings.autostart && enabled {
        launcher
            .disable()
            .map_err(|e| format!("Could not remove the login item: {e}"))?;
    }
    *st.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

#[tauri::command]
fn get_status(app: AppHandle, st: State<AppState>) -> Result<Status, String> {
    Ok(Status {
        version: env!("CARGO_PKG_VERSION").to_string(),
        install_dir: fonts::default_install_dir()?.display().to_string(),
        config_path: st.paths.settings_file().display().to_string(),
        state_path: st.paths.state_file().display().to_string(),
        log_path: st.paths.log_file().display().to_string(),
        autostart_enabled: app.autolaunch().is_enabled().unwrap_or(false),
        syncing: st.syncing.load(Ordering::SeqCst),
        last_sync: st.last_report.lock().unwrap().clone(),
    })
}

#[tauri::command]
async fn sync_now(app: AppHandle) -> Result<SyncReport, String> {
    tauri::async_runtime::spawn_blocking(move || run_sync(&app, "manual"))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn install_plan(app: AppHandle, items: Vec<Item>) -> Result<fonts::InstallReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        st.cancel.store(false, Ordering::SeqCst);
        let ctx = st.context(None)?;
        let emitter = app.clone();
        let (mut report, failures) =
            provision::download_and_install(&ctx, items, move |p: &Progress| {
                let _ = emitter.emit("download-progress", p);
            })?;
        for (item, e) in failures {
            report.failed += 1;
            report.outcomes.push(fonts::InstallOutcome {
                filename: format!("{} / {}", item.family, item.filename),
                status: "failed".into(),
                detail: Some(e),
                path: None,
            });
        }
        st.cancel.store(false, Ordering::SeqCst);
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveReport {
    dir: String,
    saved: usize,
    failed: usize,
    failures: Vec<SaveFailure>,
}

#[derive(Serialize)]
struct SaveFailure {
    filename: String,
    error: String,
}

/// Download a plan into `dest/<Family>/<file>`, with each family's licence
/// text alongside — the desktop equivalent of the browser's zip.
#[tauri::command]
async fn save_plan(app: AppHandle, items: Vec<Item>, dest: String) -> Result<SaveReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        st.cancel.store(false, Ordering::SeqCst);
        let dest = PathBuf::from(&dest);
        std::fs::create_dir_all(&dest)
            .map_err(|e| format!("Could not create {}: {e}", dest.display()))?;
        let client = download::client()?;
        let cancel = Arc::clone(&st.cancel);
        let emitter = app.clone();
        let dest_for_work = dest.clone();
        let outcomes = download::run_pool(
            items.clone(),
            4,
            Arc::clone(&st.cancel),
            move |item| {
                let mut urls = vec![item.url.clone()];
                urls.extend(item.mirrors.iter().cloned());
                let fetched = download::fetch_bytes(&client, &urls, true, 3, &cancel)?;
                let name = fonts::safe_filename(&item.filename)?;
                let folder = dest_for_work.join(family_folder(&item.family));
                std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
                std::fs::write(folder.join(name), &fetched.data).map_err(|e| e.to_string())?;
                Ok(fetched.data.len() as u64)
            },
            |n| *n,
            move |p: &Progress| {
                let _ = emitter.emit("download-progress", p);
            },
        );
        // Licence texts, best effort, once per family.
        let client = download::client()?;
        let mut seen = std::collections::HashSet::new();
        for item in &items {
            if !seen.insert(item.family_id.clone()) || st.cancel.load(Ordering::SeqCst) {
                continue;
            }
            if let Some(url) = catalogue::by_id(&item.family_id).and_then(|f| f.license_url.clone())
            {
                if let Ok(f) =
                    download::fetch_bytes(&client, std::slice::from_ref(&url), false, 1, &st.cancel)
                {
                    let name = url.rsplit('/').next().unwrap_or("LICENSE.txt");
                    let name = if name.ends_with(".txt") {
                        name.to_string()
                    } else {
                        format!("{name}.txt")
                    };
                    let folder = dest.join(family_folder(&item.family));
                    let _ = std::fs::create_dir_all(&folder);
                    let _ = std::fs::write(folder.join(name), &f.data);
                }
            }
        }
        st.cancel.store(false, Ordering::SeqCst);
        let mut report = SaveReport {
            dir: dest.display().to_string(),
            saved: 0,
            failed: 0,
            failures: Vec::new(),
        };
        for o in outcomes {
            match o.result {
                Ok(_) => report.saved += 1,
                Err(e) => {
                    report.failed += 1;
                    report.failures.push(SaveFailure {
                        filename: format!("{} / {}", o.item.family, o.item.filename),
                        error: e,
                    });
                }
            }
        }
        Ok(report)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A filesystem-safe folder name for a family — same rule as the zip's.
fn family_folder(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() {
        "Font".into()
    } else {
        trimmed
    }
}

#[tauri::command]
async fn pick_directory(app: AppHandle, title: String) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().set_title(&title).pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked.and_then(|p| p.as_path().map(|p| p.display().to_string())))
}

#[tauri::command]
async fn installed_families() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(fonts::installed_families)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_log(st: State<AppState>, lines: usize) -> String {
    config::read_log_tail(&st.paths, lines.clamp(1, 5000))
}

#[tauri::command]
async fn probe_source(app: AppHandle, source: SourceConfig) -> Result<provision::Probe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let st = app.state::<AppState>();
        Ok(provision::probe(&st.paths, &source))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn set_source_password(st: State<AppState>, id: String, password: String) -> Result<(), String> {
    secrets::set(&st.paths, &id, &password)
}

#[tauri::command]
fn has_source_password(st: State<AppState>, id: String) -> bool {
    secrets::get(&st.paths, &id).is_some()
}

#[tauri::command]
fn cancel_download(st: State<AppState>) {
    st.cancel.store(true, Ordering::SeqCst);
}

#[derive(Serialize, Clone)]
struct PendingList {
    name: String,
    text: String,
}

/// The list given on the command line, if any — asked for once by the window.
#[tauri::command]
fn take_pending_list(st: State<AppState>) -> Option<PendingList> {
    st.pending_list
        .lock()
        .unwrap()
        .take()
        .map(|(name, text)| PendingList { name, text })
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Read a list file named on the command line, for the importer.
pub fn read_list_arg(args: &[String]) -> Option<(String, String)> {
    let path = args.iter().skip(1).find(|a| !a.starts_with("--"))?;
    let p = PathBuf::from(path);
    if !lists::is_list_filename(&p.to_string_lossy()) || !p.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&p).ok()?;
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Some((name, text))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(background: bool, pending_list: Option<(String, String)>) {
    let app_state = match AppState::load(pending_list) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("openfont-manager: {e}");
            std::process::exit(1);
        }
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A second launch — from the Dock, or with a list file — lands here.
            if let Some(list) = read_list_arg(&args) {
                *app.state::<AppState>().pending_list.lock().unwrap() = Some(list.clone());
                let _ = app.emit(
                    "open-list",
                    PendingList {
                        name: list.0,
                        text: list.1,
                    },
                );
            }
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_status,
            sync_now,
            install_plan,
            save_plan,
            pick_directory,
            installed_families,
            open_path,
            read_log,
            probe_source,
            set_source_password,
            has_source_password,
            cancel_download,
            take_pending_list,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Keep the login item in step with the setting, in case the
            // registration was removed behind our back.
            {
                let st = app.state::<AppState>();
                let want = st.settings.lock().unwrap().autostart;
                let launcher = app.autolaunch();
                if want && !launcher.is_enabled().unwrap_or(false) {
                    let _ = launcher.enable();
                }
            }

            let open = MenuItem::with_id(app, "open", "Open OpenFont Manager", true, None::<&str>)?;
            let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &sync, &quit])?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("OpenFont Manager")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "sync" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let _ = run_sync(&app, "tray");
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if !background {
                show_main(&handle);
            }
            start_scheduler(handle);
            Ok(())
        })
        // Closing the window hides it; the tray keeps the app (and its timer) alive.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Cmd+Q / the Dock's Quit hides to the tray too; only the tray's own
            // Quit (which carries an exit code) actually ends the process.
            RunEvent::ExitRequested {
                api, code: None, ..
            } => {
                api.prevent_exit();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            // A list dropped on the Dock icon or opened with the app. macOS
            // delivers these as Apple events, never as argv.
            #[cfg(target_os = "macos")]
            RunEvent::Opened { urls } => {
                for url in urls {
                    let Ok(path) = url.to_file_path() else {
                        continue;
                    };
                    let args = vec![String::new(), path.display().to_string()];
                    if let Some(list) = read_list_arg(&args) {
                        *app.state::<AppState>().pending_list.lock().unwrap() = Some(list.clone());
                        let _ = app.emit(
                            "open-list",
                            PendingList {
                                name: list.0,
                                text: list.1,
                            },
                        );
                    }
                }
                show_main(app);
            }
            _ => {}
        });
}
