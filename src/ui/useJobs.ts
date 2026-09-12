import { useCallback, useState } from 'react'
import type { CartItem } from '../core/types'
import { native } from '../platform/native'
import { startInstallJob, startSaveJob, startZipJob, type Job, type JobControl } from './jobs'

/** One job at a time, shared by the cart and the importer. */
export function useJobs(onFinished?: () => void) {
  const [job, setJob] = useState<Job | null>(null)
  const [control, setControl] = useState<JobControl | null>(null)

  const run = useCallback(
    (start: (update: (j: Job) => void) => JobControl) => {
      const c = start(setJob)
      setControl(c)
      void c.finished.then(() => {
        setControl(null)
        onFinished?.()
      })
    },
    [onFinished],
  )

  const busy = job?.phase === 'running' || job?.phase === 'finishing'

  return {
    job,
    busy,
    cancel: control?.cancel,
    dismiss: () => setJob(null),
    zip: (items: CartItem[], opts: { compress: boolean; licences: boolean }) => run((u) => startZipJob(items, opts, u)),
    install: (items: CartItem[]) => run((u) => startInstallJob(items, u)),
    save: async (items: CartItem[]) => {
      const dest = await native.pickDirectory('Choose a folder for the font files')
      if (dest) run((u) => startSaveJob(items, dest, u))
    },
  }
}

export type Jobs = ReturnType<typeof useJobs>
