import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate'
import { LINUX_INSTALLER, MACOS_INSTALLER, WINDOWS_CMD, WINDOWS_PS1, readmeText } from './installers'
import type { PlanItem } from './types'

/**
 * The bundle .zip, written as a stream.
 *
 * A "download everything" pull is ~2.3 GB across ~3,700 files, which no
 * browser tab can hold in memory as one Uint8Array. So the archive is
 * produced incrementally — each file is appended as soon as it arrives and
 * the bytes go straight to whatever sink the platform offers (a
 * `showSaveFilePicker` stream on Chromium, a blob-part list elsewhere).
 *
 * Layout:
 *   fonts/<Family>/<file>.ttf     one folder per family
 *   fonts/<Family>/OFL.txt        that family's licence text, when published
 *   install-fonts.command         macOS
 *   install-fonts.cmd             Windows  (run this)
 *   install-fonts.ps1             Windows  (called by the .cmd)
 *   install-fonts.sh              Linux
 *   README.txt
 *   MANIFEST.txt                  per-file provenance and licence
 */

const UNIX_MODE = 0o755 << 16
const FILE_MODE = 0o644 << 16

export type Sink = (chunk: Uint8Array, final: boolean) => void

export interface ManifestEntry extends PlanItem {
  bytes: number
  /** Where it was actually fetched from (mirror or primary). */
  fetchedFrom: string
}

/** A filesystem-safe folder name for a family. */
export function familyFolder(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() || 'Font'
}

export class BundleWriter {
  private zip: Zip
  private entries: ManifestEntry[] = []
  private licences = new Set<string>()
  private failures: Array<{ item: PlanItem; error: string }> = []
  private ended = false
  private readonly names = new Set<string>()

  constructor(
    sink: Sink,
    private readonly opts: { title: string; compress: boolean; generated?: string },
  ) {
    this.zip = new Zip((err, chunk, final) => {
      if (err) throw err
      sink(chunk, final)
    })
  }

  private uniquePath(path: string): string {
    // Two families cannot collide inside their own folders, but be safe:
    // a case-insensitive filesystem would merge `Foo.ttf` and `foo.ttf`.
    let candidate = path
    let i = 2
    while (this.names.has(candidate.toLowerCase())) {
      const dot = path.lastIndexOf('.')
      candidate = dot === -1 ? `${path}-${i}` : `${path.slice(0, dot)}-${i}${path.slice(dot)}`
      i++
    }
    this.names.add(candidate.toLowerCase())
    return candidate
  }

  private put(path: string, data: Uint8Array, mode: number, compress: boolean): void {
    const file = compress ? new ZipDeflate(path, { level: 3 }) : new ZipPassThrough(path)
    file.attrs = mode
    file.os = 3 // unix — so the mode bits mean something
    this.zip.add(file)
    file.push(data, true)
  }

  /** Append one fetched font file. */
  addFont(item: PlanItem, data: Uint8Array, fetchedFrom: string): void {
    const path = this.uniquePath(`fonts/${familyFolder(item.family)}/${item.filename}`)
    this.put(path, data, FILE_MODE, this.opts.compress)
    this.entries.push({ ...item, bytes: data.length, fetchedFrom })
  }

  /** Append a family's licence text (best effort; missing ones are just absent). */
  addLicence(family: string, filename: string, text: Uint8Array): void {
    const key = `${family}/${filename}`
    if (this.licences.has(key)) return
    this.licences.add(key)
    const path = this.uniquePath(`fonts/${familyFolder(family)}/${filename}`)
    this.put(path, text, FILE_MODE, true)
  }

  noteFailure(item: PlanItem, error: string): void {
    this.failures.push({ item, error })
  }

  get count(): number {
    return this.entries.length
  }

  /** Write the scripts, README and manifest, then close the archive. */
  end(): { entries: ManifestEntry[]; failures: Array<{ item: PlanItem; error: string }> } {
    if (this.ended) throw new Error('Bundle already ended.')
    this.ended = true
    const generated = this.opts.generated ?? new Date().toISOString().slice(0, 10)
    const families = new Set(this.entries.map((e) => e.familyId)).size

    this.put('install-fonts.command', strToU8(MACOS_INSTALLER), UNIX_MODE, true)
    this.put('install-fonts.sh', strToU8(LINUX_INSTALLER), UNIX_MODE, true)
    this.put('install-fonts.cmd', strToU8(WINDOWS_CMD.replace(/\n/g, '\r\n')), FILE_MODE, true)
    this.put('install-fonts.ps1', strToU8(WINDOWS_PS1.replace(/\n/g, '\r\n')), FILE_MODE, true)
    this.put('README.txt', strToU8(readmeText(this.opts.title, generated, families, this.entries.length)), FILE_MODE, true)
    this.put('MANIFEST.txt', strToU8(manifestText(this.opts.title, generated, this.entries, this.failures)), FILE_MODE, true)
    this.zip.end()
    return { entries: this.entries, failures: this.failures }
  }
}

export function manifestText(
  title: string,
  generated: string,
  entries: ManifestEntry[],
  failures: Array<{ item: PlanItem; error: string }>,
): string {
  const lines: string[] = []
  lines.push(`MANIFEST — ${title}`)
  lines.push(`Generated ${generated} by OpenFont Manager`)
  lines.push('')

  const byFamily = new Map<string, ManifestEntry[]>()
  for (const e of entries) {
    const list = byFamily.get(e.familyId) ?? []
    list.push(e)
    byFamily.set(e.familyId, list)
  }
  const families = [...byFamily.values()].sort((a, b) => a[0]!.family.localeCompare(b[0]!.family))

  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0)
  lines.push(`${families.length} families, ${entries.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB`)
  lines.push('')

  const sourceName = (s: PlanItem['source']) =>
    s === 'google' ? 'Google Fonts (github.com/google/fonts)' : 'Fontsource (fontsource.org)'

  for (const files of families) {
    const first = files[0]!
    lines.push(`${first.family}`)
    lines.push(`  source:   ${sourceName(first.source)}`)
    lines.push(`  licence:  ${first.license}`)
    for (const f of files.sort((a, b) => a.filename.localeCompare(b.filename))) {
      const style = `${f.weight}${f.italic ? ' italic' : ''}${f.variable ? ' (variable)' : ''}`
      lines.push(`  ${f.filename.padEnd(44)} ${style.padEnd(20)} ${f.bytes.toLocaleString('en-US').padStart(12)} bytes`)
      lines.push(`    from ${f.fetchedFrom}`)
    }
    lines.push('')
  }

  if (failures.length > 0) {
    lines.push('NOT INCLUDED — these files could not be fetched:')
    for (const f of failures) lines.push(`  ${f.item.family} / ${f.item.filename}: ${f.error}`)
    lines.push('')
  }

  lines.push('LICENCES')
  lines.push('  OFL-1.1     SIL Open Font License 1.1 — free to use, share and embed; keep the licence text with the font.')
  lines.push('  Apache-2.0  Apache License 2.0 — free to use and share; keep the NOTICE/LICENSE text.')
  lines.push('  UFL-1.0     Ubuntu Font Licence 1.0 — free to use and share; keep the licence text.')
  lines.push('  MIT / CC0 / Unlicense — free to use and share.')
  lines.push('')
  return lines.join('\n')
}
