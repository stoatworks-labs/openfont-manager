//! Native font installation and enumeration.
//!
//! This is the whole reason the desktop app exists. A browser can hand you a
//! zip; it cannot put a font where the OS looks for it, and it cannot do so
//! at login without anyone clicking. Everything here is the part the web app
//! structurally cannot do.
//!
//! Enumeration goes through `font-kit`, which reads the platform's own font
//! registry — CoreText, DirectWrite, fontconfig. Installation writes to the
//! per-user font directory, which needs no administrator rights, and then
//! tells the OS about it where that is a separate step.
//!
//! Carried over from the sibling PowerPoint Font Manager, where the install
//! path was checked against a real font file on macOS and Windows 11.

use std::fs;
use std::path::{Path, PathBuf};

use font_kit::source::SystemSource;
use serde::{Deserialize, Serialize};

/// Every installed family name, as the OS reports them.
pub fn installed_families() -> Result<Vec<String>, String> {
    let source = SystemSource::new();
    let mut families = source
        .all_families()
        .map_err(|e| format!("Could not list installed font families: {e}"))?;
    families.sort();
    families.dedup();
    Ok(families)
}

/// The per-user font directory. No administrator rights are needed to write here.
///
/// `OPENFONT_INSTALL_DIR` overrides it — for the tests, and for anyone who
/// wants fonts somewhere the OS also scans (a shared folder, say).
pub fn default_install_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("OPENFONT_INSTALL_DIR") {
        return Ok(PathBuf::from(dir));
    }
    #[cfg(target_os = "macos")]
    {
        let home = dirs::home_dir().ok_or("Could not locate the home directory.")?;
        Ok(home.join("Library").join("Fonts"))
    }
    #[cfg(target_os = "windows")]
    {
        let local = dirs::data_local_dir().ok_or("Could not locate LOCALAPPDATA.")?;
        Ok(local.join("Microsoft").join("Windows").join("Fonts"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data = dirs::data_dir().ok_or("Could not locate the XDG data directory.")?;
        Ok(data.join("fonts"))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFile {
    pub filename: String,
    pub data: Vec<u8>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub filename: String,
    /// `installed`, `already-present`, or `failed`.
    pub status: String,
    pub detail: Option<String>,
    pub path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallReport {
    pub dir: String,
    pub installed: usize,
    pub skipped: usize,
    pub failed: usize,
    pub outcomes: Vec<InstallOutcome>,
    /// Set when the platform needs the user to do something for fonts to appear.
    pub note: Option<String>,
}

impl InstallReport {
    pub fn new(dir: &Path) -> Self {
        InstallReport {
            dir: dir.display().to_string(),
            installed: 0,
            skipped: 0,
            failed: 0,
            outcomes: Vec::new(),
            note: None,
        }
    }

    pub fn merge(&mut self, other: InstallReport) {
        self.installed += other.installed;
        self.skipped += other.skipped;
        self.failed += other.failed;
        self.outcomes.extend(other.outcomes);
        if other.note.is_some() {
            self.note = other.note;
        }
    }
}

/// True when the bytes begin with a real sfnt signature.
///
/// This is a guard, not a formality: `install_fonts` writes into the user's
/// font directory, and it must never put something there that is not a font.
/// A failed download comes back as an HTML error page with a 200.
pub fn is_sfnt(data: &[u8]) -> bool {
    matches!(
        data.get(..4),
        Some([0x00, 0x01, 0x00, 0x00]) | Some(b"OTTO") | Some(b"true") | Some(b"ttcf")
    )
}

/// Reject anything that is not a plain font filename.
///
/// Filenames arrive from the frontend, a list on a share, or a remote URL.
/// None is trustworthy enough to join onto a path unchecked —
/// `../../../.zshrc` must not resolve.
pub fn safe_filename(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Empty filename.".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("Refusing a filename containing a path: {trimmed}"));
    }
    if Path::new(trimmed)
        .file_name()
        .map(|f| f != trimmed)
        .unwrap_or(true)
    {
        return Err(format!("Refusing an unusable filename: {trimmed}"));
    }
    if !is_font_filename(trimmed) {
        return Err(format!("Not a font file extension: {trimmed}"));
    }
    Ok(trimmed)
}

pub fn is_font_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".ttf") || lower.ends_with(".otf") || lower.ends_with(".ttc")
}

/// Is a file of this name already in the install directory?
///
/// Cheap, and the reason a sync pass does not re-download a share's worth of
/// fonts every time it runs.
pub fn already_installed(dir: &Path, filename: &str) -> bool {
    match safe_filename(filename) {
        Ok(name) => dir.join(name).exists(),
        Err(_) => false,
    }
}

/// Install font files into `dir`.
///
/// Existing files are **skipped, never overwritten** — replacing a font the
/// user already has is not this tool's business, and on Windows an in-use
/// font file cannot be replaced anyway.
///
/// `register` tells the OS about each file (CoreText / the Windows registry).
/// It is false only in tests, which write into a temporary directory that
/// must not end up registered with the user's font server.
pub fn install_fonts(
    dir: &Path,
    files: Vec<FontFile>,
    register: bool,
) -> Result<InstallReport, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let mut report = InstallReport::new(dir);

    for file in files {
        let name = match safe_filename(&file.filename) {
            Ok(n) => n.to_string(),
            Err(e) => {
                report.failed += 1;
                report.outcomes.push(InstallOutcome {
                    filename: file.filename.clone(),
                    status: "failed".into(),
                    detail: Some(e),
                    path: None,
                });
                continue;
            }
        };

        if !is_sfnt(&file.data) {
            report.failed += 1;
            report.outcomes.push(InstallOutcome {
                filename: name,
                status: "failed".into(),
                detail: Some(
                    "Not a font file — the data does not start with a TrueType or OpenType \
                     signature. A download probably failed and returned an error page."
                        .into(),
                ),
                path: None,
            });
            continue;
        }

        let target = dir.join(&name);
        if target.exists() {
            report.skipped += 1;
            report.outcomes.push(InstallOutcome {
                filename: name,
                status: "already-present".into(),
                detail: None,
                path: Some(target.display().to_string()),
            });
            continue;
        }

        match fs::write(&target, &file.data) {
            Ok(()) => match if register {
                register_font(&target, &file.data)
            } else {
                Ok(())
            } {
                Ok(()) => {
                    report.installed += 1;
                    report.outcomes.push(InstallOutcome {
                        filename: name,
                        status: "installed".into(),
                        detail: None,
                        path: Some(target.display().to_string()),
                    });
                }
                Err(e) => {
                    // On disk but the OS was not told. Remove it rather than
                    // leave a font that half exists.
                    let _ = fs::remove_file(&target);
                    report.failed += 1;
                    report.outcomes.push(InstallOutcome {
                        filename: name,
                        status: "failed".into(),
                        detail: Some(e),
                        path: None,
                    });
                }
            },
            Err(e) => {
                report.failed += 1;
                report.outcomes.push(InstallOutcome {
                    filename: name,
                    status: "failed".into(),
                    detail: Some(e.to_string()),
                    path: None,
                });
            }
        }
    }

    report.note = post_install_note(&report);
    Ok(report)
}

/// Tell the OS about a newly written font file, where that is a separate step.
#[cfg(target_os = "windows")]
fn register_font(path: &Path, data: &[u8]) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
    use winreg::RegKey;

    // Copying the file is not enough on Windows. Applications read the font
    // list out of the registry, and a font with no registry value never
    // appears in any font menu. The value name is the face name plus a type
    // suffix, matching what the shell's own installer writes:
    //   "Poppins Regular (TrueType)"
    let face = face_name_for(path, data);
    let suffix = if path
        .extension()
        .map(|e| e.eq_ignore_ascii_case("otf"))
        .unwrap_or(false)
    {
        " (OpenType)"
    } else {
        " (TrueType)"
    };

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey_with_flags(
            r"Software\Microsoft\Windows NT\CurrentVersion\Fonts",
            KEY_WRITE,
        )
        .map_err(|e| format!("Could not open the user font registry key: {e}"))?;
    key.set_value(format!("{face}{suffix}"), &path.display().to_string())
        .map_err(|e| format!("Could not write the font registry value: {e}"))?;

    // The file and the registry value do not make the font usable in this
    // session. `AddFontResourceW` registers it now; WM_FONTCHANGE tells every
    // running window to rebuild its font list.
    add_font_resource_and_notify(path);
    Ok(())
}

#[cfg(target_os = "windows")]
fn add_font_resource_and_notify(path: &Path) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    const HWND_BROADCAST: isize = 0xffff;
    const WM_FONTCHANGE: u32 = 0x001D;
    const SMTO_ABORTIFHUNG: u32 = 0x0002;

    #[link(name = "gdi32")]
    extern "system" {
        fn AddFontResourceW(lpszFilename: *const u16) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SendMessageTimeoutW(
            hwnd: isize,
            msg: u32,
            wparam: usize,
            lparam: isize,
            flags: u32,
            timeout: u32,
            result: *mut usize,
        ) -> isize;
    }

    let wide: Vec<u16> = OsStr::new(path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call,
    // and `result` is a valid out-pointer. Both functions are documented as
    // safe to call from any thread.
    unsafe {
        AddFontResourceW(wide.as_ptr());
        let mut result: usize = 0;
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_FONTCHANGE,
            0,
            0,
            SMTO_ABORTIFHUNG,
            5_000,
            &mut result,
        );
    }
}

/// Best available face name for a font file, for the Windows registry value.
#[cfg(target_os = "windows")]
fn face_name_for(path: &Path, data: &[u8]) -> String {
    use font_kit::font::Font;
    use std::sync::Arc;

    if let Ok(font) = Font::from_bytes(Arc::new(data.to_vec()), 0) {
        let full = font.full_name();
        if !full.trim().is_empty() {
            return full;
        }
    }
    path.file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Font".to_string())
}

/// Register a font with CoreText so it is usable *now*.
///
/// Dropping a file into `~/Library/Fonts` does work, but the font server picks
/// it up on its own schedule — around ten seconds on an M-series Mac.
/// `CTFontManagerRegisterFontsForURL` with user scope makes it visible
/// synchronously and persistently. A failure is not fatal: the file is on disk
/// and the font server will find it eventually.
#[cfg(target_os = "macos")]
fn register_font(path: &Path, _data: &[u8]) -> Result<(), String> {
    use core_foundation::base::TCFType;
    use core_foundation::error::CFErrorRef;
    use core_foundation::url::{CFURLRef, CFURL};

    #[allow(non_upper_case_globals)]
    const kCTFontManagerScopeUser: u32 = 2;

    #[link(name = "CoreText", kind = "framework")]
    extern "C" {
        fn CTFontManagerRegisterFontsForURL(
            fontURL: CFURLRef,
            scope: u32,
            error: *mut CFErrorRef,
        ) -> bool;
    }

    let url = CFURL::from_path(path, false)
        .ok_or_else(|| format!("Could not form a URL for {}", path.display()))?;
    let mut err: CFErrorRef = std::ptr::null_mut();
    // SAFETY: `url` outlives the call and `err` is a valid out-pointer. The
    // CFError, if any, is only consulted for the boolean result.
    let _ok = unsafe {
        CTFontManagerRegisterFontsForURL(
            url.as_concrete_TypeRef(),
            kCTFontManagerScopeUser,
            &mut err,
        )
    };
    // `false` here means "already registered" or "duplicate of a system font";
    // the file is installed either way.
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn register_font(_path: &Path, _data: &[u8]) -> Result<(), String> {
    // Linux needs the fontconfig cache rebuilt, once per batch — see
    // post_install_note.
    Ok(())
}

/// Anything the user still has to do before the fonts show up.
fn post_install_note(report: &InstallReport) -> Option<String> {
    if report.installed == 0 {
        return None;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let ok = std::process::Command::new("fc-cache")
            .arg("-f")
            .arg(&report.dir)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            return Some(
                "Fonts were installed, but the fontconfig cache could not be rebuilt \
                 (fc-cache not found). Log out and back in to pick them up."
                    .into(),
            );
        }
    }

    Some(
        "Applications that are already open may need restarting before they see the new fonts."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_guard() {
        assert!(safe_filename("Poppins-Regular.ttf").is_ok());
        assert!(safe_filename("Font.OTF").is_ok());
        assert!(safe_filename("../x.ttf").is_err());
        assert!(safe_filename("a/b.ttf").is_err());
        assert!(safe_filename("a\\b.ttf").is_err());
        assert!(safe_filename("notes.txt").is_err());
        assert!(safe_filename("").is_err());
    }

    #[test]
    fn sfnt_guard() {
        assert!(is_sfnt(&[0, 1, 0, 0, 9]));
        assert!(is_sfnt(b"OTTOxx"));
        assert!(is_sfnt(b"ttcf"));
        assert!(!is_sfnt(b"<!doctype html>"));
        assert!(!is_sfnt(b"OT"));
    }

    #[test]
    fn installs_into_a_temp_dir_and_skips_repeats() {
        let dir = std::env::temp_dir().join(format!("openfont-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let font = FontFile {
            filename: "Test-Regular.ttf".into(),
            data: vec![0, 1, 0, 0, 0, 0, 0, 0],
        };
        let bad = FontFile {
            filename: "Bad.ttf".into(),
            data: b"<html>".to_vec(),
        };
        let r = install_fonts(&dir, vec![font, bad], false).unwrap();
        assert_eq!((r.installed, r.skipped, r.failed), (1, 0, 1));
        assert!(dir.join("Test-Regular.ttf").exists());
        assert!(!dir.join("Bad.ttf").exists());

        let again = install_fonts(
            &dir,
            vec![FontFile {
                filename: "Test-Regular.ttf".into(),
                data: vec![0, 1, 0, 0],
            }],
            false,
        )
        .unwrap();
        assert_eq!((again.installed, again.skipped), (0, 1));
        assert!(already_installed(&dir, "Test-Regular.ttf"));
        let _ = fs::remove_dir_all(&dir);
    }
}
