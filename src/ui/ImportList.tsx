import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { parseList, resolveList, type ResolvedList } from '../core/lists'
import { estimateBytes, formatBytes } from '../core/plan'
import type { CartItem, Family, ListParseResult } from '../core/types'
import { isDesktop } from '../platform/native'
import type { Cart } from './useCart'
import type { Jobs } from './useJobs'

const EXAMPLE_CSV = `family,weights,italic,source
Poppins,400;700,yes,google
Inter,all,,
"Playfair Display",700,no,
Adwaita Sans,,,fontsource`

const EXAMPLE_XML = `<fonts>
  <font family="Poppins" weights="400 700" italic="true"/>
  <font>Inter</font>
  <font name="Playfair Display"><weight>700</weight></font>
</fonts>`

interface Props {
  cart: Cart
  jobs: Jobs
  /** A list handed to the app from outside (desktop CLI argument / file open). */
  external?: { name: string; text: string } | null
}

export function ImportList({ cart, jobs, external }: Props) {
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [parsed, setParsed] = useState<ListParseResult | null>(null)
  const [resolved, setResolved] = useState<ResolvedList | null>(null)
  const [over, setOver] = useState(false)
  const [picked, setPicked] = useState<Map<number, Family>>(new Map())

  const load = useCallback((content: string, filename: string) => {
    setText(content)
    setName(filename)
    const p = parseList(content, filename)
    setParsed(p)
    setResolved(resolveList(p.entries))
    setPicked(new Map())
  }, [])

  useEffect(() => {
    if (external) load(external.text, external.name)
  }, [external, load])

  const onFile = async (file: File) => load(await file.text(), file.name)

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setOver(false)
    const file = e.dataTransfer.files[0]
    if (file) await onFile(file)
  }

  const items: CartItem[] = resolved
    ? [
        ...resolved.items.map((i) => ({ family: i.family, selection: i.selection })),
        ...[...picked.entries()].map(([, family]) => ({ family, selection: { weights: 'all' as const, italics: true } })),
      ]
    : []

  const addAll = () => cart.addMany(items.map((i) => ({ family: i.family, selection: i.selection })))
  const desktop = isDesktop()

  return (
    <section className="import">
      <div className="import__grid">
        <div>
          <div
            className={`drop${over ? ' over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setOver(true)
            }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            onClick={() => document.getElementById('list-file')?.click()}
          >
            <input
              id="list-file"
              type="file"
              accept=".csv,.tsv,.xml,.txt,.list,text/csv,text/xml,application/xml,text/plain"
              onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])}
            />
            <strong>Drop a font list here</strong>
            <span>CSV, XML or plain text — or click to choose a file</span>
          </div>
          <label className="import__paste">
            <span className="muted">…or paste one</span>
            <textarea
              value={text}
              onChange={(e) => load(e.target.value, name)}
              rows={8}
              spellCheck={false}
              placeholder={EXAMPLE_CSV}
            />
          </label>
          <div className="import__examples">
            <button type="button" className="btn btn--ghost btn--xs" onClick={() => load(EXAMPLE_CSV, 'example.csv')}>
              Load CSV example
            </button>
            <button type="button" className="btn btn--ghost btn--xs" onClick={() => load(EXAMPLE_XML, 'example.xml')}>
              Load XML example
            </button>
          </div>
        </div>

        <div className="import__formats">
          <h3>Formats</h3>
          <p>
            <strong>CSV</strong> — columns <code>family</code>, <code>weights</code>, <code>italic</code>,{' '}
            <code>source</code>; only the first is required and the header row is optional. Weights are numbers or style
            words separated by <code>;</code> or spaces; <code>all</code> (or blank) takes the whole family.
          </p>
          <p>
            <strong>XML</strong> — any root element; one <code>&lt;font&gt;</code> per family with the same four
            fields as attributes, or child elements, or the name as text.
          </p>
          <p>
            <strong>TXT</strong> — one family name per line.
          </p>
          <p className="muted">
            Names are matched loosely: case and punctuation are ignored and a trailing style word is tolerated, so{' '}
            <code>Poppins-Bold</code> resolves to Poppins. Fonts that are not open source (Calibri, Arial, Helvetica,
            Segoe UI…) are not in any catalogue here and will show as unresolved.
          </p>
        </div>
      </div>

      {parsed && resolved && (
        <div className="import__result">
          <div className="import__summary">
            <strong>
              {name || 'Pasted list'} · {parsed.format.toUpperCase()} · {parsed.entries.length} entr
              {parsed.entries.length === 1 ? 'y' : 'ies'}
            </strong>
            <span className="muted">
              {resolved.items.length + picked.size} resolved · {resolved.unresolved.length - picked.size} unresolved
              {parsed.errors.length ? ` · ${parsed.errors.length} line${parsed.errors.length === 1 ? '' : 's'} skipped` : ''}
              {items.length ? ` · ~${formatBytes(estimateBytes(items))}` : ''}
            </span>
            <div className="import__actions">
              <button type="button" className="btn btn--primary" disabled={items.length === 0} onClick={addAll}>
                Add {items.length} to checkout
              </button>
              <button
                type="button"
                className="btn"
                disabled={items.length === 0 || jobs.busy}
                onClick={() => {
                  addAll()
                  if (desktop) jobs.install(items)
                  else jobs.zip(items, { compress: true, licences: true })
                }}
              >
                {desktop ? 'Add and install now' : 'Add and download zip now'}
              </button>
            </div>
          </div>

          {parsed.errors.length > 0 && (
            <ul className="import__errors">
              {parsed.errors.map((e, i) => (
                <li key={i}>
                  line {e.line}: {e.message}
                </li>
              ))}
            </ul>
          )}

          {resolved.unresolved.length > 0 && (
            <div className="import__unresolved">
              <h3>Not found</h3>
              <ul>
                {resolved.unresolved.map(({ entry, substitutes, suggestions }) => {
                  const chosen = picked.get(entry.line)
                  return (
                    <li key={`${entry.line}-${entry.family}`}>
                      <span className="import__name">{entry.family}</span>
                      {chosen ? (
                        <span className="chip chip--ok">
                          using {chosen.name}{' '}
                          <button
                            type="button"
                            className="linkbtn"
                            onClick={() =>
                              setPicked((m) => {
                                const n = new Map(m)
                                n.delete(entry.line)
                                return n
                              })
                            }
                          >
                            undo
                          </button>
                        </span>
                      ) : substitutes.length || suggestions.length ? (
                        <span className="import__suggest">
                          {substitutes.map((s) => (
                            <button
                              key={s.family.id}
                              type="button"
                              className={`chipbtn${s.metric ? ' chipbtn--metric' : ''}`}
                              title={s.note}
                              onClick={() => setPicked((m) => new Map(m).set(entry.line, s.family))}
                            >
                              use {s.family.name}
                              {s.metric ? ' (same widths)' : ' (similar)'}
                            </button>
                          ))}
                          {suggestions.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              className="chipbtn"
                              onClick={() => setPicked((m) => new Map(m).set(entry.line, s))}
                            >
                              use {s.name}
                            </button>
                          ))}
                        </span>
                      ) : (
                        <span className="muted">not open source, and nothing similar in the catalogue</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}

          {resolved.items.length > 0 && (
            <div className="import__resolved">
              <h3>Resolved</h3>
              <ul>
                {resolved.items.map(({ entry, family, selection }) => (
                  <li key={family.id}>
                    <span className="import__name">{family.name}</span>
                    <span className="muted">
                      {entry.family !== family.name ? `from “${entry.family}” · ` : ''}
                      {selection.weights === 'all' ? 'whole family' : `weights ${selection.weights.join(', ')}${selection.italics ? ' + italics' : ''}`}
                      {' · '}
                      {family.source === 'google' ? 'Google Fonts' : 'Fontsource'} · {family.license}
                      {cart.cart.has(family.id) ? ' · in checkout' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
