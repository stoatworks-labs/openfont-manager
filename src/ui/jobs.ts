import { downloadBundle } from '../core/bundle'
import type { QueueProgress } from '../core/fetch'
import { buildPlan, estimateBytes } from '../core/plan'
import type { CartItem, PlanItem } from '../core/types'
import { native, onNativeEvent, type DownloadProgress, type InstallReport, type SaveReport } from '../platform/native'
import { canStream, openSaveTarget, SaveCancelled } from '../platform/save'

/**
 * The long-running things the cart can do, with one progress shape for all
 * of them so the sidebar renders them the same way.
 */

export type JobKind = 'zip' | 'install' | 'save'

export interface JobFailure {
  family: string
  filename: string
  error: string
}

export interface Job {
  kind: JobKind
  phase: 'running' | 'finishing' | 'done' | 'failed' | 'cancelled'
  progress: QueueProgress
  /** Multi-part zip on a browser that cannot stream. */
  part?: { current: number; total: number }
  summary?: string
  failures: JobFailure[]
  note?: string
  error?: string
}

const EMPTY: QueueProgress = { done: 0, failed: 0, total: 0, bytes: 0, active: [] }

/** Largest single zip to build in memory when streaming is unavailable. */
const PART_BYTES = 500 * 1024 * 1024
const SPLIT_ABOVE = 600 * 1024 * 1024

export function bundleFilename(part?: { current: number; total: number }): string {
  const date = new Date().toISOString().slice(0, 10)
  return part && part.total > 1 ? `openfont-bundle-${date}-part${part.current}of${part.total}.zip` : `openfont-bundle-${date}.zip`
}

/** Split cart items into parts of roughly PART_BYTES each, whole families only. */
export function splitIntoParts(items: CartItem[]): CartItem[][] {
  const parts: CartItem[][] = []
  let current: CartItem[] = []
  let size = 0
  for (const item of items) {
    const bytes = estimateBytes([item])
    if (current.length && size + bytes > PART_BYTES) {
      parts.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += bytes
  }
  if (current.length) parts.push(current)
  return parts
}

export interface JobControl {
  cancel: () => void
  finished: Promise<void>
}

export function startZipJob(
  items: CartItem[],
  opts: { compress: boolean; licences: boolean },
  update: (job: Job) => void,
): JobControl {
  const controller = new AbortController()
  const total = estimateBytes(items)
  const parts = !canStream() && total > SPLIT_ABOVE ? splitIntoParts(items) : [items]
  const failures: JobFailure[] = []
  let job: Job = { kind: 'zip', phase: 'running', progress: EMPTY, failures }
  const emit = (patch: Partial<Job>) => {
    job = { ...job, ...patch }
    update(job)
  }

  const finished = (async () => {
    let entries = 0
    let bytes = 0
    try {
      for (let p = 0; p < parts.length; p++) {
        const part = { current: p + 1, total: parts.length }
        const plan = buildPlan(parts[p]!)
        const target = await openSaveTarget(bundleFilename(part))
        emit({ part, progress: { ...EMPTY, total: plan.length } })
        try {
          const result = await downloadBundle(plan, {
            fetch: (url, init) => fetch(url, init),
            sink: target.sink,
            title: `OpenFont bundle — ${items.length} famil${items.length === 1 ? 'y' : 'ies'}`,
            compress: opts.compress,
            licences: opts.licences,
            signal: controller.signal,
            onProgress: (progress) => emit({ progress, phase: progress.phase === 'finishing' ? 'finishing' : 'running' }),
          })
          await target.close()
          entries += result.entries.length
          bytes += result.bytes
          for (const f of result.failures) failures.push({ family: f.item.family, filename: f.item.filename, error: f.error })
        } catch (e) {
          await target.abort()
          throw e
        }
      }
      const mb = (bytes / 1024 / 1024).toFixed(1)
      emit({
        phase: 'done',
        summary: `${entries.toLocaleString()} file${entries === 1 ? '' : 's'} (${mb} MB) in ${parts.length} zip${parts.length === 1 ? '' : 's'}.`,
        note: canStream() ? undefined : 'This browser cannot stream to disk, so each zip was built in memory first.',
      })
    } catch (e) {
      if (e instanceof SaveCancelled || controller.signal.aborted) {
        emit({ phase: 'cancelled' })
      } else {
        emit({ phase: 'failed', error: (e as Error).message })
      }
    }
  })()

  return { cancel: () => controller.abort(), finished }
}

function toProgress(p: DownloadProgress): QueueProgress {
  return { done: p.done, failed: p.failed, total: p.total, bytes: p.bytes, active: p.active }
}

/** Desktop: download natively and install into the user font directory. */
export function startInstallJob(items: CartItem[], update: (job: Job) => void): JobControl {
  const plan: PlanItem[] = buildPlan(items)
  let job: Job = { kind: 'install', phase: 'running', progress: { ...EMPTY, total: plan.length }, failures: [] }
  const emit = (patch: Partial<Job>) => {
    job = { ...job, ...patch }
    update(job)
  }
  let cancelled = false
  const finished = (async () => {
    const off = await onNativeEvent<DownloadProgress>('download-progress', (p) => emit({ progress: toProgress(p) }))
    try {
      const report: InstallReport = await native.installPlan(plan)
      const failures = report.outcomes
        .filter((o) => o.status === 'failed')
        .map((o) => ({ family: '', filename: o.filename, error: o.detail ?? 'failed' }))
      emit({
        phase: cancelled ? 'cancelled' : 'done',
        failures,
        summary: `${report.installed} installed, ${report.skipped} already present, ${report.failed} failed — in ${report.dir}`,
        note: report.note ?? undefined,
      })
    } catch (e) {
      emit({ phase: cancelled ? 'cancelled' : 'failed', error: String(e) })
    } finally {
      off()
    }
  })()
  return {
    cancel: () => {
      cancelled = true
      void native.cancelDownload()
    },
    finished,
  }
}

/** Desktop: download natively into a folder of the user's choosing. */
export function startSaveJob(items: CartItem[], dest: string, update: (job: Job) => void): JobControl {
  const plan: PlanItem[] = buildPlan(items)
  let job: Job = { kind: 'save', phase: 'running', progress: { ...EMPTY, total: plan.length }, failures: [] }
  const emit = (patch: Partial<Job>) => {
    job = { ...job, ...patch }
    update(job)
  }
  let cancelled = false
  const finished = (async () => {
    const off = await onNativeEvent<DownloadProgress>('download-progress', (p) => emit({ progress: toProgress(p) }))
    try {
      const report: SaveReport = await native.savePlan(plan, dest)
      emit({
        phase: cancelled ? 'cancelled' : 'done',
        failures: report.failures.map((f) => ({ family: '', filename: f.filename, error: f.error })),
        summary: `${report.saved} file${report.saved === 1 ? '' : 's'} saved to ${report.dir}${report.failed ? `, ${report.failed} failed` : ''}`,
      })
    } catch (e) {
      emit({ phase: cancelled ? 'cancelled' : 'failed', error: String(e) })
    } finally {
      off()
    }
  })()
  return {
    cancel: () => {
      cancelled = true
      void native.cancelDownload()
    },
    finished,
  }
}
