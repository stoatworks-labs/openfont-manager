//! Font lists — CSV, XML and plain text — as the sync pass reads them.
//!
//! Mirrors `src/core/lists.ts` rule for rule; the two are kept in step by the
//! shared examples under `examples/`, which both test suites parse.

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub family: String,
    /// `None` = the whole family.
    pub weights: Option<Vec<u32>>,
    pub italics: bool,
    /// `google`, `fontsource` or `auto`.
    pub source: String,
    pub line: usize,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub entries: Vec<Entry>,
    pub errors: Vec<String>,
    pub format: &'static str,
}

fn weight_word(tok: &str) -> Option<u32> {
    let t: String = tok.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    Some(match t.as_str() {
        "thin" | "hairline" => 100,
        "extralight" | "ultralight" => 200,
        "light" => 300,
        "regular" | "normal" | "book" => 400,
        "medium" => 500,
        "semibold" | "demibold" => 600,
        "bold" => 700,
        "extrabold" | "ultrabold" => 800,
        "black" | "heavy" => 900,
        _ => return None,
    })
}

/// `400;700`, `400 700`, `bold+light`, `all`, '' -> weights (None = all).
pub fn parse_weights(raw: Option<&str>) -> Option<Vec<u32>> {
    let s = raw.unwrap_or("").trim().to_lowercase();
    if s.is_empty() || s == "all" || s == "*" {
        return None;
    }
    // `semi bold`, `extra-light` -> one token.
    let s = s
        .replace("semi bold", "semibold")
        .replace("semi-bold", "semibold")
        .replace("demi bold", "demibold")
        .replace("demi-bold", "demibold")
        .replace("extra bold", "extrabold")
        .replace("extra-bold", "extrabold")
        .replace("ultra bold", "ultrabold")
        .replace("ultra-bold", "ultrabold")
        .replace("extra light", "extralight")
        .replace("extra-light", "extralight")
        .replace("ultra light", "ultralight")
        .replace("ultra-light", "ultralight");
    let mut out: Vec<u32> = Vec::new();
    for tok in s.split(|c: char| c == ';' || c == '|' || c == '+' || c == '/' || c.is_whitespace())
    {
        if tok.is_empty() {
            continue;
        }
        if let Ok(n) = tok.parse::<f64>() {
            if (1.0..=1000.0).contains(&n) {
                out.push(n.round() as u32);
                continue;
            }
        }
        if let Some(w) = weight_word(tok) {
            out.push(w);
        }
    }
    out.sort_unstable();
    out.dedup();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn parse_bool(raw: Option<&str>) -> Option<bool> {
    let s = raw.unwrap_or("").trim().to_lowercase();
    match s.as_str() {
        "" => None,
        "1" | "y" | "yes" | "true" | "on" | "italic" | "italics" => Some(true),
        "0" | "n" | "no" | "false" | "off" | "none" => Some(false),
        _ => None,
    }
}

pub fn parse_source(raw: Option<&str>) -> String {
    match raw.unwrap_or("").trim().to_lowercase().as_str() {
        "google" | "google fonts" | "gf" => "google".into(),
        "fontsource" | "fs" => "fontsource".into(),
        _ => "auto".into(),
    }
}

fn make_entry(
    family: &str,
    weights: Option<&str>,
    italic: Option<&str>,
    source: Option<&str>,
    line: usize,
) -> Entry {
    let w = parse_weights(weights);
    let it = parse_bool(italic);
    Entry {
        family: family.split_whitespace().collect::<Vec<_>>().join(" "),
        italics: it.unwrap_or(w.is_none()),
        weights: w,
        source: parse_source(source),
        line,
    }
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

const FAMILY_HEADERS: &[&str] = &[
    "family",
    "name",
    "font",
    "fontfamily",
    "font family",
    "font_family",
    "font-family",
    "typeface",
];
const WEIGHT_HEADERS: &[&str] = &["weights", "weight", "styles", "style"];
const ITALIC_HEADERS: &[&str] = &["italic", "italics"];
const SOURCE_HEADERS: &[&str] = &["source", "provider", "library"];

fn detect_delimiter(line: &str) -> char {
    let mut best = (',', 0usize);
    for d in [',', ';', '\t'] {
        let n = line.matches(d).count();
        if n > best.1 {
            best = (d, n);
        }
    }
    best.0
}

/// RFC 4180-ish: quoted fields, doubled quotes, no multi-line fields.
pub fn split_csv_line(line: &str, delimiter: char) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if quoted {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    cur.push('"');
                    chars.next();
                } else {
                    quoted = false;
                }
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            quoted = true;
        } else if ch == delimiter {
            out.push(cur.trim().to_string());
            cur = String::new();
        } else {
            cur.push(ch);
        }
    }
    out.push(cur.trim().to_string());
    out
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{FEFF}').unwrap_or(text)
}

pub fn parse_csv(text: &str) -> Parsed {
    let mut parsed = Parsed {
        format: "csv",
        ..Default::default()
    };
    let content: Vec<(usize, &str)> = strip_bom(text)
        .lines()
        .enumerate()
        .map(|(i, l)| (i + 1, l))
        .filter(|(_, l)| !l.trim().is_empty() && !l.trim().starts_with('#'))
        .collect();
    let Some(&(_, first)) = content.first() else {
        return parsed;
    };
    let delimiter = detect_delimiter(first);
    let head: Vec<String> = split_csv_line(first, delimiter)
        .iter()
        .map(|h| h.to_lowercase())
        .collect();
    let idx = |set: &[&str]| head.iter().position(|h| set.contains(&h.as_str()));

    let (cols, start) = if head.iter().any(|h| FAMILY_HEADERS.contains(&h.as_str())) {
        (
            (
                idx(FAMILY_HEADERS),
                idx(WEIGHT_HEADERS),
                idx(ITALIC_HEADERS),
                idx(SOURCE_HEADERS),
            ),
            1,
        )
    } else {
        ((Some(0), Some(1), Some(2), Some(3)), 0)
    };

    for &(line, raw) in &content[start..] {
        let cells = split_csv_line(raw, delimiter);
        let cell = |i: Option<usize>| {
            i.and_then(|i| cells.get(i))
                .map(|s| s.as_str())
                .filter(|s| !s.is_empty())
        };
        match cell(cols.0) {
            Some(family) => parsed.entries.push(make_entry(
                family,
                cell(cols.1),
                cell(cols.2),
                cell(cols.3),
                line,
            )),
            None => parsed
                .errors
                .push(format!("line {line}: no family name in this row")),
        }
    }
    parsed
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

pub fn parse_xml(text: &str) -> Parsed {
    let mut parsed = Parsed {
        format: "xml",
        ..Default::default()
    };
    let doc = match roxmltree::Document::parse(strip_bom(text)) {
        Ok(d) => d,
        Err(e) => {
            parsed.errors.push(format!("not well-formed XML: {e}"));
            return parsed;
        }
    };
    let mut found = 0;
    for node in doc.descendants().filter(|n| n.is_element()) {
        let tag = node.tag_name().name().to_ascii_lowercase();
        if tag != "font" && tag != "family" && tag != "typeface" {
            continue;
        }
        // A <family> child inside a <font> is a field, not an entry.
        if tag == "family"
            && node
                .parent()
                .is_some_and(|p| p.tag_name().name().eq_ignore_ascii_case("font"))
        {
            continue;
        }
        found += 1;
        let line = doc.text_pos_at(node.range().start).row as usize;
        let attr = |names: &[&str]| {
            names
                .iter()
                .find_map(|n| node.attribute(*n).map(|v| v.to_string()))
        };
        let child = |name: &str| -> Vec<String> {
            node.children()
                .filter(|c| c.is_element() && c.tag_name().name().eq_ignore_ascii_case(name))
                .filter_map(|c| c.text().map(|t| t.trim().to_string()))
                .filter(|t| !t.is_empty())
                .collect()
        };
        let own_text: String = node
            .children()
            .filter(|c| c.is_text())
            .filter_map(|c| c.text())
            .collect::<String>()
            .trim()
            .to_string();
        let family = attr(&["family", "name"])
            .or_else(|| child("family").into_iter().next())
            .or_else(|| child("name").into_iter().next())
            .unwrap_or(own_text);
        if family.is_empty() {
            parsed.errors.push(format!(
                "line {line}: <{}> has no family name",
                node.tag_name().name()
            ));
            continue;
        }
        let mut weights: Vec<String> = attr(&["weights", "weight"]).into_iter().collect();
        weights.extend(child("weight"));
        weights.extend(child("weights"));
        let weights = weights.join(" ");
        let italic = attr(&["italic", "italics"]).or_else(|| child("italic").into_iter().next());
        let source = attr(&["source", "provider"]).or_else(|| child("source").into_iter().next());
        parsed.entries.push(make_entry(
            &family,
            if weights.is_empty() {
                None
            } else {
                Some(&weights)
            },
            italic.as_deref(),
            source.as_deref(),
            line,
        ));
    }
    if found == 0 {
        parsed.errors.push("no <font> elements found".into());
    }
    parsed
}

/* ------------------------------------------------------------------ */
/* TXT, detection                                                      */
/* ------------------------------------------------------------------ */

pub fn parse_txt(text: &str) -> Parsed {
    let mut parsed = Parsed {
        format: "txt",
        ..Default::default()
    };
    for (i, raw) in strip_bom(text).lines().enumerate() {
        let s = raw.trim();
        if s.is_empty() || s.starts_with('#') {
            continue;
        }
        parsed.entries.push(make_entry(s, None, None, None, i + 1));
    }
    parsed
}

pub fn detect_format(text: &str, filename: &str) -> &'static str {
    let ext = filename
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "xml" => return "xml",
        "csv" | "tsv" => return "csv",
        "txt" | "list" => return "txt",
        _ => {}
    }
    let head = strip_bom(text).trim_start();
    if head.starts_with('<') {
        return "xml";
    }
    let lines: Vec<&str> = head
        .lines()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
        .collect();
    if lines.is_empty() {
        return "txt";
    }
    let delimited = lines
        .iter()
        .filter(|l| l.contains(',') || l.contains(';') || l.contains('\t'))
        .count();
    if delimited * 2 >= lines.len() {
        "csv"
    } else {
        "txt"
    }
}

pub fn is_list_filename(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".csv")
        || lower.ends_with(".tsv")
        || lower.ends_with(".xml")
        || lower.ends_with(".txt")
        || lower.ends_with(".list")
}

pub fn parse_list(text: &str, filename: &str) -> Parsed {
    match detect_format(text, filename) {
        "xml" => parse_xml(text),
        "csv" => parse_csv(text),
        _ => parse_txt(text),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights() {
        assert_eq!(parse_weights(Some("400;700")), Some(vec![400, 700]));
        assert_eq!(parse_weights(Some("bold+light")), Some(vec![300, 700]));
        assert_eq!(parse_weights(Some("Semi Bold")), Some(vec![600]));
        assert_eq!(parse_weights(Some("all")), None);
        assert_eq!(parse_weights(None), None);
        assert_eq!(parse_weights(Some("nonsense")), None);
    }

    #[test]
    fn csv_with_header_in_any_order() {
        let p = parse_csv("source,italic,family,weights\ngoogle,no,Poppins,400;700\n,,Inter,\n");
        assert!(p.errors.is_empty());
        assert_eq!(p.entries.len(), 2);
        assert_eq!(
            p.entries[0],
            Entry {
                family: "Poppins".into(),
                weights: Some(vec![400, 700]),
                italics: false,
                source: "google".into(),
                line: 2
            }
        );
        assert_eq!(
            p.entries[1],
            Entry {
                family: "Inter".into(),
                weights: None,
                italics: true,
                source: "auto".into(),
                line: 3
            }
        );
    }

    #[test]
    fn csv_positional_quoted_bom_crlf_comments() {
        let p = parse_csv("\u{FEFF}# comment\r\n\"Noto Sans \"\"JP\"\"\";400;yes\r\nAbel\r\n");
        assert_eq!(p.entries[0].family, "Noto Sans \"JP\"");
        assert_eq!(p.entries[0].weights, Some(vec![400]));
        assert!(p.entries[0].italics);
        assert_eq!(p.entries[1].family, "Abel");
        assert_eq!(p.entries[1].weights, None);
    }

    #[test]
    fn xml_forms() {
        let xml = r#"<?xml version="1.0"?>
<!-- fonts -->
<fontList>
  <font family="Poppins" weights="400 700" italic="true" source="google"/>
  <font>Inter</font>
  <font name="Playfair Display"><weight>700</weight><weight>900</weight><italic>no</italic></font>
  <group><Family family="Lato &amp; friends"/></group>
  <font><family>Abel</family></font>
</fontList>"#;
        let p = parse_xml(xml);
        assert!(p.errors.is_empty(), "{:?}", p.errors);
        let names: Vec<&str> = p.entries.iter().map(|e| e.family.as_str()).collect();
        assert_eq!(
            names,
            [
                "Poppins",
                "Inter",
                "Playfair Display",
                "Lato & friends",
                "Abel"
            ]
        );
        assert_eq!(p.entries[0].weights, Some(vec![400, 700]));
        assert!(p.entries[0].italics);
        assert_eq!(p.entries[2].weights, Some(vec![700, 900]));
        assert!(!p.entries[2].italics);
        assert_eq!(p.entries[1].line, 5);
    }

    #[test]
    fn detection_and_txt() {
        assert_eq!(detect_format("<fonts/>", "x.csv"), "csv");
        assert_eq!(detect_format("  <fonts/>", ""), "xml");
        assert_eq!(detect_format("Poppins\nInter\n", ""), "txt");
        assert_eq!(detect_format("Poppins,400\nInter,700\n", ""), "csv");
        let p = parse_list("Poppins\n# c\nInter", "");
        assert_eq!(p.entries.len(), 2);
        assert_eq!(p.format, "txt");
    }

    #[test]
    fn shared_examples_parse() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples");
        for name in ["fonts.csv", "fonts.xml", "fonts.txt"] {
            let text = std::fs::read_to_string(dir.join(name)).unwrap();
            let p = parse_list(&text, name);
            assert!(p.errors.is_empty(), "{name}: {:?}", p.errors);
            assert!(p.entries.iter().any(|e| e.family == "Poppins"), "{name}");
        }
    }
}
