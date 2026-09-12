//! The font catalogue, embedded at build time so the headless sync pass can
//! resolve a family name to files without a webview.
//!
//! Same two JSON snapshots the frontend ships (`src/data/*.json`), read via
//! `include_str!` so the two sides can never disagree about what exists. The
//! matching rule mirrors `findFamily` in `src/core/catalogue.ts`: normalised
//! name first, then the name with a trailing style word stripped.

use std::collections::HashMap;
use std::sync::OnceLock;

use serde::Deserialize;

const GOOGLE_JSON: &str = include_str!("../../src/data/google-fonts.json");
const FONTSOURCE_JSON: &str = include_str!("../../src/data/fontsource-fonts.json");

const RAW_BASE: &str = "https://raw.githubusercontent.com/google/fonts/main";
const GH_MIRROR: &str = "https://cdn.jsdelivr.net/gh/google/fonts@main";
const FONTSOURCE_CDN: &str = "https://cdn.jsdelivr.net/fontsource/fonts";

#[derive(Deserialize)]
struct RawGoogle {
    n: String,
    #[serde(default)]
    l: String,
    #[serde(default)]
    p: String,
    #[serde(default)]
    f: Vec<String>,
    #[serde(default)]
    w: Vec<u32>,
}

#[derive(Deserialize)]
struct RawFontsource {
    n: String,
    s: String,
    u: String,
    #[serde(default)]
    w: Vec<u32>,
    #[serde(default)]
    i: u8,
    #[serde(default)]
    l: String,
}

#[derive(Deserialize)]
struct Wrapper<T> {
    families: Vec<T>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Google,
    Fontsource,
}

#[derive(Clone, Debug)]
pub struct File {
    pub filename: String,
    pub url: String,
    pub mirrors: Vec<String>,
    pub weight: u32,
    pub italic: bool,
    pub variable: bool,
}

#[derive(Clone, Debug)]
pub struct Family {
    pub id: String,
    pub name: String,
    pub source: Source,
    pub license: String,
    pub license_url: Option<String>,
    pub weights: Vec<u32>,
    pub files: Vec<File>,
    key: String,
}

/// Case/punctuation-insensitive key — the same rule as `normalizeKey` in
/// `src/core/names.ts`.
pub fn normalize_key(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_space = true;
    for ch in s.chars() {
        if matches!(ch, '\u{2018}' | '\u{2019}' | '\u{201C}' | '\u{201D}') {
            continue;
        }
        let c = if ch == '-' || ch == '_' || ch == ',' {
            ' '
        } else {
            ch
        };
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            for lower in c.to_lowercase() {
                out.push(lower);
            }
            last_space = false;
        }
    }
    out.trim().to_string()
}

/// Compound forms first, so `semi bold` is taken whole rather than as `bold`.
const STYLE_WORDS: &[&str] = &[
    "extra light",
    "ultra light",
    "semi bold",
    "demi bold",
    "extra bold",
    "ultra bold",
    "thin",
    "hairline",
    "extralight",
    "ultralight",
    "light",
    "regular",
    "normal",
    "book",
    "roman",
    "medium",
    "semibold",
    "demibold",
    "bold",
    "extrabold",
    "ultrabold",
    "heavy",
    "black",
    "italic",
    "oblique",
];

/// Strip trailing style words: `poppins semi bold italic` -> `poppins`.
///
/// Conservative, like the frontend's `parseFontName`: a name that is *only*
/// style words is kept whole, so the families called `Black` and `Medium`
/// still resolve, and a word boundary is required so `bookman` keeps its
/// `book`.
pub fn strip_style(key: &str) -> String {
    let mut work = key.to_string();
    loop {
        let mut stripped = false;
        for w in STYLE_WORDS {
            if let Some(head) = work.strip_suffix(w) {
                if !head.ends_with(' ') {
                    continue;
                }
                work = head.trim_end().to_string();
                stripped = true;
                break;
            }
        }
        if !stripped {
            break;
        }
    }
    // Numeric weights: `roboto 700`.
    if let Some(idx) = work.rfind(' ') {
        let tail = &work[idx + 1..];
        if tail.len() == 3 && tail.ends_with("00") && tail.as_bytes()[0].is_ascii_digit() {
            work = work[..idx].trim_end().to_string();
        }
    }
    if work.is_empty() {
        key.to_string()
    } else {
        work
    }
}

struct Catalogue {
    families: Vec<Family>,
    by_key: HashMap<String, usize>,
    by_id: HashMap<String, usize>,
}

fn describe_google_file(file: &str) -> (u32, bool, bool) {
    let base = file.strip_suffix(".ttf").unwrap_or(file);
    let variable = base.ends_with(']') && base.contains('[');
    let stem = if variable {
        &base[..base.rfind('[').unwrap_or(base.len())]
    } else {
        base
    };
    let suffix = stem.find('-').map(|i| &stem[i + 1..]).unwrap_or("");
    let lower = suffix.to_ascii_lowercase();
    let italic = lower.contains("italic");
    let without = lower.replace("italic", "");
    let weight = match without.as_str() {
        "thin" | "hairline" => 100,
        "extralight" | "ultralight" => 200,
        "light" => 300,
        "medium" => 500,
        "semibold" | "demibold" => 600,
        "bold" => 700,
        "extrabold" | "ultrabold" => 800,
        "black" | "heavy" => 900,
        _ => 400,
    };
    (weight, italic, variable)
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in name.to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

fn encode(s: &str) -> String {
    // Only the characters that actually appear in google/fonts filenames need
    // escaping: `[`, `]` and `,` in variable-font names.
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn weight_name(w: u32) -> String {
    match w {
        100 => "Thin",
        200 => "ExtraLight",
        300 => "Light",
        400 => "Regular",
        500 => "Medium",
        600 => "SemiBold",
        700 => "Bold",
        800 => "ExtraBold",
        900 => "Black",
        _ => return w.to_string(),
    }
    .to_string()
}

fn load() -> Catalogue {
    let google: Wrapper<RawGoogle> =
        serde_json::from_str(GOOGLE_JSON).expect("google-fonts.json is valid");
    let fontsource: Wrapper<RawFontsource> =
        serde_json::from_str(FONTSOURCE_JSON).expect("fontsource-fonts.json is valid");

    let mut families = Vec::with_capacity(google.families.len() + fontsource.families.len());
    for f in google.families {
        let license_url = if f.p.is_empty() {
            None
        } else {
            let file = match f.p.split('/').next().unwrap_or("ofl") {
                "apache" => "LICENSE.txt",
                "ufl" => "UFL.txt",
                _ => "OFL.txt",
            };
            Some(format!("{RAW_BASE}/{}/{file}", f.p))
        };
        let files =
            f.f.iter()
                .map(|file| {
                    let (weight, italic, variable) = describe_google_file(file);
                    let enc = encode(file);
                    File {
                        filename: file.clone(),
                        url: format!("{RAW_BASE}/{}/{enc}", f.p),
                        mirrors: vec![format!("{GH_MIRROR}/{}/{enc}", f.p)],
                        weight,
                        italic,
                        variable,
                    }
                })
                .collect();
        families.push(Family {
            id: format!("google:{}", slug(&f.n)),
            key: normalize_key(&f.n),
            name: f.n,
            source: Source::Google,
            license: if f.l.is_empty() {
                "Unknown".into()
            } else {
                f.l
            },
            license_url,
            weights: f.w,
            files,
        });
    }
    for f in fontsource.families {
        let stem: String = f.n.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
        let weights = if f.w.is_empty() {
            vec![400]
        } else {
            f.w.clone()
        };
        let mut files = Vec::new();
        for &w in &weights {
            for italic in [false, true] {
                if italic && f.i == 0 {
                    continue;
                }
                let wn = weight_name(w);
                let style = if italic {
                    if w == 400 {
                        "Italic".to_string()
                    } else {
                        format!("{wn}Italic")
                    }
                } else {
                    wn
                };
                files.push(File {
                    filename: format!("{stem}-{style}.ttf"),
                    url: format!(
                        "{FONTSOURCE_CDN}/{}@latest/{}-{w}-{}.ttf",
                        f.s,
                        f.u,
                        if italic { "italic" } else { "normal" }
                    ),
                    mirrors: Vec::new(),
                    weight: w,
                    italic,
                    variable: false,
                });
            }
        }
        families.push(Family {
            id: format!("fontsource:{}", f.s),
            key: normalize_key(&f.n),
            name: f.n,
            source: Source::Fontsource,
            license: f.l,
            license_url: Some(format!(
                "https://cdn.jsdelivr.net/npm/@fontsource/{}@latest/LICENSE",
                f.s
            )),
            weights,
            files,
        });
    }

    let mut by_key = HashMap::new();
    let mut by_id = HashMap::new();
    for (i, f) in families.iter().enumerate() {
        by_key.entry(f.key.clone()).or_insert(i);
        by_id.insert(f.id.clone(), i);
    }
    Catalogue {
        families,
        by_key,
        by_id,
    }
}

fn catalogue() -> &'static Catalogue {
    static CAT: OnceLock<Catalogue> = OnceLock::new();
    CAT.get_or_init(load)
}

pub fn count() -> usize {
    catalogue().families.len()
}

pub fn by_id(id: &str) -> Option<&'static Family> {
    let c = catalogue();
    c.by_id.get(id).map(|&i| &c.families[i])
}

/// Loose lookup: `Poppins`, `poppins-bold`, `Poppins SemiBold Italic`.
pub fn find(name: &str, source: Option<Source>) -> Option<&'static Family> {
    let c = catalogue();
    let key = normalize_key(name);
    let stripped = strip_style(&key);
    for k in [key.as_str(), stripped.as_str()] {
        if let Some(&i) = c.by_key.get(k) {
            let f = &c.families[i];
            if source.as_ref().map_or(true, |s| *s == f.source) {
                return Some(f);
            }
        }
    }
    if let Some(s) = source {
        for k in [key.as_str(), stripped.as_str()] {
            if let Some(f) = c.families.iter().find(|f| f.source == s && f.key == k) {
                return Some(f);
            }
        }
    }
    None
}

/// Files for a requested selection. `weights == None` means the whole family.
pub fn select_files(family: &Family, weights: Option<&[u32]>, italics: bool) -> Vec<File> {
    let Some(weights) = weights else {
        return family.files.clone();
    };
    let mut out: Vec<File> = Vec::new();
    let styles: &[bool] = if italics { &[false, true] } else { &[false] };
    let weights: Vec<u32> = if weights.is_empty() {
        vec![400]
    } else {
        weights.to_vec()
    };
    for &w in &weights {
        for &italic in styles {
            let pick = pick_file(&family.files, w, italic);
            if let Some(p) = pick {
                if !out.iter().any(|o| o.filename == p.filename) {
                    out.push(p.clone());
                }
            }
        }
    }
    out
}

fn pick_file(files: &[File], want: u32, italic: bool) -> Option<&File> {
    let mut statics: Vec<&File> = files
        .iter()
        .filter(|f| !f.variable && f.italic == italic)
        .collect();
    if !statics.is_empty() {
        statics.sort_by_key(|f| (f.weight as i64 - want as i64).abs());
        return statics.first().copied();
    }
    if let Some(v) = files.iter().find(|f| f.variable && f.italic == italic) {
        return Some(v);
    }
    files.iter().find(|f| !f.italic).or_else(|| files.first())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_both_sources() {
        assert!(count() > 2000);
        assert!(by_id("google:poppins").is_some());
        assert!(by_id("fontsource:adwaita-sans").is_some());
    }

    #[test]
    fn strips_styles_conservatively() {
        assert_eq!(strip_style("poppins semi bold italic"), "poppins");
        assert_eq!(strip_style("poppins bold"), "poppins");
        assert_eq!(strip_style("roboto 700"), "roboto");
        assert_eq!(strip_style("black"), "black");
        assert_eq!(strip_style("bookman old style"), "bookman old style");
        assert_eq!(strip_style("archivo black"), "archivo");
    }

    #[test]
    fn finds_loosely() {
        assert_eq!(find("poppins", None).unwrap().id, "google:poppins");
        assert_eq!(find("Poppins-Bold", None).unwrap().id, "google:poppins");
        assert_eq!(
            find("Poppins SemiBold Italic", None).unwrap().id,
            "google:poppins"
        );
        assert_eq!(
            find("adwaita sans", None).unwrap().source,
            Source::Fontsource
        );
        assert!(find("Poppins", Some(Source::Fontsource)).is_none());
        assert!(find("Calibri", None).is_none());
        // `Archivo Black` is a real family; `Black` alone is too.
        assert_eq!(find("Archivo Black", None).unwrap().name, "Archivo Black");
    }

    #[test]
    fn builds_urls_like_the_frontend() {
        let p = find("Poppins", None).unwrap();
        let semi = p
            .files
            .iter()
            .find(|f| f.filename == "Poppins-SemiBold.ttf")
            .unwrap();
        assert_eq!(
            semi.url,
            "https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf"
        );
        assert_eq!(
            semi.mirrors[0],
            "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/poppins/Poppins-SemiBold.ttf"
        );
        assert_eq!(
            (semi.weight, semi.italic, semi.variable),
            (600, false, false)
        );
        assert_eq!(
            p.license_url.as_deref(),
            Some("https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/OFL.txt")
        );

        let inter = find("Inter", None).unwrap();
        let var = inter
            .files
            .iter()
            .find(|f| f.filename == "Inter[opsz,wght].ttf")
            .unwrap();
        assert!(var.variable && !var.italic);
        assert!(var.url.ends_with("/ofl/inter/Inter%5Bopsz%2Cwght%5D.ttf"));

        let a = find("Adwaita Sans", None).unwrap();
        assert!(a
            .files
            .iter()
            .any(|f| f.filename == "AdwaitaSans-Regular.ttf"));
        assert!(a.files[0]
            .url
            .starts_with("https://cdn.jsdelivr.net/fontsource/fonts/adwaita-sans@latest/latin-"));
    }

    #[test]
    fn selects_files() {
        let p = find("Poppins", None).unwrap();
        let all = select_files(p, None, true);
        assert_eq!(all.len(), p.files.len());
        let some = select_files(p, Some(&[400, 700]), true);
        let names: Vec<&str> = some.iter().map(|f| f.filename.as_str()).collect();
        assert_eq!(
            names,
            [
                "Poppins-Regular.ttf",
                "Poppins-Italic.ttf",
                "Poppins-Bold.ttf",
                "Poppins-BoldItalic.ttf"
            ]
        );
        let inter = find("Inter", None).unwrap();
        let v = select_files(inter, Some(&[300]), false);
        assert_eq!(v.len(), 1);
        assert!(v[0].variable);
    }
}
