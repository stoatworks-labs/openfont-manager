import type { CartItem, Family, FamilyFile, PlanItem, Selection } from './types'

/**
 * Turn cart items into the list of files to fetch.
 *
 * A family is normally taken whole — a font manager installs families, not
 * faces — but a list can ask for particular weights, and then the nearest
 * published file per weight is chosen, as the sibling PowerPoint tool does.
 *
 * Variable fonts (`EBGaramond[wght].ttf`) are one file spanning every weight,
 * so they satisfy any weight request on their axis. Static files are preferred
 * when one matches, because they are unambiguous to a system font installer.
 */
export function selectFiles(family: Family, selection: Selection): FamilyFile[] {
  if (selection.weights === 'all') return family.files

  const chosen: FamilyFile[] = []
  const seen = new Set<string>()
  const styles = selection.italics ? [false, true] : [false]
  for (const w of selection.weights.length ? selection.weights : [400]) {
    for (const italic of styles) {
      for (const pick of pickFiles(family.files, w, italic)) {
        if (seen.has(pick.filename)) continue
        seen.add(pick.filename)
        chosen.push(pick)
      }
    }
  }
  return chosen
}

function pickFiles(files: FamilyFile[], wantWeight: number, wantItalic: boolean): FamilyFile[] {
  const statics = files.filter((d) => !d.variable && d.italic === wantItalic)
  if (statics.length > 0) {
    const best = statics.reduce((a, b) =>
      Math.abs(b.weight - wantWeight) < Math.abs(a.weight - wantWeight) ? b : a,
    )
    return [best]
  }
  const variables = files.filter((d) => d.variable && d.italic === wantItalic)
  if (variables.length > 0) return [variables[0]!]
  // An italic was asked for and the family has none: fall back to upright
  // rather than silently dropping the weight.
  const uprights = files.filter((d) => !d.italic)
  return uprights.length > 0 ? [uprights[0]!] : files.slice(0, 1)
}

export function buildPlan(items: CartItem[]): PlanItem[] {
  const out: PlanItem[] = []
  const seen = new Set<string>()
  for (const { family, selection } of items) {
    for (const f of selectFiles(family, selection)) {
      const key = `${family.id}/${f.filename}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        family: family.name,
        familyId: family.id,
        source: family.source,
        license: family.license,
        filename: f.filename,
        url: f.url,
        mirrors: f.mirrors,
        weight: f.weight,
        italic: f.italic,
        variable: f.variable,
      })
    }
  }
  return out
}

/** Rough byte estimate for a set of cart items, for the UI. */
export function estimateBytes(items: CartItem[]): number {
  let total = 0
  for (const { family, selection } of items) {
    if (family.files.length === 0) continue
    const perFile = family.bytes / family.files.length
    total += perFile * selectFiles(family, selection).length
  }
  return Math.round(total)
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
