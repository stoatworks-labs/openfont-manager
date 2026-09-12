import googleJson from '../data/google-fonts.json'
import fontsourceJson from '../data/fontsource-fonts.json'
import { normalizeKey, parseFontName } from './names'
import type { Category, Family, FamilyFile, Source } from './types'

/**
 * The unified catalogue: Google Fonts plus the Fontsource families Google
 * does not carry, in one shape, with search and filtering.
 *
 * Both catalogues are build-time snapshots (see scripts/). Downloads happen
 * at runtime from CORS-enabled hosts:
 *
 *   Google      raw.githubusercontent.com/google/fonts — the original, complete,
 *               unsubsetted .ttf files, exactly what is installable. Mirrored by
 *               cdn.jsdelivr.net/gh, which is tried when GitHub rate-limits.
 *   Fontsource  cdn.jsdelivr.net/fontsource — single-subset families only, for
 *               which the one file is the entire font. See the build script for
 *               why a multi-subset Fontsource TTF must never be shipped.
 *
 * NOT the Google CSS API for downloads: it serves subsetted woff2 to a browser
 * UA and a subsetted font installs cleanly and then renders blanks. The CSS
 * API is used for previews only, in `src/platform/preview.ts`.
 */

interface RawGoogle {
  n: string
  c: string
  w: number[]
  i: number
  l: string
  p: string
  f: string[]
  b: number
  s: string[]
  a: string[]
  d: string[]
  r: number
  t: string
}

interface RawFontsource {
  n: string
  s: string
  u: string
  c: string
  w: number[]
  i: number
  l: string
  v: number
  e: string
  t: string
}

const RAW_BASE = 'https://raw.githubusercontent.com/google/fonts/main'
const GH_MIRROR = 'https://cdn.jsdelivr.net/gh/google/fonts@main'
const FONTSOURCE_CDN = 'https://cdn.jsdelivr.net/fontsource/fonts'

/** Licence text filename by repo directory. 38 of 44 apache/ families carry one. */
const LICENSE_FILE: Record<string, string> = { ofl: 'OFL.txt', apache: 'LICENSE.txt', ufl: 'UFL.txt' }

export const CATALOGUE_DATES = {
  google: (googleJson as { generated: string }).generated,
  fontsource: (fontsourceJson as { generated: string }).generated,
}

/** Style token as it appears in a static filename, e.g. `Poppins-SemiBold.ttf`. */
const STYLE_WEIGHTS: Array<[string, number]> = [
  ['Thin', 100],
  ['Hairline', 100],
  ['ExtraLight', 200],
  ['UltraLight', 200],
  ['Light', 300],
  ['Regular', 400],
  ['Book', 400],
  ['Medium', 500],
  ['SemiBold', 600],
  ['DemiBold', 600],
  ['ExtraBold', 800],
  ['UltraBold', 800],
  ['Bold', 700],
  ['Black', 900],
  ['Heavy', 900],
]

/** Weight and style of a google/fonts static filename. */
export function describeGoogleFile(file: string): { weight: number; italic: boolean; variable: boolean } {
  const base = file.replace(/\.ttf$/i, '')
  const variable = /\[[^\]]+\]$/.test(base)
  const stem = base.replace(/\[[^\]]+\]$/, '')
  const suffix = stem.includes('-') ? stem.slice(stem.indexOf('-') + 1) : ''
  const italic = /italic/i.test(suffix)
  const withoutItalic = suffix.replace(/italic/i, '')
  let weight = 400
  for (const [token, w] of STYLE_WEIGHTS) {
    if (withoutItalic.toLowerCase() === token.toLowerCase()) {
      weight = w
      break
    }
  }
  return { weight, italic, variable }
}

function category(raw: string): Category {
  const k = raw.toLowerCase().replace(/[^a-z]/g, '')
  if (k === 'sansserif') return 'Sans Serif'
  if (k === 'serif') return 'Serif'
  if (k === 'display') return 'Display'
  if (k === 'handwriting') return 'Handwriting'
  if (k === 'monospace') return 'Monospace'
  return 'Other'
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

function fromGoogle(f: RawGoogle): Family {
  const files: FamilyFile[] = f.f.map((file) => {
    const d = describeGoogleFile(file)
    const enc = encodeURIComponent(file)
    return {
      filename: file,
      url: `${RAW_BASE}/${f.p}/${enc}`,
      mirrors: [`${GH_MIRROR}/${f.p}/${enc}`],
      ...d,
    }
  })
  return {
    id: `google:${slug(f.n)}`,
    name: f.n,
    source: 'google',
    category: category(f.c),
    weights: f.w,
    italic: f.i === 1,
    license: f.l || 'Unknown',
    licenseUrl: f.p ? `${RAW_BASE}/${f.p}/${LICENSE_FILE[f.p.split('/')[0]!] ?? 'OFL.txt'}` : null,
    subsets: f.s,
    axes: f.a,
    designers: f.d,
    rank: f.r,
    added: f.t,
    bytes: f.b,
    files,
    key: normalizeKey(f.n),
  }
}

/**
 * Fontsource filenames on the CDN are `{subset}-{weight}-{style}.ttf`, which
 * says nothing about which font it is. They are renamed to the usual
 * `Family-Weight.ttf` convention, so a folder of them is usable.
 */
const WEIGHT_NAMES: Record<number, string> = {
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

export function fontsourceFilename(family: string, weight: number, italic: boolean): string {
  const stem = family.replace(/[^A-Za-z0-9]+/g, '')
  const w = WEIGHT_NAMES[weight] ?? String(weight)
  const style = italic ? (weight === 400 ? 'Italic' : `${w}Italic`) : w
  return `${stem}-${style}.ttf`
}

function fromFontsource(f: RawFontsource): Family {
  const files: FamilyFile[] = []
  const styles = f.i ? [false, true] : [false]
  const version = f.e && f.e !== 'latest' ? f.e : 'latest'
  // Fontsource has no size in its list endpoint; ~120 KB a face is typical.
  for (const w of f.w.length ? f.w : [400]) {
    for (const italic of styles) {
      files.push({
        filename: fontsourceFilename(f.n, w, italic),
        url: `${FONTSOURCE_CDN}/${f.s}@${version}/${f.u}-${w}-${italic ? 'italic' : 'normal'}.ttf`,
        mirrors: [],
        weight: w,
        italic,
        variable: false,
      })
    }
  }
  return {
    id: `fontsource:${f.s}`,
    name: f.n,
    source: 'fontsource',
    category: category(f.c),
    weights: f.w,
    italic: f.i === 1,
    license: f.l,
    // Every Fontsource package ships its LICENSE file on npm.
    licenseUrl: `https://cdn.jsdelivr.net/npm/@fontsource/${f.s}@${version}/LICENSE`,
    subsets: [f.u],
    axes: [],
    designers: [],
    // Google ranks its own; anything from Fontsource sorts after all of them,
    // alphabetically, rather than pretending to a popularity it was never given.
    rank: 100000,
    added: f.t,
    bytes: files.length * 120_000,
    files,
    key: normalizeKey(f.n),
  }
}

const GOOGLE = (googleJson as { families: RawGoogle[] }).families.map(fromGoogle)
const FONTSOURCE = (fontsourceJson as { families: RawFontsource[] }).families.map(fromFontsource)

/** Every family, Google first then Fontsource, each block alphabetical. */
export const FAMILIES: readonly Family[] = [...GOOGLE, ...FONTSOURCE]

export const COUNTS = {
  google: GOOGLE.length,
  googleDownloadable: GOOGLE.filter((f) => f.files.length > 0).length,
  fontsource: FONTSOURCE.length,
  total: FAMILIES.length,
  files: FAMILIES.reduce((n, f) => n + f.files.length, 0),
  bytes: FAMILIES.reduce((n, f) => n + f.bytes, 0),
}

const BY_ID = new Map<string, Family>()
const BY_KEY = new Map<string, Family>()
for (const f of FAMILIES) {
  BY_ID.set(f.id, f)
  // Google wins a name collision, by construction of the Fontsource catalogue
  // (it excludes anything Google has) — but be explicit, not lucky.
  if (!BY_KEY.has(f.key)) BY_KEY.set(f.key, f)
}

export function familyById(id: string): Family | undefined {
  return BY_ID.get(id)
}

/**
 * Exact family lookup by name, tolerant of case, punctuation and a trailing
 * style word: `poppins`, `Poppins-Bold` and `Poppins SemiBold Italic` all
 * find Poppins. A name that is *only* a style word (`Black`) is kept whole.
 */
export function findFamily(name: string, source: Source | 'auto' = 'auto'): Family | undefined {
  const candidates = [normalizeKey(name), normalizeKey(parseFontName(name).family)]
  for (const key of candidates) {
    const hit = BY_KEY.get(key)
    if (!hit) continue
    if (source === 'auto' || hit.source === source) return hit
  }
  if (source !== 'auto') {
    // A specific source was asked for and the key-map's winner is the other
    // one. Scan that source only.
    const pool = source === 'google' ? GOOGLE : FONTSOURCE
    for (const key of candidates) {
      const hit = pool.find((f) => f.key === key)
      if (hit) return hit
    }
  }
  return undefined
}

/**
 * Near matches for a name that found nothing, for the list importer.
 *
 * Token overlap rather than edit distance: the useful suggestions are
 * "Garamond" -> "EB Garamond" / "Cormorant Garamond", which share a whole
 * word but are far apart by character edits.
 */
export function suggestFamilies(name: string, limit = 3): Family[] {
  const wanted = normalizeKey(parseFontName(name).family)
  const wantedTokens = new Set(wanted.split(' ').filter((t) => t.length > 2))
  if (wantedTokens.size === 0) return []

  const scored: Array<{ f: Family; score: number }> = []
  for (const f of FAMILIES) {
    if (f.key === wanted) continue
    const tokens = f.key.split(' ')
    let hits = 0
    for (const t of tokens) if (wantedTokens.has(t)) hits++
    if (hits === 0) continue
    const score = hits / wantedTokens.size - (tokens.length - hits) * 0.08
    scored.push({ f, score })
  }
  scored.sort((a, b) => b.score - a.score || a.f.name.length - b.f.name.length)
  return scored.slice(0, limit).map(({ f }) => f)
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

export type SortKey = 'popular' | 'name' | 'newest'

export interface Query {
  /** Free text; every whitespace-separated token must appear in the name. */
  text: string
  categories: Category[]
  sources: Source[]
  /** SPDX ids; empty = any. */
  licenses: string[]
  /** `latin`, `cyrillic`, ...; empty = any. Every listed subset must be covered. */
  subsets: string[]
  variableOnly: boolean
  /** Only families that have an italic. */
  italicOnly: boolean
  /** Only families with a file to download (a few Google entries have none). */
  downloadableOnly: boolean
  sort: SortKey
}

export const EMPTY_QUERY: Query = {
  text: '',
  categories: [],
  sources: [],
  licenses: [],
  subsets: [],
  variableOnly: false,
  italicOnly: false,
  downloadableOnly: true,
  sort: 'popular',
}

export function searchFamilies(q: Query, pool: readonly Family[] = FAMILIES): Family[] {
  const tokens = normalizeKey(q.text).split(' ').filter(Boolean)
  const out: Family[] = []
  for (const f of pool) {
    if (q.downloadableOnly && f.files.length === 0) continue
    if (q.categories.length && !q.categories.includes(f.category)) continue
    if (q.sources.length && !q.sources.includes(f.source)) continue
    if (q.licenses.length && !q.licenses.includes(f.license)) continue
    if (q.variableOnly && f.axes.length === 0) continue
    if (q.italicOnly && !f.italic) continue
    if (q.subsets.length && !q.subsets.every((s) => f.subsets.includes(s))) continue
    if (tokens.length) {
      const hay = `${f.key} ${f.designers.join(' ').toLowerCase()}`
      if (!tokens.every((t) => hay.includes(t))) continue
    }
    out.push(f)
  }
  sortFamilies(out, q.sort, tokens)
  return out
}

function sortFamilies(list: Family[], sort: SortKey, tokens: string[]): void {
  if (sort === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name))
    return
  }
  if (sort === 'newest') {
    list.sort((a, b) => b.added.localeCompare(a.added) || a.name.localeCompare(b.name))
    return
  }
  // Popular — but a name that *starts* with the search text outranks one that
  // merely contains it, so typing "Roboto" puts Roboto above Roboto Slab and
  // both above anything whose designer happens to mention it.
  const prefix = tokens.join(' ')
  const starts = (f: Family) => (prefix && f.key.startsWith(prefix) ? 0 : 1)
  list.sort((a, b) => starts(a) - starts(b) || a.rank - b.rank || a.name.localeCompare(b.name))
}

/** Every distinct licence in the catalogue, most common first. */
export function licenseOptions(): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>()
  for (const f of FAMILIES) counts.set(f.license, (counts.get(f.license) ?? 0) + 1)
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count)
}

/** Every distinct subset, most common first. */
export function subsetOptions(): Array<{ id: string; count: number }> {
  const counts = new Map<string, number>()
  for (const f of FAMILIES) for (const s of f.subsets) counts.set(s, (counts.get(s) ?? 0) + 1)
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count)
}
