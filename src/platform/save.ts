import type { Sink } from '../core/zip'

/**
 * Where the zip bytes go in a browser.
 *
 * Chromium has `showSaveFilePicker`, which hands back a writable stream: the
 * archive goes to disk as it is built and a 2 GB pull costs no memory. Safari
 * and Firefox do not, so there the chunks are collected as blob parts and
 * handed to an `<a download>` at the end — fine for a few hundred megabytes,
 * not for the whole catalogue. `canStream()` lets the UI say which it is
 * and split a huge pull into parts on the fallback path.
 */

declare global {
  interface Window {
    showSaveFilePicker?: (opts: {
      suggestedName?: string
      types?: Array<{ description: string; accept: Record<string, string[]> }>
    }) => Promise<{ createWritable: () => Promise<WritableStream<Uint8Array>> }>
  }
}

export function canStream(): boolean {
  return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'
}

export interface SaveTarget {
  sink: Sink
  /** Resolves once every byte has reached its destination. */
  close: () => Promise<void>
  /** Abandon without leaving a half-written file, where the platform allows. */
  abort: () => Promise<void>
  streamed: boolean
}

export class SaveCancelled extends Error {
  constructor() {
    super('Save cancelled')
    this.name = 'SaveCancelled'
  }
}

export async function openSaveTarget(suggestedName: string): Promise<SaveTarget> {
  if (canStream()) {
    let handle
    try {
      handle = await window.showSaveFilePicker!({
        suggestedName,
        types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
      })
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new SaveCancelled()
      throw e
    }
    const writable = await handle.createWritable()
    const writer = writable.getWriter()
    // Writes are queued on the stream; the sink itself stays synchronous so
    // the zip encoder can call it from inside its own callback.
    let chain: Promise<unknown> = Promise.resolve()
    let failed: Error | null = null
    const sink: Sink = (chunk) => {
      if (failed) return
      chain = chain.then(() => writer.write(chunk)).catch((e) => (failed = e as Error))
    }
    return {
      sink,
      streamed: true,
      close: async () => {
        await chain
        if (failed) throw failed
        await writer.close()
      },
      abort: async () => {
        await chain.catch(() => {})
        await writer.abort().catch(() => {})
      },
    }
  }

  const parts: Uint8Array[] = []
  return {
    sink: (chunk) => {
      if (chunk.length) parts.push(chunk)
    },
    streamed: false,
    close: async () => {
      const blob = new Blob(parts as BlobPart[], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    abort: async () => {
      parts.length = 0
    },
  }
}

/** Save a small text file (a list export) the plain way. */
export function saveText(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
