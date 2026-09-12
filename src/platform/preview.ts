import type { Family } from '../core/types'

/**
 * Inline previews.
 *
 * This is the one place the Google CSS API is the right tool: it serves a
 * small, subsetted woff2 with `font-display: swap`, which is exactly what a
 * preview line wants and exactly what an *installer* must never use. Each
 * family's stylesheet is added once, lazily, when its card scrolls into view.
 *
 * Fontsource families come from the same CDN their files do. Its `index.css`
 * is the 400 upright face only, which is all the card shows.
 */

const loaded = new Set<string>()

export function previewCssUrl(f: Family): string {
  if (f.source === 'google') {
    // `family=Open+Sans` — the API wants `+` for spaces, not `%20`.
    return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f.name).replace(/%20/g, '+')}&display=swap`
  }
  const id = f.id.slice('fontsource:'.length)
  return `https://cdn.jsdelivr.net/fontsource/css/${id}@latest/index.css`
}

/** Ensure the stylesheet for a family's preview face is in the document. */
export function ensurePreview(f: Family): void {
  if (typeof document === 'undefined' || loaded.has(f.id)) return
  loaded.add(f.id)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = previewCssUrl(f)
  link.dataset['preview'] = f.id
  document.head.appendChild(link)
}

/** The CSS font-family stack a card should render with. */
export function previewFontFamily(f: Family): string {
  return `'${f.name.replace(/'/g, "\\'")}', 'Adjusted Fallback', sans-serif`
}
