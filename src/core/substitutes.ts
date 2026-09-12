import { findFamily } from './catalogue'
import { normalizeKey, parseFontName } from './names'
import type { Family } from './types'

/**
 * Open-licence stand-ins for the proprietary fonts a list is most likely to
 * name — the ones a machine picks up just by being Windows or a Mac. None of
 * them is in either catalogue and none may be redistributed, so when a list
 * asks for Calibri the honest answer is "no, but Carlito has the same widths".
 *
 * Metric-compatible means the same advance widths: text set in the substitute
 * occupies the same space, so a document does not reflow. The others are
 * merely similar in look, and the UI says so.
 *
 * Table carried over from the sibling PowerPoint Font Manager, where it was
 * checked family by family against the catalogue.
 */

export interface Substitute {
  family: string
  metric: boolean
  note: string
}

interface Entry {
  target: string
  aliases?: string[]
  substitutes: Substitute[]
}

const METRIC = (of: string) => `Metric-compatible with ${of} — same widths, so documents do not reflow.`
const SIMILAR = 'Similar in look; widths differ, so line breaks will move.'

const TABLE: Entry[] = [
  { target: 'Calibri', aliases: ['Calibri Light'], substitutes: [{ family: 'Carlito', metric: true, note: METRIC('Calibri') }] },
  { target: 'Cambria', aliases: ['Cambria Math'], substitutes: [{ family: 'Caladea', metric: true, note: METRIC('Cambria') }] },
  {
    target: 'Arial',
    aliases: ['Helvetica', 'Arial MT', 'ArialMT', 'Liberation Sans', 'Arial Narrow'],
    substitutes: [{ family: 'Arimo', metric: true, note: METRIC('Arial (and so Helvetica)') }],
  },
  {
    target: 'Times New Roman',
    aliases: ['Times New', 'Times', 'Times Roman', 'Liberation Serif', 'TimesNewRomanPSMT'],
    substitutes: [{ family: 'Tinos', metric: true, note: METRIC('Times New Roman') }],
  },
  {
    target: 'Courier New',
    aliases: ['Courier', 'Liberation Mono', 'CourierNewPSMT'],
    substitutes: [{ family: 'Cousine', metric: true, note: METRIC('Courier New') }],
  },
  { target: 'Georgia', substitutes: [{ family: 'Gelasio', metric: true, note: METRIC('Georgia') }] },
  {
    target: 'Segoe UI',
    aliases: ['Segoe', 'Segoe UI Light', 'Segoe UI Semibold', 'Segoe UI Semilight', 'Segoe UI Black'],
    substitutes: [
      { family: 'Open Sans', metric: false, note: SIMILAR },
      { family: 'Source Sans 3', metric: false, note: SIMILAR },
    ],
  },
  {
    target: 'Helvetica Neue',
    aliases: ['HelveticaNeue'],
    substitutes: [
      { family: 'Inter', metric: false, note: SIMILAR },
      { family: 'Lato', metric: false, note: SIMILAR },
    ],
  },
  {
    target: 'Garamond',
    aliases: ['ITC Garamond', 'Adobe Garamond', 'Garamond MT', 'Garamond Premier'],
    substitutes: [
      { family: 'EB Garamond', metric: false, note: 'A digitisation from the same Garamond source. Widths differ.' },
      { family: 'Cormorant Garamond', metric: false, note: SIMILAR },
    ],
  },
  { target: 'Futura', aliases: ['Futura PT', 'Century Gothic'], substitutes: [{ family: 'Jost', metric: false, note: SIMILAR }] },
  { target: 'Gill Sans', aliases: ['Gill Sans MT', 'Gill Sans Nova'], substitutes: [{ family: 'Lato', metric: false, note: SIMILAR }] },
  { target: 'Verdana', substitutes: [{ family: 'DejaVu Sans', metric: false, note: SIMILAR }] },
  { target: 'Tahoma', substitutes: [{ family: 'DejaVu Sans', metric: false, note: SIMILAR }] },
  { target: 'Trebuchet MS', aliases: ['Trebuchet'], substitutes: [{ family: 'Fira Sans', metric: false, note: SIMILAR }] },
  { target: 'Avenir', aliases: ['Avenir Next', 'Avenir LT Std'], substitutes: [{ family: 'Nunito Sans', metric: false, note: SIMILAR }] },
  { target: 'Proxima Nova', substitutes: [{ family: 'Montserrat', metric: false, note: SIMILAR }] },
  { target: 'Myriad Pro', aliases: ['Myriad'], substitutes: [{ family: 'PT Sans', metric: false, note: SIMILAR }] },
  { target: 'Aptos', aliases: ['Aptos Display', 'Aptos Narrow'], substitutes: [{ family: 'Inter', metric: false, note: SIMILAR }] },
]

const BY_KEY = new Map<string, Entry>()
for (const e of TABLE) {
  BY_KEY.set(normalizeKey(e.target), e)
  for (const a of e.aliases ?? []) BY_KEY.set(normalizeKey(a), e)
}

export interface SubstituteHit {
  target: string
  family: Family
  metric: boolean
  note: string
}

/** Stand-ins for a name that is not in the catalogue, best first. */
export function substitutesFor(name: string): SubstituteHit[] {
  const entry = BY_KEY.get(normalizeKey(name)) ?? BY_KEY.get(normalizeKey(parseFontName(name).family))
  if (!entry) return []
  const out: SubstituteHit[] = []
  for (const s of entry.substitutes) {
    const family = findFamily(s.family)
    // A substitute that is not actually downloadable is worse than none.
    if (family && family.files.length > 0) out.push({ target: entry.target, family, metric: s.metric, note: s.note })
  }
  return out
}
