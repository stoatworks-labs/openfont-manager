/**
 * Downloading: retries, mirrors, a concurrency-limited queue, and the one
 * check that matters — that what came back is a font.
 *
 * `fetch` here is whatever the caller passes (the browser's, or a shim in
 * tests), so this file stays free of globals and runs under node.
 */

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>

/** True when the bytes begin with a real sfnt signature. */
export function isSfnt(data: Uint8Array): boolean {
  if (data.length < 4) return false
  const b0 = data[0]!
  const b1 = data[1]!
  const b2 = data[2]!
  const b3 = data[3]!
  if (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return true
  const tag = String.fromCharCode(b0, b1, b2, b3)
  return tag === 'OTTO' || tag === 'true' || tag === 'ttcf'
}

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly url: string,
    public readonly status?: number,
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(signal.reason ?? new Error('aborted'))
      },
      { once: true },
    )
  })

export interface FetchOptions {
  fetch: FetchLike
  signal?: AbortSignal
  /** Attempts per URL before moving to the next mirror. */
  attempts?: number
  /** Require an sfnt signature (fonts). Off for licence text. */
  expectFont?: boolean
}

/**
 * Fetch one file, trying the primary URL then each mirror.
 *
 * A 429 or 5xx is retried with backoff on the same URL; a 404 moves straight
 * to the next mirror (the file is simply not there); a network error is
 * retried too, since raw.githubusercontent.com does drop connections under
 * a bulk pull. The last error wins if every URL fails.
 */
export async function fetchBytes(urls: string[], opts: FetchOptions): Promise<{ data: Uint8Array; url: string }> {
  const attempts = opts.attempts ?? 3
  let lastErr: Error = new DownloadError('No URL to fetch.', urls[0] ?? '')
  for (const url of urls) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      opts.signal?.throwIfAborted()
      try {
        const res = await opts.fetch(url, { signal: opts.signal })
        if (res.status === 404 || res.status === 403) {
          lastErr = new DownloadError(`${res.status} for ${url}`, url, res.status)
          break // try the next mirror
        }
        if (!res.ok) {
          lastErr = new DownloadError(`${res.status} for ${url}`, url, res.status)
          if (attempt < attempts) await sleep(backoff(attempt, res), opts.signal)
          continue
        }
        const data = new Uint8Array(await res.arrayBuffer())
        if (opts.expectFont !== false && !isSfnt(data)) {
          // An HTML error page with a 200, or a truncated body. Never pass it
          // on: it would be written into a font directory under a font's name.
          lastErr = new DownloadError(`Not a font file (${data.length} bytes) from ${url}`, url, res.status)
          break
        }
        return { data, url }
      } catch (e) {
        if (opts.signal?.aborted) throw e
        lastErr = e instanceof Error ? e : new Error(String(e))
        if (attempt < attempts) await sleep(backoff(attempt), opts.signal)
      }
    }
  }
  throw lastErr
}

function backoff(attempt: number, res?: Response): number {
  const retryAfter = res?.headers?.get?.('retry-after')
  if (retryAfter && /^\d+$/.test(retryAfter)) return Math.min(30_000, Number(retryAfter) * 1000)
  return 500 * 2 ** (attempt - 1) + Math.random() * 300
}

export interface QueueProgress {
  done: number
  failed: number
  total: number
  /** Bytes received so far. */
  bytes: number
  /** What is being fetched right now. */
  active: string[]
}

/**
 * Run `work` over `items` with at most `concurrency` in flight.
 *
 * Failures are collected, not thrown — a bulk pull of two thousand families
 * must not stop because one file 404s. The caller decides what to do with
 * the list of misses.
 */
export async function runQueue<T, R>(
  items: T[],
  concurrency: number,
  work: (item: T) => Promise<R>,
  hooks: {
    label: (item: T) => string
    onResult?: (item: T, result: R) => void
    onError?: (item: T, error: Error) => void
    onProgress?: (p: QueueProgress) => void
    bytesOf?: (result: R) => number
    signal?: AbortSignal
  },
): Promise<{ failures: Array<{ item: T; error: Error }> }> {
  const failures: Array<{ item: T; error: Error }> = []
  const progress: QueueProgress = { done: 0, failed: 0, total: items.length, bytes: 0, active: [] }
  let next = 0

  const report = () => hooks.onProgress?.({ ...progress, active: [...progress.active] })

  async function worker(): Promise<void> {
    while (next < items.length) {
      if (hooks.signal?.aborted) return
      const item = items[next++]!
      const label = hooks.label(item)
      progress.active.push(label)
      report()
      try {
        const result = await work(item)
        progress.done++
        progress.bytes += hooks.bytesOf?.(result) ?? 0
        hooks.onResult?.(item, result)
      } catch (e) {
        if (hooks.signal?.aborted) return
        const error = e instanceof Error ? e : new Error(String(e))
        progress.failed++
        failures.push({ item, error })
        hooks.onError?.(item, error)
      } finally {
        progress.active.splice(progress.active.indexOf(label), 1)
        report()
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
  return { failures }
}
