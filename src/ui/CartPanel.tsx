import { useState } from 'react'
import { toCSV, toXML } from '../core/lists'
import { buildPlan, estimateBytes, formatBytes } from '../core/plan'
import { isDesktop } from '../platform/native'
import { canStream, saveText } from '../platform/save'
import { weightLabel } from './FontCard'
import type { Job } from './jobs'
import type { Cart } from './useCart'
import type { Jobs } from './useJobs'

interface Props {
  cart: Cart
  jobs: Jobs
}

export function CartPanel({ cart, jobs }: Props) {
  const [compress, setCompress] = useState(true)
  const [licences, setLicences] = useState(true)

  const items = cart.items
  const plan = buildPlan(items)
  const bytes = estimateBytes(items)
  const { job, busy } = jobs
  const desktop = isDesktop()

  const exportList = (format: 'csv' | 'xml') => {
    const date = new Date().toISOString().slice(0, 10)
    if (format === 'csv') saveText(`fonts-${date}.csv`, toCSV(items), 'text/csv')
    else saveText(`fonts-${date}.xml`, toXML(items), 'application/xml')
  }

  return (
    <aside className="cart">
      <div className="cart__head">
        <h2>Checkout</h2>
        <span className="muted">
          {items.length.toLocaleString()} famil{items.length === 1 ? 'y' : 'ies'} · {plan.length.toLocaleString()} file
          {plan.length === 1 ? '' : 's'} · ~{formatBytes(bytes)}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="muted cart__empty">
          Add families from the catalogue, or import a list. Everything here downloads as one zip with installer
          scripts{desktop ? ', or installs straight into your font folder' : ''}.
        </p>
      ) : (
        <ul className="cart__list">
          {items.map(({ family, selection }) => (
            <li key={family.id}>
              <div>
                <span className="cart__name">{family.name}</span>
                <span className="muted cart__sel">
                  {selection.weights === 'all'
                    ? `all ${family.files.length} file${family.files.length === 1 ? '' : 's'}`
                    : `${selection.weights.map(weightLabel).join(', ')}${selection.italics ? ' + italics' : ''}`}
                </span>
              </div>
              <button type="button" className="btn btn--ghost btn--xs" onClick={() => cart.remove(family.id)} aria-label={`Remove ${family.name}`}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="cart__actions">
        {desktop && (
          <button type="button" className="btn btn--primary" disabled={items.length === 0 || busy} onClick={() => jobs.install(items)}>
            Install {items.length ? `${items.length.toLocaleString()} famil${items.length === 1 ? 'y' : 'ies'}` : ''}
          </button>
        )}
        <button
          type="button"
          className={`btn ${desktop ? '' : 'btn--primary'}`}
          disabled={items.length === 0 || busy}
          onClick={() => jobs.zip(items, { compress, licences })}
        >
          Download zip
        </button>
        {desktop && (
          <button type="button" className="btn" disabled={items.length === 0 || busy} onClick={() => void jobs.save(items)}>
            Save to folder…
          </button>
        )}
        <div className="cart__opts">
          <label>
            <input type="checkbox" checked={compress} onChange={(e) => setCompress(e.target.checked)} /> compress zip
          </label>
          <label>
            <input type="checkbox" checked={licences} onChange={(e) => setLicences(e.target.checked)} /> include licence texts
          </label>
        </div>
        <div className="cart__row">
          <button type="button" className="btn btn--ghost btn--sm" disabled={items.length === 0} onClick={() => exportList('csv')}>
            Export CSV
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={items.length === 0} onClick={() => exportList('xml')}>
            Export XML
          </button>
          <button type="button" className="btn btn--ghost btn--sm" disabled={items.length === 0 || busy} onClick={cart.clear}>
            Clear
          </button>
        </div>
        {!desktop && !canStream() && bytes > 600 * 1024 * 1024 && (
          <p className="note note--warn">
            This browser cannot stream a download to disk, so a pull this large will be split into zips of about 500 MB,
            each built in memory. Chrome or Edge streams the whole thing; the desktop app writes files directly.
          </p>
        )}
      </div>

      {job && <JobView job={job} onCancel={jobs.cancel} onDismiss={jobs.dismiss} />}
    </aside>
  )
}

function JobView({ job, onCancel, onDismiss }: { job: Job; onCancel?: () => void; onDismiss: () => void }) {
  const { progress } = job
  const pct = progress.total ? Math.round(((progress.done + progress.failed) / progress.total) * 100) : 0
  const title =
    job.kind === 'zip' ? 'Building zip' : job.kind === 'install' ? 'Installing' : 'Saving'
  return (
    <div className={`job job--${job.phase}`}>
      <div className="job__head">
        <strong>
          {job.phase === 'done'
            ? `${title} — done`
            : job.phase === 'failed'
              ? `${title} — failed`
              : job.phase === 'cancelled'
                ? `${title} — cancelled`
                : job.phase === 'finishing'
                  ? `${title} — writing manifest`
                  : title}
          {job.part && job.part.total > 1 ? ` (part ${job.part.current} of ${job.part.total})` : ''}
        </strong>
        {(job.phase === 'running' || job.phase === 'finishing') && onCancel ? (
          <button type="button" className="btn btn--ghost btn--xs" onClick={onCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn--ghost btn--xs" onClick={onDismiss} aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>
      {(job.phase === 'running' || job.phase === 'finishing') && (
        <>
          <div className="bar">
            <div className="bar__fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="muted job__line">
            {progress.done + progress.failed} / {progress.total} · {formatBytes(progress.bytes)}
            {progress.failed ? ` · ${progress.failed} failed` : ''}
          </div>
          {progress.active.length > 0 && <div className="muted job__active">{progress.active.slice(0, 3).join(' · ')}</div>}
        </>
      )}
      {job.summary && <div className="job__line">{job.summary}</div>}
      {job.note && <div className="muted job__line">{job.note}</div>}
      {job.error && <div className="job__line job__error">{job.error}</div>}
      {job.failures.length > 0 && (
        <details className="job__failures">
          <summary>{job.failures.length} file{job.failures.length === 1 ? '' : 's'} could not be fetched</summary>
          <ul>
            {job.failures.slice(0, 50).map((f, i) => (
              <li key={i}>
                {f.family ? `${f.family} / ` : ''}
                {f.filename}: {f.error}
              </li>
            ))}
            {job.failures.length > 50 && <li>…and {job.failures.length - 50} more (see MANIFEST.txt)</li>}
          </ul>
        </details>
      )}
    </div>
  )
}
