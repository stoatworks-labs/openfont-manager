import { useEffect, useMemo, useRef, useState } from 'react'
import {
  COUNTS,
  EMPTY_QUERY,
  licenseOptions,
  searchFamilies,
  subsetOptions,
  type Query,
  type SortKey,
} from '../core/catalogue'
import { estimateBytes, formatBytes } from '../core/plan'
import { ALL, type Category, type Family, type Source } from '../core/types'
import { FontCard } from './FontCard'
import type { Cart } from './useCart'

const CATEGORIES: Category[] = ['Sans Serif', 'Serif', 'Display', 'Handwriting', 'Monospace']
const PAGE = 48

interface Props {
  cart: Cart
  installed: Set<string>
}

export function Catalogue({ cart, installed }: Props) {
  const [query, setQuery] = useState<Query>(EMPTY_QUERY)
  const [sample, setSample] = useState('The quick brown fox jumps over the lazy dog 0123456789')
  const [size, setSize] = useState(28)
  const [shown, setShown] = useState(PAGE)
  const [moreFilters, setMoreFilters] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)

  const results = useMemo(() => searchFamilies(query), [query])
  const licenses = useMemo(() => licenseOptions(), [])
  const subsets = useMemo(() => subsetOptions().slice(0, 14), [])

  // Reset the window whenever the result set changes.
  useEffect(() => setShown(PAGE), [results])

  // Grow the window as the sentinel scrolls into view.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setShown((n) => Math.min(results.length, n + PAGE))
    })
    io.observe(el)
    return () => io.disconnect()
  }, [results.length])

  const set = <K extends keyof Query>(k: K, v: Query[K]) => setQuery((q) => ({ ...q, [k]: v }))
  const toggleIn = <T,>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const addAll = () => {
    const downloadable = results.filter((f) => f.files.length > 0)
    const bytes = estimateBytes(downloadable.map((family) => ({ family, selection: ALL })))
    const ok = window.confirm(
      `Add all ${downloadable.length.toLocaleString()} families in this result set to the cart?\n\n` +
        `That is about ${formatBytes(bytes)} of font files.`,
    )
    if (ok) cart.addMany(downloadable.map((family) => ({ family })))
  }

  const isFiltered =
    query.text || query.categories.length || query.sources.length || query.licenses.length || query.subsets.length ||
    query.variableOnly || query.italicOnly

  return (
    <section className="catalogue">
      <div className="toolbar">
        <div className="toolbar__row">
          <input
            type="search"
            className="search"
            placeholder="Search families or designers…"
            value={query.text}
            onChange={(e) => set('text', e.target.value)}
            aria-label="Search fonts"
            autoFocus
          />
          <select value={query.sort} onChange={(e) => set('sort', e.target.value as SortKey)} aria-label="Sort">
            <option value="popular">Most popular</option>
            <option value="name">Name A–Z</option>
            <option value="newest">Newest</option>
          </select>
        </div>

        <div className="toolbar__row toolbar__row--chips">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`chipbtn${query.categories.includes(c) ? ' chipbtn--on' : ''}`}
              onClick={() => set('categories', toggleIn(query.categories, c))}
            >
              {c}
            </button>
          ))}
          <span className="toolbar__sep" />
          {(['google', 'fontsource'] as Source[]).map((s) => (
            <button
              key={s}
              type="button"
              className={`chipbtn${query.sources.includes(s) ? ' chipbtn--on' : ''}`}
              onClick={() => set('sources', toggleIn(query.sources, s))}
            >
              {s === 'google' ? `Google Fonts (${COUNTS.googleDownloadable.toLocaleString()})` : `Fontsource (${COUNTS.fontsource})`}
            </button>
          ))}
          <button
            type="button"
            className={`chipbtn${query.variableOnly ? ' chipbtn--on' : ''}`}
            onClick={() => set('variableOnly', !query.variableOnly)}
          >
            Variable
          </button>
          <button type="button" className="chipbtn chipbtn--ghost" onClick={() => setMoreFilters((m) => !m)}>
            {moreFilters ? 'Fewer filters' : 'More filters…'}
          </button>
          {isFiltered ? (
            <button type="button" className="chipbtn chipbtn--ghost" onClick={() => setQuery(EMPTY_QUERY)}>
              Clear
            </button>
          ) : null}
        </div>

        {moreFilters && (
          <div className="toolbar__row toolbar__row--chips">
            <span className="muted">Licence:</span>
            {licenses.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`chipbtn${query.licenses.includes(l.id) ? ' chipbtn--on' : ''}`}
                onClick={() => set('licenses', toggleIn(query.licenses, l.id))}
              >
                {l.id} <small>{l.count}</small>
              </button>
            ))}
            <span className="toolbar__sep" />
            <span className="muted">Subset:</span>
            {subsets.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`chipbtn${query.subsets.includes(s.id) ? ' chipbtn--on' : ''}`}
                onClick={() => set('subsets', toggleIn(query.subsets, s.id))}
              >
                {s.id}
              </button>
            ))}
            <span className="toolbar__sep" />
            <button
              type="button"
              className={`chipbtn${query.italicOnly ? ' chipbtn--on' : ''}`}
              onClick={() => set('italicOnly', !query.italicOnly)}
            >
              Has italics
            </button>
          </div>
        )}

        <div className="toolbar__row toolbar__row--preview">
          <input
            type="text"
            className="sample"
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            placeholder="Type to preview…"
            aria-label="Preview text"
          />
          <label className="sizectl">
            <input type="range" min={14} max={72} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Preview size" />
            <span>{size}px</span>
          </label>
        </div>

        <div className="toolbar__row toolbar__row--status">
          <span className="muted">
            {results.length.toLocaleString()} famil{results.length === 1 ? 'y' : 'ies'}
            {isFiltered ? ' match' : ''}
          </span>
          <button type="button" className="btn btn--sm btn--ghost" onClick={addAll} disabled={results.length === 0}>
            Add all {results.length.toLocaleString()} to cart
          </button>
        </div>
      </div>

      <div className="cards">
        {results.slice(0, shown).map((f: Family) => {
          const item = cart.cart.get(f.id)
          return (
            <FontCard
              key={f.id}
              family={f}
              sample={sample}
              size={size}
              inCart={!!item}
              selection={item?.selection}
              installed={installed.has(f.key)}
              onAdd={cart.add}
              onRemove={cart.remove}
              onSelection={cart.setSelection}
            />
          )
        })}
        {results.length === 0 && (
          <p className="empty">
            Nothing matches. Names are matched loosely (case and punctuation ignored), so try fewer words.
          </p>
        )}
        <div ref={sentinel} className="sentinel">
          {shown < results.length && (
            <button type="button" className="btn btn--ghost" onClick={() => setShown((n) => n + PAGE)}>
              Show more ({(results.length - shown).toLocaleString()} left)
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
