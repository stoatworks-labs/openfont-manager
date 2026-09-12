import { findFamily, suggestFamilies } from './catalogue'
import { substitutesFor, type SubstituteHit } from './substitutes'
import type { CartItem, Family, ListEntry, ListParseResult, Selection, Source } from './types'

/**
 * Font lists — the file you hand the app (or drop in the watched folder) to
 * have a set of families fetched without clicking through the catalogue.
 *
 * Three formats, detected by extension or by sniffing the content:
 *
 * ## CSV
 *
 *     family,weights,italic,source
 *     Poppins,400;700,yes,google
 *     Inter,all,,
 *     "Playfair Display",700,no,
 *
 * The header row is optional; without one the columns are taken in that
 * order. A one-column file is just family names. Comma, semicolon and tab
 * delimiters are all accepted (whichever the header line uses most). Weights
 * are separated by `;`, `|`, `+` or spaces — never a comma, which is the CSV
 * delimiter — and may be style words (`bold`, `light`) as well as numbers.
 * `#` starts a comment line.
 *
 * ## XML
 *
 *     <fonts>
 *       <font family="Poppins" weights="400 700" italic="true" source="google"/>
 *       <font>Inter</font>
 *       <font name="Playfair Display"><weight>700</weight><weight>900</weight></font>
 *     </fonts>
 *
 * The root element's name does not matter. Every `<font>` (or `<family>`)
 * element is one entry; the family comes from `family`, `name` or the text.
 *
 * ## TXT
 *
 * One family name per line. `#` starts a comment line.
 *
 * In every format the family name is matched the way the catalogue search
 * is: case- and punctuation-insensitive, and a trailing style word is
 * tolerated, so `Poppins-Bold` still finds Poppins.
 *
 * The same shapes are written back out by `toCSV` / `toXML`, so a cart built
 * in the browser can be exported and dropped in a watched folder elsewhere.
 */

const WEIGHT_WORDS: Record<string, number> = {
  thin: 100,
  hairline: 100,
  extralight: 200,
  ultralight: 200,
  light: 300,
  regular: 400,
  normal: 400,
  book: 400,
  medium: 500,
  semibold: 600,
  demibold: 600,
  bold: 700,
  extrabold: 800,
  ultrabold: 800,
  black: 900,
  heavy: 900,
}

/** `400;700`, `400 700`, `bold+light`, `all`, '' -> weights. */
export function parseWeights(raw: string | undefined): 'all' | number[] {
  const s = (raw ?? '')
    .trim()
    .toLowerCase()
    // `semi bold`, `extra-light` -> one token
    .replace(/\b(semi|demi|extra|ultra)[\s-]+(bold|light)\b/g, '$1$2')
  if (!s || s === 'all' || s === '*') return 'all'
  const out: number[] = []
  for (const tok of s.split(/[;|+\s/]+/).filter(Boolean)) {
    const n = Number(tok)
    if (Number.isFinite(n) && n >= 1 && n <= 1000) {
      out.push(Math.round(n))
      continue
    }
    const w = WEIGHT_WORDS[tok.replace(/[^a-z]/g, '')]
    if (w) out.push(w)
  }
  const uniq = [...new Set(out)].sort((a, b) => a - b)
  return uniq.length ? uniq : 'all'
}

/** yes/no/true/false/1/0/y/n; `undefined` when absent or unreadable. */
export function parseBool(raw: string | undefined): boolean | undefined {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return undefined
  if (['1', 'y', 'yes', 'true', 'on', 'italic', 'italics'].includes(s)) return true
  if (['0', 'n', 'no', 'false', 'off', 'none'].includes(s)) return false
  return undefined
}

export function parseSource(raw: string | undefined): Source | 'auto' {
  const s = (raw ?? '').trim().toLowerCase()
  if (s === 'google' || s === 'google fonts' || s === 'gf') return 'google'
  if (s === 'fontsource' || s === 'fs') return 'fontsource'
  return 'auto'
}

function makeEntry(
  family: string,
  weights: string | undefined,
  italic: string | undefined,
  source: string | undefined,
  line: number,
): ListEntry {
  const w = parseWeights(weights)
  const it = parseBool(italic)
  return {
    family: family.trim().replace(/\s+/g, ' '),
    weights: w,
    // A whole family includes its italics. A specific weight list does not,
    // unless asked — that is how the sibling PowerPoint tool reads a deck too.
    italics: it ?? w === 'all',
    source: parseSource(source),
    line,
  }
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

const FAMILY_HEADERS = new Set(['family', 'name', 'font', 'fontfamily', 'font family', 'font_family', 'font-family', 'typeface'])
const WEIGHT_HEADERS = new Set(['weights', 'weight', 'styles', 'style'])
const ITALIC_HEADERS = new Set(['italic', 'italics'])
const SOURCE_HEADERS = new Set(['source', 'provider', 'library'])

function detectDelimiter(line: string): string {
  const counts: Array<[string, number]> = [',', ';', '\t'].map((d) => [d, line.split(d).length - 1])
  counts.sort((a, b) => b[1] - a[1])
  return counts[0]![1] > 0 ? counts[0]![0] : ','
}

/** RFC 4180-ish: quoted fields, doubled quotes, no multi-line fields. */
export function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === delimiter) {
      out.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

export function parseCsv(text: string): ListParseResult {
  const entries: ListEntry[] = []
  const errors: ListParseResult['errors'] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)

  const content = lines
    .map((raw, i) => ({ raw, line: i + 1 }))
    .filter(({ raw }) => raw.trim() !== '' && !raw.trim().startsWith('#'))
  if (content.length === 0) return { entries, errors, format: 'csv' }

  const delimiter = detectDelimiter(content[0]!.raw)
  let cols = { family: 0, weights: 1, italic: 2, source: 3 }
  let start = 0

  const head = splitCsvLine(content[0]!.raw, delimiter).map((h) => h.toLowerCase())
  if (head.some((h) => FAMILY_HEADERS.has(h))) {
    const idx = (set: Set<string>) => head.findIndex((h) => set.has(h))
    cols = {
      family: idx(FAMILY_HEADERS),
      weights: idx(WEIGHT_HEADERS),
      italic: idx(ITALIC_HEADERS),
      source: idx(SOURCE_HEADERS),
    }
    start = 1
  }

  for (const { raw, line } of content.slice(start)) {
    const cells = splitCsvLine(raw, delimiter)
    const family = cols.family >= 0 ? cells[cols.family] : undefined
    if (!family) {
      errors.push({ line, message: 'No family name in this row.' })
      continue
    }
    const cell = (i: number) => (i >= 0 ? cells[i] : undefined)
    entries.push(makeEntry(family, cell(cols.weights), cell(cols.italic), cell(cols.source), line))
  }
  return { entries, errors, format: 'csv' }
}

/* ------------------------------------------------------------------ */
/* XML                                                                 */
/* ------------------------------------------------------------------ */

interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
  line: number
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16))
    if (k.startsWith('#')) return String.fromCodePoint(parseInt(k.slice(1), 10))
    return m
  })
}

/**
 * A small, tolerant XML reader. Enough for a font list: elements, attributes,
 * text, comments, CDATA, processing instructions and a doctype line. Not a
 * validating parser and not meant to be — `src/core/` cannot use DOMParser
 * because it runs under node in the tests and in the Rust-side port.
 */
export function parseXmlTree(text: string): XmlNode {
  const src = text.replace(/^\uFEFF/, '')
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '', line: 1 }
  const stack: XmlNode[] = [root]
  let i = 0
  let line = 1
  const lineAt = (pos: number) => {
    for (; i < pos; i++) if (src.charCodeAt(i) === 10) line++
    return line
  }

  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|([^<]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1]!
    if (m[1] !== undefined) {
      top.text += m[1]
    } else if (m[2] !== undefined) {
      if (stack.length > 1 && top.name.toLowerCase() === m[2].toLowerCase()) stack.pop()
      // A mismatched close tag is ignored rather than fatal — a hand-edited
      // list with one typo should still yield the rest of its entries.
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {}
      const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
      let a: RegExpExecArray | null
      while ((a = attrRe.exec(m[4] ?? ''))) {
        attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')
      }
      const node: XmlNode = { name: m[3], attrs, children: [], text: '', line: lineAt(m.index) }
      top.children.push(node)
      if (!m[5]) stack.push(node)
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6])
    }
  }
  return root
}

function findAll(node: XmlNode, names: Set<string>, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (names.has(c.name.toLowerCase())) out.push(c)
    else findAll(c, names, out)
  }
  return out
}

export function parseXml(text: string): ListParseResult {
  const entries: ListEntry[] = []
  const errors: ListParseResult['errors'] = []
  const tree = parseXmlTree(text)
  const nodes = findAll(tree, new Set(['font', 'family', 'typeface']))
  for (const n of nodes) {
    const childText = (name: string) =>
      n.children
        .filter((c) => c.name.toLowerCase() === name)
        .map((c) => c.text.trim())
        .filter(Boolean)
    const family =
      n.attrs['family'] ?? n.attrs['name'] ?? childText('family')[0] ?? childText('name')[0] ?? n.text.trim()
    if (!family) {
      errors.push({ line: n.line, message: `<${n.name}> has no family name.` })
      continue
    }
    const weightAttr = n.attrs['weights'] ?? n.attrs['weight']
    const weightKids = [...childText('weight'), ...childText('weights')].join(' ')
    const weights = [weightAttr, weightKids].filter(Boolean).join(' ') || undefined
    const italic = n.attrs['italic'] ?? n.attrs['italics'] ?? childText('italic')[0]
    const source = n.attrs['source'] ?? n.attrs['provider'] ?? childText('source')[0]
    entries.push(makeEntry(family, weights, italic, source, n.line))
  }
  if (nodes.length === 0) errors.push({ line: 1, message: 'No <font> elements found.' })
  return { entries, errors, format: 'xml' }
}

/* ------------------------------------------------------------------ */
/* TXT, detection, resolution                                          */
/* ------------------------------------------------------------------ */

export function parseTxt(text: string): ListParseResult {
  const entries: ListEntry[] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  lines.forEach((raw, i) => {
    const s = raw.trim()
    if (!s || s.startsWith('#')) return
    entries.push(makeEntry(s, undefined, undefined, undefined, i + 1))
  })
  return { entries, errors: [], format: 'txt' }
}

export function detectFormat(text: string, filename = ''): 'csv' | 'xml' | 'txt' {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === 'xml') return 'xml'
  if (ext === 'csv' || ext === 'tsv') return 'csv'
  if (ext === 'txt' || ext === 'list') return 'txt'
  const head = text.replace(/^\uFEFF/, '').trimStart()
  if (head.startsWith('<')) return 'xml'
  const lines = head.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (lines.length === 0) return 'txt'
  const delimited = lines.filter((l) => /[,;\t]/.test(l)).length
  return delimited >= Math.ceil(lines.length / 2) ? 'csv' : 'txt'
}

export function parseList(text: string, filename = ''): ListParseResult {
  const format = detectFormat(text, filename)
  if (format === 'xml') return parseXml(text)
  if (format === 'csv') return parseCsv(text)
  return parseTxt(text)
}

export interface ResolvedList {
  items: Array<{ entry: ListEntry; family: Family; selection: Selection }>
  unresolved: Array<{
    entry: ListEntry
    /** Open stand-ins for a proprietary font, metric-compatible first. */
    substitutes: SubstituteHit[]
    /** Catalogue families sharing a word with the name. */
    suggestions: Family[]
  }>
}

/** Match every entry against the catalogue; suggest near-misses for the rest. */
export function resolveList(entries: ListEntry[]): ResolvedList {
  const items: ResolvedList['items'] = []
  const unresolved: ResolvedList['unresolved'] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const family = findFamily(entry.family, entry.source)
    if (!family || family.files.length === 0) {
      const substitutes = substitutesFor(entry.family)
      const taken = new Set(substitutes.map((s) => s.family.id))
      unresolved.push({
        entry,
        substitutes,
        suggestions: suggestFamilies(entry.family).filter((f) => !taken.has(f.id)),
      })
      continue
    }
    if (seen.has(family.id)) continue
    seen.add(family.id)
    items.push({ entry, family, selection: { weights: entry.weights, italics: entry.italics } })
  }
  return { items, unresolved }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

function csvCell(s: string): string {
  return /[",;\t\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function weightsText(sel: Selection): string {
  return sel.weights === 'all' ? 'all' : sel.weights.join(';')
}

export function toCSV(items: CartItem[]): string {
  const rows = ['family,weights,italic,source']
  for (const { family, selection } of items) {
    rows.push(
      [csvCell(family.name), weightsText(selection), selection.italics ? 'yes' : 'no', family.source].join(','),
    )
  }
  return rows.join('\n') + '\n'
}

function xmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

export function toXML(items: CartItem[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<fonts>']
  for (const { family, selection } of items) {
    lines.push(
      `  <font family="${xmlAttr(family.name)}" weights="${weightsText(selection).replace(/;/g, ' ')}" ` +
        `italic="${selection.italics ? 'true' : 'false'}" source="${family.source}"/>`,
    )
  }
  lines.push('</fonts>')
  return lines.join('\n') + '\n'
}
