import { useEffect, useRef, useState } from 'react'
import { ensurePreview, previewFontFamily } from '../platform/preview'
import { formatBytes } from '../core/plan'
import { ALL, type Family, type Selection } from '../core/types'

const WEIGHT_LABEL: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
}

export function weightLabel(w: number): string {
  return WEIGHT_LABEL[w] ?? String(w)
}

interface Props {
  family: Family
  sample: string
  size: number
  inCart: boolean
  selection: Selection | undefined
  installed: boolean
  onAdd: (family: Family, selection: Selection) => void
  onRemove: (id: string) => void
  onSelection: (id: string, selection: Selection) => void
}

export function FontCard({ family, sample, size, inCart, selection, installed, onAdd, onRemove, onSelection }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [open, setOpen] = useState(false)

  // Load the preview face only once the card is on (or near) the screen —
  // two thousand stylesheets at once would be a very slow page.
  useEffect(() => {
    const el = ref.current
    if (!el || visible) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true)
          ensurePreview(family)
          io.disconnect()
        }
      },
      { rootMargin: '400px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [family, visible])

  const sel = selection ?? ALL
  const downloadable = family.files.length > 0
  const styleCount = family.files.length
  const variable = family.axes.length > 0

  const toggleWeight = (w: number) => {
    const current = sel.weights === 'all' ? family.weights : sel.weights
    const next = current.includes(w) ? current.filter((x) => x !== w) : [...current, w].sort((a, b) => a - b)
    const all = next.length === family.weights.length
    const nextSel: Selection = all ? { weights: 'all', italics: sel.italics } : { weights: next, italics: sel.italics }
    if (inCart) onSelection(family.id, nextSel)
    else onAdd(family, nextSel)
  }

  return (
    <div ref={ref} className={`card${inCart ? ' card--in' : ''}`} data-id={family.id}>
      <div className="card__head">
        <div className="card__title">
          <span className="card__name">{family.name}</span>
          <span className="card__meta">
            {family.category}
            {' · '}
            {styleCount === 0 ? 'no files' : `${styleCount} file${styleCount === 1 ? '' : 's'}`}
            {' · '}
            <span className="chip chip--lic" title="Licence (SPDX)">
              {family.license}
            </span>
            <span className={`chip chip--src chip--${family.source}`}>
              {family.source === 'google' ? 'Google Fonts' : 'Fontsource'}
            </span>
            {variable && (
              <span className="chip" title={`Variable axes: ${family.axes.join(', ')}`}>
                variable
              </span>
            )}
            {installed && (
              <span className="chip chip--ok" title="A family of this name is installed on this machine">
                installed
              </span>
            )}
          </span>
        </div>
        <div className="card__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            {open ? 'Less' : 'Styles'}
          </button>
          {inCart ? (
            <button type="button" className="btn btn--sm btn--in" onClick={() => onRemove(family.id)}>
              ✓ Added
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={!downloadable}
              title={downloadable ? 'Add the whole family' : 'This family has no downloadable files'}
              onClick={() => onAdd(family, ALL)}
            >
              Add
            </button>
          )}
        </div>
      </div>

      <div
        className="card__preview"
        style={{
          fontFamily: visible ? previewFontFamily(family) : undefined,
          fontSize: `${size}px`,
        }}
      >
        {sample || family.name}
      </div>

      {open && (
        <div className="card__details">
          <div className="weights">
            {family.weights.map((w) => {
              const on = sel.weights === 'all' || sel.weights.includes(w)
              return (
                <label key={w} className={`weight${on && inCart ? ' weight--on' : ''}`}>
                  <input type="checkbox" checked={inCart && on} onChange={() => toggleWeight(w)} />
                  <span style={{ fontWeight: w, fontFamily: visible ? previewFontFamily(family) : undefined }}>
                    {weightLabel(w)} <small>{w}</small>
                  </span>
                </label>
              )
            })}
            {family.italic && (
              <label className={`weight${inCart && sel.italics ? ' weight--on' : ''}`}>
                <input
                  type="checkbox"
                  checked={inCart && sel.italics}
                  onChange={() => {
                    const next = { ...sel, italics: !sel.italics }
                    if (inCart) onSelection(family.id, next)
                    else onAdd(family, next)
                  }}
                />
                <span style={{ fontStyle: 'italic' }}>Italics</span>
              </label>
            )}
          </div>
          <dl className="facts">
            <dt>Files</dt>
            <dd>
              {family.files.length ? family.files.map((f) => f.filename).join(', ') : '—'}
              {family.bytes > 0 && <span className="muted"> · about {formatBytes(family.bytes)} for the whole family</span>}
            </dd>
            {family.designers.length > 0 && (
              <>
                <dt>Designers</dt>
                <dd>{family.designers.join(', ')}</dd>
              </>
            )}
            <dt>Subsets</dt>
            <dd>{family.subsets.join(', ') || '—'}</dd>
            {family.added && (
              <>
                <dt>Added</dt>
                <dd>{family.added}</dd>
              </>
            )}
            <dt>Licence</dt>
            <dd>
              {family.license}
              {family.licenseUrl && (
                <>
                  {' · '}
                  <a href={family.licenseUrl} target="_blank" rel="noreferrer">
                    text
                  </a>
                </>
              )}
            </dd>
          </dl>
        </div>
      )}
    </div>
  )
}
