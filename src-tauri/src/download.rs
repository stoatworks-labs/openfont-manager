//! Downloading: retries, mirrors, a small worker pool, and the one check that
//! matters — that what came back is a font. Mirrors `src/core/fetch.ts`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::fonts::is_sfnt;

/// One file to fetch — the same shape the frontend's `PlanItem` has.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub family: String,
    pub family_id: String,
    pub source: String,
    pub license: String,
    pub filename: String,
    pub url: String,
    #[serde(default)]
    pub mirrors: Vec<String>,
    #[serde(default)]
    pub weight: u32,
    #[serde(default)]
    pub italic: bool,
    #[serde(default)]
    pub variable: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: usize,
    pub failed: usize,
    pub total: usize,
    pub bytes: u64,
    pub active: Vec<String>,
}

pub struct Fetched {
    pub data: Vec<u8>,
    pub url: String,
}

pub fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent(format!("openfont-manager/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Could not build an HTTP client: {e}"))
}

/// Fetch one file, trying the primary URL then each mirror.
///
/// A 429 or 5xx is retried with backoff on the same URL; a 404 moves straight
/// to the next mirror; a network error is retried too. `expect_font` rejects
/// anything without an sfnt signature — an HTML error page with a 200 must
/// never reach a font directory.
pub fn fetch_bytes(
    client: &reqwest::blocking::Client,
    urls: &[String],
    expect_font: bool,
    attempts: u32,
    cancel: &AtomicBool,
) -> Result<Fetched, String> {
    let mut last = format!(
        "no URL to fetch for {}",
        urls.first().map(String::as_str).unwrap_or("?")
    );
    'urls: for url in urls {
        for attempt in 1..=attempts {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".into());
            }
            match client.get(url).send() {
                Ok(res) => {
                    let status = res.status();
                    if status == 404 || status == 403 {
                        last = format!("{status} for {url}");
                        continue 'urls;
                    }
                    if !status.is_success() {
                        last = format!("{status} for {url}");
                        let retry_after = res
                            .headers()
                            .get("retry-after")
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.parse::<u64>().ok());
                        if attempt < attempts {
                            sleep_backoff(attempt, retry_after, cancel);
                        }
                        continue;
                    }
                    match res.bytes() {
                        Ok(bytes) => {
                            let data = bytes.to_vec();
                            if expect_font && !is_sfnt(&data) {
                                last = format!("not a font file ({} bytes) from {url}", data.len());
                                continue 'urls;
                            }
                            return Ok(Fetched {
                                data,
                                url: url.clone(),
                            });
                        }
                        Err(e) => {
                            last = format!("{e} reading {url}");
                            if attempt < attempts {
                                sleep_backoff(attempt, None, cancel);
                            }
                        }
                    }
                }
                Err(e) => {
                    last = format!("{e}");
                    if attempt < attempts {
                        sleep_backoff(attempt, None, cancel);
                    }
                }
            }
        }
    }
    Err(last)
}

fn sleep_backoff(attempt: u32, retry_after: Option<u64>, cancel: &AtomicBool) {
    let ms = match retry_after {
        Some(s) => (s * 1000).min(30_000),
        None => 500 * 2u64.pow(attempt - 1),
    };
    // Sleep in slices so a cancel does not wait out a long backoff.
    let mut left = ms;
    while left > 0 && !cancel.load(Ordering::Relaxed) {
        let step = left.min(200);
        std::thread::sleep(Duration::from_millis(step));
        left -= step;
    }
}

type Slots<T> = Arc<Mutex<Vec<Option<Result<T, String>>>>>;

pub struct Outcome<T> {
    pub item: Item,
    pub result: Result<T, String>,
}

/// Run `work` over `items` on `concurrency` threads.
///
/// Results come back in the original order. Failures are collected, not
/// fatal — a bulk pull of two thousand families must not stop because one
/// file 404s. `on_progress` is called after every completion and whenever
/// the active set changes.
pub fn run_pool<T: Send + 'static>(
    items: Vec<Item>,
    concurrency: usize,
    cancel: Arc<AtomicBool>,
    work: impl Fn(&Item) -> Result<T, String> + Send + Sync + 'static,
    size_of: impl Fn(&T) -> u64 + Send + Sync + 'static,
    on_progress: impl Fn(&Progress) + Send + Sync + 'static,
) -> Vec<Outcome<T>> {
    let total = items.len();
    let items = Arc::new(items);
    let next = Arc::new(AtomicUsize::new(0));
    let results: Slots<T> = Arc::new(Mutex::new((0..total).map(|_| None).collect()));
    let progress = Arc::new(Mutex::new(Progress {
        total,
        ..Default::default()
    }));
    let work = Arc::new(work);
    let size_of = Arc::new(size_of);
    let on_progress = Arc::new(on_progress);

    let workers = concurrency.clamp(1, 16).min(total.max(1));
    let handles: Vec<_> = (0..workers)
        .map(|_| {
            let items = Arc::clone(&items);
            let next = Arc::clone(&next);
            let results = Arc::clone(&results);
            let progress = Arc::clone(&progress);
            let work = Arc::clone(&work);
            let size_of = Arc::clone(&size_of);
            let on_progress = Arc::clone(&on_progress);
            let cancel = Arc::clone(&cancel);
            std::thread::spawn(move || loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                if i >= items.len() {
                    return;
                }
                let item = &items[i];
                let label = format!("{} / {}", item.family, item.filename);
                {
                    let mut p = progress.lock().unwrap();
                    p.active.push(label.clone());
                    on_progress(&p);
                }
                let result = work(item);
                {
                    let mut p = progress.lock().unwrap();
                    p.active.retain(|a| a != &label);
                    match &result {
                        Ok(v) => {
                            p.done += 1;
                            p.bytes += size_of(v);
                        }
                        Err(_) => p.failed += 1,
                    }
                    on_progress(&p);
                }
                results.lock().unwrap()[i] = Some(result);
            })
        })
        .collect();
    for h in handles {
        let _ = h.join();
    }

    let items = Arc::try_unwrap(items).unwrap_or_else(|a| (*a).clone());
    let results = Arc::try_unwrap(results)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_default();
    items
        .into_iter()
        .zip(results)
        .map(|(item, r)| Outcome {
            item,
            result: r.unwrap_or_else(|| Err("cancelled".into())),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_keeps_order_and_collects_failures() {
        let items: Vec<Item> = (0..10)
            .map(|i| Item {
                family: format!("F{i}"),
                family_id: "x".into(),
                source: "google".into(),
                license: "OFL-1.1".into(),
                filename: format!("{i}.ttf"),
                url: String::new(),
                mirrors: vec![],
                weight: 400,
                italic: false,
                variable: false,
            })
            .collect();
        let cancel = Arc::new(AtomicBool::new(false));
        let out = run_pool(
            items,
            3,
            cancel,
            |item| {
                std::thread::sleep(Duration::from_millis(3));
                if item.filename.starts_with('4') {
                    Err("boom".into())
                } else {
                    Ok(item.filename.len())
                }
            },
            |n| *n as u64,
            |_| {},
        );
        assert_eq!(out.len(), 10);
        for (i, o) in out.iter().enumerate() {
            assert_eq!(o.item.filename, format!("{i}.ttf"));
        }
        assert!(out[4].result.is_err());
        assert!(out[5].result.is_ok());
    }
}
