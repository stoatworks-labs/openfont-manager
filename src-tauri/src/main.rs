// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use openfont_manager_lib::{config, fonts, lists, provision};

const USAGE: &str = "OpenFont Manager

  openfont-manager                     open the window
  openfont-manager <list.csv|xml|txt>  open the window with a list loaded
  openfont-manager --background        start hidden in the tray (what the login item runs)
  openfont-manager --sync              run one provisioning pass with no window, then exit
  openfont-manager --install <list>    fetch and install the fonts a list names, then exit
  openfont-manager --help

Environment:
  OPENFONT_INSTALL_DIR   install fonts here instead of the per-user font folder
  OPENFONT_HOME          keep settings, state and the log here
";

/// A headless pass. Exit code 1 if anything failed, so a script can tell.
fn headless_sync() -> i32 {
    let paths = match config::Paths::locate() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("openfont-manager: {e}");
            return 2;
        }
    };
    let settings = config::load_settings(&paths);
    let mut state = config::load_state(&paths);
    let ctx = match context(paths) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("openfont-manager: {e}");
            return 2;
        }
    };
    let report = provision::run_pass(&ctx, &settings, &mut state, "cli");
    if report.failed > 0 {
        1
    } else {
        0
    }
}

/// Install one list, headless, without touching the watched-folder state.
fn headless_install(path: &str) -> i32 {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("openfont-manager: could not read {path}: {e}");
            return 2;
        }
    };
    let paths = match config::Paths::locate() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("openfont-manager: {e}");
            return 2;
        }
    };
    let ctx = match context(paths) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("openfont-manager: {e}");
            return 2;
        }
    };
    let parsed = lists::parse_list(&text, path);
    for e in &parsed.errors {
        eprintln!("  {e}");
    }
    // One-off settings: this list is the only source.
    let dir = std::env::temp_dir().join(format!("openfont-install-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let copy = dir.join(std::path::Path::new(path).file_name().unwrap_or_default());
    if std::fs::write(&copy, &text).is_err() {
        eprintln!("openfont-manager: could not stage the list");
        return 2;
    }
    let settings = config::Settings {
        lists_dir: Some(dir.display().to_string()),
        ..config::Settings::default()
    };
    let mut state = config::State::default();
    let report = provision::run_pass(&ctx, &settings, &mut state, "install");
    let _ = std::fs::remove_dir_all(&dir);
    if report.failed > 0 || !report.families_unresolved.is_empty() {
        1
    } else {
        0
    }
}

fn context(paths: config::Paths) -> Result<provision::Context, String> {
    Ok(provision::Context {
        paths,
        install_dir: fonts::default_install_dir()?,
        register: true,
        cancel: Arc::new(AtomicBool::new(false)),
        on_line: Box::new(|line| println!("{line}")),
    })
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{USAGE}");
        return;
    }
    if args.iter().any(|a| a == "--sync") {
        std::process::exit(headless_sync());
    }
    if let Some(i) = args.iter().position(|a| a == "--install") {
        match args.get(i + 1) {
            Some(path) => std::process::exit(headless_install(path)),
            None => {
                eprintln!("--install needs a list file");
                std::process::exit(2);
            }
        }
    }
    let background = args.iter().any(|a| a == "--background");
    let pending = openfont_manager_lib::read_list_arg(&args);
    openfont_manager_lib::run(background, pending)
}
