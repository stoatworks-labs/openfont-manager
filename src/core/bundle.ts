import { familyById } from './catalogue'
import { fetchBytes, runQueue, type FetchLike, type QueueProgress } from './fetch'
import { BundleWriter, type ManifestEntry, type Sink } from './zip'
import type { PlanItem } from './types'

/**
 * The download pipeline: plan -> fetch (with mirrors, limited concurrency)
 * -> streaming zip. Platform-free: the caller supplies `fetch` and a sink.
 */

type Job = { kind: 'font'; item: PlanItem } | { kind: 'licence'; familyId: string; family: string; url: string }

export interface BundleOptions {
  fetch: FetchLike
  sink: Sink
  title: string
  /** Deflate the font files. Text is always compressed. */
  compress?: boolean
  /** Also fetch each family's licence text into its folder. */
  licences?: boolean
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (p: QueueProgress & { phase: 'fetching' | 'finishing' }) => void
}

export interface BundleResult {
  entries: ManifestEntry[]
  failures: Array<{ item: PlanItem; error: string }>
  /** Bytes of font data fetched. */
  bytes: number
}

export async function downloadBundle(plan: PlanItem[], opts: BundleOptions): Promise<BundleResult> {
  const writer = new BundleWriter(opts.sink, { title: opts.title, compress: opts.compress ?? true })

  const jobs: Job[] = plan.map((item) => ({ kind: 'font', item }))
  if (opts.licences !== false) {
    const seen = new Set<string>()
    for (const item of plan) {
      if (seen.has(item.familyId)) continue
      seen.add(item.familyId)
      const url = familyById(item.familyId)?.licenseUrl
      if (url) jobs.push({ kind: 'licence', familyId: item.familyId, family: item.family, url })
    }
  }

  let bytes = 0
  await runQueue(
    jobs,
    opts.concurrency ?? 6,
    async (job) => {
      if (job.kind === 'font') {
        const got = await fetchBytes([job.item.url, ...job.item.mirrors], {
          fetch: opts.fetch,
          signal: opts.signal,
          expectFont: true,
        })
        writer.addFont(job.item, got.data, got.url)
        bytes += got.data.length
        return got.data.length
      }
      try {
        const got = await fetchBytes([job.url], { fetch: opts.fetch, signal: opts.signal, expectFont: false, attempts: 2 })
        const name = job.url.slice(job.url.lastIndexOf('/') + 1) || 'LICENSE.txt'
        writer.addLicence(job.family, name.endsWith('.txt') ? name : `${name}.txt`, got.data)
      } catch {
        // A missing licence file is not a missing font. The manifest still
        // records the SPDX id, which is what matters for the bundle's use.
      }
      return 0
    },
    {
      label: (job) => (job.kind === 'font' ? `${job.item.family} / ${job.item.filename}` : `${job.family} licence`),
      onError: (job, error) => {
        if (job.kind === 'font') writer.noteFailure(job.item, error.message)
      },
      onProgress: (p) => opts.onProgress?.({ ...p, phase: 'fetching' }),
      signal: opts.signal,
    },
  )

  opts.signal?.throwIfAborted()
  opts.onProgress?.({ done: plan.length, failed: 0, total: plan.length, bytes, active: [], phase: 'finishing' })
  const { entries, failures } = writer.end()
  return { entries, failures, bytes }
}
