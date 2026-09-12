//! A small WebDAV client: enough to walk a collection and fetch files.
//!
//! An SMB or NFS share is mounted by the OS and read as a folder. WebDAV can
//! be mounted the same way, but it is also plain HTTP, so a URL works without
//! any mount at all — useful on a machine where nobody is around to mount
//! things at login. PROPFIND with `Depth: 1`, one request per collection,
//! recursing into sub-collections; GET for the files.

use std::sync::atomic::AtomicBool;
use std::time::Duration;

use reqwest::blocking::Client;
use reqwest::Method;

#[derive(Debug, Clone)]
pub struct Entry {
    /// Absolute URL of the file.
    pub url: String,
    /// Path relative to the root collection, e.g. `serif/Foo-Regular.ttf`.
    pub rel: String,
    pub name: String,
    pub size: Option<u64>,
}

pub struct Dav {
    client: Client,
    root: String,
    username: Option<String>,
    password: Option<String>,
}

impl Dav {
    pub fn new(root: &str, username: Option<&str>, password: Option<&str>) -> Result<Dav, String> {
        let client = Client::builder()
            .user_agent(format!("openfont-manager/{}", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(60))
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("Could not build an HTTP client: {e}"))?;
        let mut root = root.trim().to_string();
        if !root.ends_with('/') {
            root.push('/');
        }
        Ok(Dav {
            client,
            root,
            username: username.filter(|u| !u.is_empty()).map(String::from),
            password: password.map(String::from),
        })
    }

    fn auth(&self, req: reqwest::blocking::RequestBuilder) -> reqwest::blocking::RequestBuilder {
        match &self.username {
            Some(u) => req.basic_auth(u, self.password.as_deref()),
            None => req,
        }
    }

    /// Every file under the root, any depth.
    pub fn walk(&self, cancel: &AtomicBool) -> Result<Vec<Entry>, String> {
        let mut out = Vec::new();
        let mut queue = vec![self.root.clone()];
        let mut seen = std::collections::HashSet::new();
        while let Some(dir) = queue.pop() {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            if !seen.insert(dir.clone()) {
                continue;
            }
            // A runaway tree is a misconfiguration, not a font library.
            if seen.len() > 2000 {
                return Err(
                    "More than 2,000 collections under this URL; refusing to walk further.".into(),
                );
            }
            let (files, dirs) = self.list(&dir)?;
            out.extend(files);
            queue.extend(dirs);
        }
        Ok(out)
    }

    /// One PROPFIND at depth 1: the files and sub-collections directly inside `dir`.
    fn list(&self, dir: &str) -> Result<(Vec<Entry>, Vec<String>), String> {
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>"#;
        let method = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;
        let req = self
            .client
            .request(method, dir)
            .header("Depth", "1")
            .header("Content-Type", "application/xml; charset=utf-8")
            .body(body);
        let res = self
            .auth(req)
            .send()
            .map_err(|e| format!("PROPFIND {dir}: {e}"))?;
        let status = res.status();
        if status == 401 || status == 403 {
            return Err(format!(
                "{status} for {dir} — check the username and password"
            ));
        }
        if !(status.is_success() || status.as_u16() == 207) {
            return Err(format!("{status} for PROPFIND {dir}"));
        }
        let text = res.text().map_err(|e| e.to_string())?;
        parse_multistatus(&text, dir, &self.root)
    }

    pub fn get(&self, url: &str) -> Result<Vec<u8>, String> {
        let res = self
            .auth(self.client.get(url))
            .send()
            .map_err(|e| format!("GET {url}: {e}"))?;
        if !res.status().is_success() {
            return Err(format!("{} for {url}", res.status()));
        }
        res.bytes().map(|b| b.to_vec()).map_err(|e| e.to_string())
    }
}

fn origin_of(url: &str) -> &str {
    // `https://host:port` — everything before the third slash.
    let mut count = 0;
    for (i, ch) in url.char_indices() {
        if ch == '/' {
            count += 1;
            if count == 3 {
                return &url[..i];
            }
        }
    }
    url
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Read a multistatus body: hrefs, which are collections, and sizes.
///
/// `dir` is the collection that was listed (its own entry comes back too and
/// is skipped); `root` is the source's root, for the relative path.
fn parse_multistatus(
    xml: &str,
    dir: &str,
    root: &str,
) -> Result<(Vec<Entry>, Vec<String>), String> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| format!("bad multistatus XML: {e}"))?;
    let origin = origin_of(dir);
    let root_path = percent_decode(root.strip_prefix(origin_of(root)).unwrap_or("/"));
    let dir_path = percent_decode(dir.strip_prefix(origin).unwrap_or("/"));
    let mut files = Vec::new();
    let mut dirs = Vec::new();

    for response in doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "response")
    {
        let Some(href) = response
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "href")
            .and_then(|n| n.text())
            .map(str::trim)
        else {
            continue;
        };
        // hrefs are absolute paths on most servers, full URLs on some.
        let path = if href.starts_with("http://") || href.starts_with("https://") {
            href.strip_prefix(origin_of(href))
                .unwrap_or("/")
                .to_string()
        } else {
            href.to_string()
        };
        let path = percent_decode(&path);
        let is_collection = response
            .descendants()
            .any(|n| n.is_element() && n.tag_name().name() == "collection");
        // The listed collection itself.
        if path.trim_end_matches('/') == dir_path.trim_end_matches('/') {
            continue;
        }
        if is_collection {
            let url = format!("{origin}{}", encode_path(path.trim_end_matches('/')));
            dirs.push(format!("{url}/"));
            continue;
        }
        let name = path.rsplit('/').next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let rel = path
            .strip_prefix(root_path.trim_end_matches('/'))
            .unwrap_or(&path)
            .trim_start_matches('/')
            .to_string();
        let size = response
            .descendants()
            .find(|n| n.is_element() && n.tag_name().name() == "getcontentlength")
            .and_then(|n| n.text())
            .and_then(|t| t.trim().parse::<u64>().ok());
        files.push(Entry {
            url: format!("{origin}{}", encode_path(&path)),
            rel,
            name,
            size,
        });
    }
    Ok((files, dirs))
}

fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for b in path.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_nextcloud_style_multistatus() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/remote.php/dav/files/me/fonts/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/files/me/fonts/Serif%20Fonts/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/remote.php/dav/files/me/fonts/Foo-Regular.ttf</d:href>
    <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>12345</d:getcontentlength></d:prop></d:propstat></d:response>
  <d:response><d:href>https://nas.example.com/remote.php/dav/files/me/fonts/list.csv</d:href>
    <d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
</d:multistatus>"#;
        let root = "https://nas.example.com/remote.php/dav/files/me/fonts/";
        let (files, dirs) = parse_multistatus(xml, root, root).unwrap();
        assert_eq!(
            dirs,
            ["https://nas.example.com/remote.php/dav/files/me/fonts/Serif%20Fonts/"]
        );
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].name, "Foo-Regular.ttf");
        assert_eq!(files[0].rel, "Foo-Regular.ttf");
        assert_eq!(files[0].size, Some(12345));
        assert_eq!(
            files[0].url,
            "https://nas.example.com/remote.php/dav/files/me/fonts/Foo-Regular.ttf"
        );
        assert_eq!(files[1].name, "list.csv");

        let sub = "https://nas.example.com/remote.php/dav/files/me/fonts/Serif%20Fonts/";
        let xml2 = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/remote.php/dav/files/me/fonts/Serif%20Fonts/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/me/fonts/Serif%20Fonts/Bar.otf</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>"#;
        let (files, dirs) = parse_multistatus(xml2, sub, root).unwrap();
        assert!(dirs.is_empty());
        assert_eq!(files[0].rel, "Serif Fonts/Bar.otf");
        assert_eq!(
            files[0].url,
            "https://nas.example.com/remote.php/dav/files/me/fonts/Serif%20Fonts/Bar.otf"
        );
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("plain"), "plain");
        assert_eq!(percent_decode("bad%"), "bad%");
    }
}
