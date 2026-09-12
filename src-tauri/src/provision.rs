//! The sync pass: read every list and source, install what is new.
//!
//! Runs at startup (when enabled), on a timer, from the tray, and from the
//! `--sync` command line. It is idempotent by construction — a font already
//! in the install directory is never downloaded again, and a list is
//! remembered by content hash once every file it named came down — so
//! running it every hour costs a directory walk and nothing else.
//!
//! Additive only: a font removed from a share is not uninstalled. Taking
//! fonts away from a machine is a decision, not a side effect of a sync.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::catalogue::{self, Source};
use crate::config::{self, Paths, Settings, SourceConfig, State};
use crate::download::{self, Item};
use crate::fonts::{self, FontFile};
use crate::lists;
use crate::secrets;
use crate::webdav::Dav;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub started_at: String,
    pub finished_at: String,
    pub trigger: String,
    pub lists_seen: usize,
    pub lists_processed: usize,
    pub families_requested: usize,
    pub families_unresolved: Vec<String>,
    pub files_downloaded: usize,
    pub installed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub log: Vec<String>,
}

pub struct Context {
    pub paths: Paths,
    pub install_dir: PathBuf,
    /// False only in tests: never register a temp directory's fonts with the OS.
    pub register: bool,
    pub cancel: Arc<AtomicBool>,
    /// Called with every log line as it happens (the UI shows them live).
    pub on_line: Box<dyn Fn(&str) + Send + Sync>,
}

/// A list found somewhere, with a way to read it.
struct ListRef {
    key: String,
    name: String,
    text: String,
}

/// A font file found on a source, with a way to read it.
struct FontRef {
    name: String,
    origin: String,
    read: Box<dyn FnOnce() -> Result<Vec<u8>, String>>,
}

fn now() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    format!("{:x}", h.finalize())
}

fn is_hidden(name: &str) -> bool {
    // `.DS_Store`, and the `._Foo.ttf` AppleDouble files macOS leaves on SMB
    // shares — which look like fonts by extension and are not.
    name.starts_with('.')
}

/// Files under `dir`, depth-first, at most `max_depth` levels down.
pub fn walk_dir(dir: &Path, max_depth: usize) -> Vec<PathBuf> {
    fn go(dir: &Path, depth: usize, max_depth: usize, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().to_string();
            if is_hidden(&name) {
                continue;
            }
            let path = e.path();
            let Ok(meta) = e.metadata() else { continue };
            if meta.is_dir() {
                if depth < max_depth {
                    go(&path, depth + 1, max_depth, out);
                }
            } else if meta.is_file() {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    go(dir, 0, max_depth, &mut out);
    out
}

struct Gathered {
    lists: Vec<ListRef>,
    fonts: Vec<FontRef>,
    notes: Vec<String>,
}

fn gather(settings: &Settings, paths: &Paths, cancel: &AtomicBool) -> Gathered {
    let mut g = Gathered {
        lists: Vec::new(),
        fonts: Vec::new(),
        notes: Vec::new(),
    };

    let dir_lists = |dir: &Path, label: &str, g: &mut Gathered| {
        if !dir.is_dir() {
            g.notes.push(format!(
                "{label}: {} is not a readable folder",
                dir.display()
            ));
            return;
        }
        for path in walk_dir(dir, 4) {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            if !lists::is_list_filename(&name) {
                continue;
            }
            match std::fs::read_to_string(&path) {
                Ok(text) => g.lists.push(ListRef {
                    key: path.display().to_string(),
                    name,
                    text,
                }),
                Err(e) => g
                    .notes
                    .push(format!("{label}: could not read {}: {e}", path.display())),
            }
        }
    };

    if let Some(dir) = &settings.lists_dir {
        dir_lists(Path::new(dir), "watched folder", &mut g);
    }

    for src in settings.sources.iter().filter(|s| s.enabled) {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        match src.kind.as_str() {
            "dir" => {
                let dir = Path::new(&src.path);
                if src.read_lists {
                    dir_lists(dir, &src.label, &mut g);
                }
                if src.install_fonts {
                    if !dir.is_dir() {
                        if !src.read_lists {
                            g.notes.push(format!(
                                "{}: {} is not a readable folder",
                                src.label,
                                dir.display()
                            ));
                        }
                        continue;
                    }
                    for path in walk_dir(dir, 6) {
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().to_string())
                            .unwrap_or_default();
                        if !fonts::is_font_filename(&name) {
                            continue;
                        }
                        let p = path.clone();
                        g.fonts.push(FontRef {
                            name,
                            origin: src.label.clone(),
                            read: Box::new(move || std::fs::read(&p).map_err(|e| e.to_string())),
                        });
                    }
                }
            }
            "webdav" => {
                let password = secrets::get(paths, &src.id);
                let dav = match Dav::new(&src.path, Some(&src.username), password.as_deref()) {
                    Ok(d) => Arc::new(d),
                    Err(e) => {
                        g.notes.push(format!("{}: {e}", src.label));
                        continue;
                    }
                };
                let entries = match dav.walk(cancel) {
                    Ok(e) => e,
                    Err(e) => {
                        g.notes.push(format!("{}: {e}", src.label));
                        continue;
                    }
                };
                for entry in entries {
                    if is_hidden(&entry.name) {
                        continue;
                    }
                    if src.read_lists && lists::is_list_filename(&entry.name) {
                        match dav.get(&entry.url) {
                            Ok(bytes) => g.lists.push(ListRef {
                                key: entry.url.clone(),
                                name: entry.name.clone(),
                                text: String::from_utf8_lossy(&bytes).into_owned(),
                            }),
                            Err(e) => g
                                .notes
                                .push(format!("{}: could not read {}: {e}", src.label, entry.rel)),
                        }
                    } else if src.install_fonts && fonts::is_font_filename(&entry.name) {
                        let dav = Arc::clone(&dav);
                        let url = entry.url.clone();
                        g.fonts.push(FontRef {
                            name: entry.name,
                            origin: src.label.clone(),
                            read: Box::new(move || dav.get(&url)),
                        });
                    }
                }
            }
            other => g
                .notes
                .push(format!("{}: unknown source kind `{other}`", src.label)),
        }
    }
    g
}

/// Resolve a list's entries into download items, skipping files already
/// installed. Returns the items, the unresolved names, and how many families
/// resolved.
fn plan_for(entries: &[lists::Entry], install_dir: &Path) -> (Vec<Item>, Vec<String>, usize) {
    let mut items = Vec::new();
    let mut unresolved = Vec::new();
    let mut families = 0;
    let mut seen = std::collections::HashSet::new();
    for e in entries {
        let source = match e.source.as_str() {
            "google" => Some(Source::Google),
            "fontsource" => Some(Source::Fontsource),
            _ => None,
        };
        let Some(family) = catalogue::find(&e.family, source) else {
            unresolved.push(e.family.clone());
            continue;
        };
        if family.files.is_empty() {
            unresolved.push(e.family.clone());
            continue;
        }
        families += 1;
        for f in catalogue::select_files(family, e.weights.as_deref(), e.italics) {
            if !seen.insert(f.filename.clone())
                || fonts::already_installed(install_dir, &f.filename)
            {
                continue;
            }
            items.push(Item {
                family: family.name.clone(),
                family_id: family.id.clone(),
                source: if family.source == Source::Google {
                    "google".into()
                } else {
                    "fontsource".into()
                },
                license: family.license.clone(),
                filename: f.filename,
                url: f.url,
                mirrors: f.mirrors,
                weight: f.weight,
                italic: f.italic,
                variable: f.variable,
            });
        }
    }
    (items, unresolved, families)
}

/// Download a plan and install it. Used by the pass and by the cart's
/// "Install" button, which is the same operation minus the list.
pub fn download_and_install(
    ctx: &Context,
    items: Vec<Item>,
    on_progress: impl Fn(&download::Progress) + Send + Sync + 'static,
) -> Result<(fonts::InstallReport, Vec<(Item, String)>), String> {
    let client = download::client()?;
    let cancel = Arc::clone(&ctx.cancel);
    let outcomes = download::run_pool(
        items,
        4,
        Arc::clone(&ctx.cancel),
        move |item| {
            let mut urls = vec![item.url.clone()];
            urls.extend(item.mirrors.iter().cloned());
            download::fetch_bytes(&client, &urls, true, 3, &cancel).map(|f| f.data)
        },
        |data| data.len() as u64,
        on_progress,
    );
    let mut files = Vec::new();
    let mut failures = Vec::new();
    for o in outcomes {
        match o.result {
            Ok(data) => files.push(FontFile {
                filename: o.item.filename.clone(),
                data,
            }),
            Err(e) => failures.push((o.item, e)),
        }
    }
    let report = fonts::install_fonts(&ctx.install_dir, files, ctx.register)?;
    Ok((report, failures))
}

pub fn run_pass(
    ctx: &Context,
    settings: &Settings,
    state: &mut State,
    trigger: &str,
) -> SyncReport {
    let mut report = SyncReport {
        started_at: now(),
        trigger: trigger.to_string(),
        ..Default::default()
    };
    let log = |report: &mut SyncReport, line: String| {
        (ctx.on_line)(&line);
        report.log.push(line);
    };

    let started = format!(
        "[{}] sync started ({trigger}); installing to {}",
        report.started_at,
        ctx.install_dir.display()
    );
    log(&mut report, started);
    let gathered = gather(settings, &ctx.paths, &ctx.cancel);
    for n in &gathered.notes {
        log(&mut report, format!("  ! {n}"));
    }
    report.lists_seen = gathered.lists.len();
    log(
        &mut report,
        format!(
            "  {} list(s) and {} font file(s) found across the watched folder and sources",
            gathered.lists.len(),
            gathered.fonts.len()
        ),
    );

    // Lists first: they may name families whose files a share also carries,
    // and either way the second copy is skipped as already installed.
    for list in &gathered.lists {
        if ctx.cancel.load(Ordering::Relaxed) {
            log(&mut report, "  cancelled".into());
            break;
        }
        let hash = sha256_hex(list.text.as_bytes());
        if state.processed_lists.get(&list.key) == Some(&hash) {
            continue;
        }
        let parsed = lists::parse_list(&list.text, &list.name);
        for e in &parsed.errors {
            log(&mut report, format!("  {}: {e}", list.name));
        }
        let (items, unresolved, families) = plan_for(&parsed.entries, &ctx.install_dir);
        report.lists_processed += 1;
        report.families_requested += families;
        for u in &unresolved {
            if !report.families_unresolved.contains(u) {
                report.families_unresolved.push(u.clone());
            }
        }
        log(
            &mut report,
            format!(
                "  {}: {} entr{}, {} resolved, {} not in any catalogue, {} file(s) to fetch",
                list.name,
                parsed.entries.len(),
                if parsed.entries.len() == 1 {
                    "y"
                } else {
                    "ies"
                },
                families,
                unresolved.len(),
                items.len()
            ),
        );
        if !unresolved.is_empty() {
            log(
                &mut report,
                format!("    not found: {}", unresolved.join(", ")),
            );
        }
        let mut clean = true;
        if !items.is_empty() {
            match download_and_install(ctx, items, |_| {}) {
                Ok((inst, failures)) => {
                    report.files_downloaded += inst.installed + inst.skipped;
                    report.installed += inst.installed;
                    report.skipped += inst.skipped;
                    report.failed += inst.failed + failures.len();
                    for (item, e) in &failures {
                        clean = false;
                        log(
                            &mut report,
                            format!("    failed: {} / {}: {e}", item.family, item.filename),
                        );
                    }
                    for o in inst.outcomes.iter().filter(|o| o.status == "failed") {
                        clean = false;
                        log(
                            &mut report,
                            format!(
                                "    failed: {}: {}",
                                o.filename,
                                o.detail.clone().unwrap_or_default()
                            ),
                        );
                    }
                    log(
                        &mut report,
                        format!(
                            "    {} installed, {} already present, {} failed",
                            inst.installed,
                            inst.skipped,
                            inst.failed + failures.len()
                        ),
                    );
                }
                Err(e) => {
                    clean = false;
                    log(&mut report, format!("    error: {e}"));
                }
            }
        }
        if clean && !ctx.cancel.load(Ordering::Relaxed) {
            state.processed_lists.insert(list.key.clone(), hash);
        }
    }

    // Then the font files sitting on sources.
    let mut source_files = Vec::new();
    let mut skipped_existing = 0;
    for f in gathered.fonts {
        if fonts::already_installed(&ctx.install_dir, &f.name) {
            skipped_existing += 1;
            continue;
        }
        source_files.push(f);
    }
    if !source_files.is_empty() {
        log(
            &mut report,
            format!(
                "  {} new font file(s) on sources ({} already present)",
                source_files.len(),
                skipped_existing
            ),
        );
        let mut batch = Vec::new();
        for f in source_files {
            if ctx.cancel.load(Ordering::Relaxed) {
                break;
            }
            match (f.read)() {
                Ok(data) => batch.push(FontFile {
                    filename: f.name,
                    data,
                }),
                Err(e) => {
                    report.failed += 1;
                    log(
                        &mut report,
                        format!("    failed: {} ({}): {e}", f.name, f.origin),
                    );
                }
            }
        }
        match fonts::install_fonts(&ctx.install_dir, batch, ctx.register) {
            Ok(inst) => {
                report.installed += inst.installed;
                report.skipped += inst.skipped;
                report.failed += inst.failed;
                for o in inst.outcomes.iter().filter(|o| o.status == "failed") {
                    log(
                        &mut report,
                        format!(
                            "    failed: {}: {}",
                            o.filename,
                            o.detail.clone().unwrap_or_default()
                        ),
                    );
                }
                log(
                    &mut report,
                    format!(
                        "    {} installed, {} already present, {} failed",
                        inst.installed, inst.skipped, inst.failed
                    ),
                );
            }
            Err(e) => log(&mut report, format!("    error: {e}")),
        }
    } else if skipped_existing > 0 {
        log(
            &mut report,
            format!("  all {skipped_existing} font file(s) on sources already present"),
        );
    }
    report.skipped += skipped_existing;

    report.finished_at = now();
    let finished = format!(
        "[{}] sync finished: {} installed, {} already present, {} failed",
        report.finished_at, report.installed, report.skipped, report.failed
    );
    log(&mut report, finished);
    state.last_sync = serde_json::to_value(&report).ok();
    if let Err(e) = config::save_state(&ctx.paths, state) {
        (ctx.on_line)(&format!("  ! could not save state: {e}"));
    }
    config::append_log(&ctx.paths, &report.log);
    report
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub ok: bool,
    pub message: String,
    pub fonts: usize,
    pub lists: usize,
}

/// Check a source can be read, and count what it holds.
pub fn probe(paths: &Paths, src: &SourceConfig) -> Probe {
    match src.kind.as_str() {
        "dir" => {
            let dir = Path::new(&src.path);
            if !dir.is_dir() {
                return Probe {
                    ok: false,
                    message: format!(
                        "{} is not a readable folder (is the share mounted?)",
                        dir.display()
                    ),
                    fonts: 0,
                    lists: 0,
                };
            }
            let files = walk_dir(dir, 6);
            let names: Vec<String> = files
                .iter()
                .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
                .collect();
            Probe {
                ok: true,
                message: format!("Readable, {} file(s) at up to six levels", files.len()),
                fonts: names.iter().filter(|n| fonts::is_font_filename(n)).count(),
                lists: names.iter().filter(|n| lists::is_list_filename(n)).count(),
            }
        }
        "webdav" => {
            let password = secrets::get(paths, &src.id);
            let cancel = AtomicBool::new(false);
            match Dav::new(&src.path, Some(&src.username), password.as_deref())
                .and_then(|d| d.walk(&cancel))
            {
                Ok(entries) => Probe {
                    ok: true,
                    message: format!("Connected, {} file(s)", entries.len()),
                    fonts: entries
                        .iter()
                        .filter(|e| fonts::is_font_filename(&e.name))
                        .count(),
                    lists: entries
                        .iter()
                        .filter(|e| lists::is_list_filename(&e.name))
                        .count(),
                },
                Err(e) => Probe {
                    ok: false,
                    message: e,
                    fonts: 0,
                    lists: 0,
                },
            }
        }
        other => Probe {
            ok: false,
            message: format!("unknown source kind `{other}`"),
            fonts: 0,
            lists: 0,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("openfont-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ctx(home: &Path, install: &Path) -> Context {
        Context {
            paths: Paths {
                config_dir: home.to_path_buf(),
                data_dir: home.to_path_buf(),
            },
            install_dir: install.to_path_buf(),
            register: false,
            cancel: Arc::new(AtomicBool::new(false)),
            on_line: Box::new(|_| {}),
        }
    }

    #[test]
    fn plans_only_what_is_missing_and_reports_unresolved() {
        let install = temp("plan-install");
        std::fs::write(install.join("Poppins-Regular.ttf"), [0, 1, 0, 0]).unwrap();
        let parsed = lists::parse_list(
            "family,weights\nPoppins,400;700\nCalibri,\nAbel,\n",
            "x.csv",
        );
        let (items, unresolved, families) = plan_for(&parsed.entries, &install);
        assert_eq!(families, 2);
        assert_eq!(unresolved, ["Calibri"]);
        let names: Vec<&str> = items.iter().map(|i| i.filename.as_str()).collect();
        assert_eq!(names, ["Poppins-Bold.ttf", "Abel-Regular.ttf"]);
        let _ = std::fs::remove_dir_all(&install);
    }

    #[test]
    fn a_pass_installs_share_fonts_and_remembers_lists() {
        let home = temp("pass-home");
        let install = temp("pass-install");
        let share = temp("pass-share");
        std::fs::create_dir_all(share.join("sub")).unwrap();
        std::fs::write(
            share.join("sub").join("Share-Regular.ttf"),
            [0, 1, 0, 0, 1, 2],
        )
        .unwrap();
        std::fs::write(share.join("._Share-Regular.ttf"), b"AppleDouble junk").unwrap();
        std::fs::write(share.join("notes.txt.bak"), b"not a list").unwrap();
        // A list naming only fonts that already exist costs no network.
        std::fs::write(install.join("Abel-Regular.ttf"), [0, 1, 0, 0]).unwrap();
        let lists_dir = temp("pass-lists");
        std::fs::write(lists_dir.join("show.txt"), "Abel\nCalibri\n").unwrap();

        let settings = Settings {
            lists_dir: Some(lists_dir.display().to_string()),
            sources: vec![SourceConfig {
                id: "s".into(),
                label: "share".into(),
                kind: "dir".into(),
                path: share.display().to_string(),
                username: String::new(),
                enabled: true,
                install_fonts: true,
                read_lists: true,
            }],
            ..Settings::default()
        };
        let c = ctx(&home, &install);
        let mut state = State::default();
        let r = run_pass(&c, &settings, &mut state, "test");
        assert_eq!(r.lists_seen, 1);
        assert_eq!(r.lists_processed, 1);
        assert_eq!(r.families_requested, 1);
        assert_eq!(r.families_unresolved, ["Calibri"]);
        assert_eq!(r.installed, 1, "{:?}", r.log);
        assert!(install.join("Share-Regular.ttf").exists());
        assert!(!install.join("._Share-Regular.ttf").exists());
        assert_eq!(state.processed_lists.len(), 1);

        // Second pass: nothing to do, the list is remembered, the font present.
        let r2 = run_pass(&c, &settings, &mut state, "test");
        assert_eq!(r2.lists_processed, 0);
        assert_eq!(r2.installed, 0);
        assert_eq!(r2.skipped, 1);
        assert!(config::read_log_tail(&c.paths, 1).contains("sync finished"));

        // A changed list is processed again.
        std::fs::write(lists_dir.join("show.txt"), "Abel\n").unwrap();
        let r3 = run_pass(&c, &settings, &mut state, "test");
        assert_eq!(r3.lists_processed, 1);
        assert!(r3.families_unresolved.is_empty());

        for d in [home, install, share, lists_dir] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn probe_reports_folders() {
        let share = temp("probe-share");
        std::fs::write(share.join("A.ttf"), [0, 1, 0, 0]).unwrap();
        std::fs::write(share.join("l.csv"), "family\nAbel").unwrap();
        let paths = Paths {
            config_dir: share.clone(),
            data_dir: share.clone(),
        };
        let src = SourceConfig {
            id: "p".into(),
            label: "p".into(),
            kind: "dir".into(),
            path: share.display().to_string(),
            username: String::new(),
            enabled: true,
            install_fonts: true,
            read_lists: true,
        };
        let p = probe(&paths, &src);
        assert!(p.ok);
        assert_eq!((p.fonts, p.lists), (1, 1));
        let missing = probe(
            &paths,
            &SourceConfig {
                path: "/nonexistent/x".into(),
                ..src
            },
        );
        assert!(!missing.ok);
        let _ = std::fs::remove_dir_all(&share);
    }
}
