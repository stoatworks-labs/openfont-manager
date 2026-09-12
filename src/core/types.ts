/**
 * Shared types. Everything in `src/core/` is DOM-free and runs unchanged in
 * vitest's node environment and inside the Tauri webview.
 */

export type Source = 'google' | 'fontsource'

export type Category = 'Sans Serif' | 'Serif' | 'Display' | 'Handwriting' | 'Monospace' | 'Other'

/** One downloadable file of a family, as the catalogue knows it. */
export interface FamilyFile {
  /** Filename the file will have on disk, e.g. `Poppins-SemiBold.ttf`. */
  filename: string
  /** Primary URL, always CORS-enabled. */
  url: string
  /** Mirrors to try when the primary fails or rate-limits. */
  mirrors: string[]
  weight: number
  italic: boolean
  /** `Family[wght].ttf` — one file spanning the whole weight axis. */
  variable: boolean
}

/** A font family from either catalogue, in one shape. */
export interface Family {
  /** Stable id: `google:poppins`, `fontsource:adwaita-sans`. */
  id: string
  name: string
  source: Source
  category: Category
  /** Published weights, ascending. */
  weights: number[]
  italic: boolean
  /** SPDX licence id, e.g. `OFL-1.1`. */
  license: string
  /** Where the licence text lives, when the source publishes one per family. */
  licenseUrl: string | null
  /** Script subsets the family covers (`latin`, `cyrillic`, ...). */
  subsets: string[]
  /** Variable-font axis tags; empty for a static family. */
  axes: string[]
  designers: string[]
  /** Popularity rank across the whole catalogue (1 = most popular). */
  rank: number
  /** YYYY-MM-DD the family was added, or ''. */
  added: string
  /** Approximate total bytes of every file, for the cart's estimate. */
  bytes: number
  files: FamilyFile[]
  /** Normalised lookup key, see names.ts. */
  key: string
}

/** Which faces of a family to take. */
export interface Selection {
  /** `all` takes every file; otherwise the nearest file per listed weight. */
  weights: 'all' | number[]
  /** Include italic faces. Ignored (always true) when weights is `all`. */
  italics: boolean
}

export const ALL: Selection = { weights: 'all', italics: true }

/** One item in the cart: a family and which of its faces are wanted. */
export interface CartItem {
  family: Family
  selection: Selection
}

/** One file to fetch, resolved from a cart item. */
export interface PlanItem {
  family: string
  familyId: string
  source: Source
  license: string
  filename: string
  url: string
  mirrors: string[]
  weight: number
  italic: boolean
  variable: boolean
}

/** A parsed line of a CSV/XML/TXT font list. */
export interface ListEntry {
  /** Family name as written. */
  family: string
  /** `all` (default) or specific weights. */
  weights: 'all' | number[]
  italics: boolean
  /** Preferred source; `auto` tries Google first, then Fontsource. */
  source: Source | 'auto'
  /** Line or element number, for error messages. */
  line: number
}

export interface ListParseResult {
  entries: ListEntry[]
  /** Lines that could not be read, with the reason. */
  errors: Array<{ line: number; message: string }>
  format: 'csv' | 'xml' | 'txt'
}
