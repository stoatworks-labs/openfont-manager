import { describe, expect, it } from 'vitest'
import {
  COUNTS,
  EMPTY_QUERY,
  FAMILIES,
  describeGoogleFile,
  findFamily,
  fontsourceFilename,
  searchFamilies,
  suggestFamilies,
} from '../src/core/catalogue'

describe('catalogue', () => {
  it('loads both sources', () => {
    expect(COUNTS.google).toBeGreaterThan(1900)
    expect(COUNTS.fontsource).toBeGreaterThan(100)
    expect(COUNTS.total).toBe(FAMILIES.length)
    const ids = new Set(FAMILIES.map((f) => f.id))
    expect(ids.size).toBe(FAMILIES.length)
  })

  it('finds families by loose name', () => {
    expect(findFamily('poppins')?.id).toBe('google:poppins')
    expect(findFamily('Poppins SemiBold Italic')?.id).toBe('google:poppins')
    expect(findFamily('Open+Sans')?.name).toBeUndefined()
    expect(findFamily('Open Sans')?.name).toBe('Open Sans')
    expect(findFamily('adwaita-sans')?.source).toBe('fontsource')
    expect(findFamily('Poppins', 'fontsource')).toBeUndefined()
    expect(findFamily('Nope Sans')).toBeUndefined()
  })

  it('builds download URLs and licence URLs', () => {
    const p = findFamily('Poppins')!
    expect(p.files.map((f) => f.filename)).toContain('Poppins-SemiBold.ttf')
    const semi = p.files.find((f) => f.filename === 'Poppins-SemiBold.ttf')!
    expect(semi).toMatchObject({ weight: 600, italic: false, variable: false })
    expect(semi.url).toBe('https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/Poppins-SemiBold.ttf')
    expect(semi.mirrors[0]).toBe('https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/poppins/Poppins-SemiBold.ttf')
    expect(p.licenseUrl).toBe('https://raw.githubusercontent.com/google/fonts/main/ofl/poppins/OFL.txt')

    const a = findFamily('Adwaita Sans')!
    expect(a.files[0]!.url).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/fontsource\/fonts\/adwaita-sans@latest\/latin-\d+-(normal|italic)\.ttf$/)
    expect(a.files.map((f) => f.filename)).toContain('AdwaitaSans-Regular.ttf')
  })

  it('describes google filenames', () => {
    expect(describeGoogleFile('Inter[opsz,wght].ttf')).toEqual({ weight: 400, italic: false, variable: true })
    expect(describeGoogleFile('Inter-Italic[opsz,wght].ttf')).toEqual({ weight: 400, italic: true, variable: true })
    expect(describeGoogleFile('Poppins-ExtraBoldItalic.ttf')).toEqual({ weight: 800, italic: true, variable: false })
    expect(describeGoogleFile('Abel-Regular.ttf')).toEqual({ weight: 400, italic: false, variable: false })
    expect(fontsourceFilename('Chunk Five', 400, false)).toBe('ChunkFive-Regular.ttf')
    expect(fontsourceFilename('Chunk Five', 700, true)).toBe('ChunkFive-BoldItalic.ttf')
    expect(fontsourceFilename('Chunk Five', 400, true)).toBe('ChunkFive-Italic.ttf')
  })

  it('searches with filters and ranks prefix matches first', () => {
    const r = searchFamilies({ ...EMPTY_QUERY, text: 'roboto' })
    expect(r[0]!.name).toBe('Roboto')
    expect(r.every((f) => f.key.includes('roboto') || f.designers.join(' ').toLowerCase().includes('roboto'))).toBe(true)

    const mono = searchFamilies({ ...EMPTY_QUERY, categories: ['Monospace'], sources: ['fontsource'] })
    expect(mono.length).toBeGreaterThan(0)
    expect(mono.every((f) => f.category === 'Monospace' && f.source === 'fontsource')).toBe(true)

    const variable = searchFamilies({ ...EMPTY_QUERY, variableOnly: true, subsets: ['cyrillic'], licenses: ['OFL-1.1'] })
    expect(variable.every((f) => f.axes.length > 0 && f.subsets.includes('cyrillic') && f.license === 'OFL-1.1')).toBe(true)

    const byName = searchFamilies({ ...EMPTY_QUERY, sort: 'name' })
    expect(byName[0]!.name.localeCompare(byName[1]!.name)).toBeLessThanOrEqual(0)

    const newest = searchFamilies({ ...EMPTY_QUERY, sort: 'newest', sources: ['google'] })
    expect(newest[0]!.added >= newest[1]!.added).toBe(true)
  })

  it('suggests token neighbours', () => {
    expect(suggestFamilies('Garamond').map((f) => f.name)).toContain('EB Garamond')
    expect(suggestFamilies('xx')).toEqual([])
  })
})
