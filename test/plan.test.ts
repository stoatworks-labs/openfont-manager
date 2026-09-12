import { describe, expect, it } from 'vitest'
import { findFamily } from '../src/core/catalogue'
import { buildPlan, estimateBytes, formatBytes, selectFiles } from '../src/core/plan'
import { ALL } from '../src/core/types'

describe('selectFiles', () => {
  it('takes the whole family by default', () => {
    const p = findFamily('Poppins')!
    expect(selectFiles(p, ALL)).toHaveLength(p.files.length)
  })

  it('picks the nearest static per weight, italics only when asked', () => {
    const p = findFamily('Poppins')!
    const names = (w: number[], italics: boolean) => selectFiles(p, { weights: w, italics }).map((f) => f.filename)
    expect(names([400, 620], false)).toEqual(['Poppins-Regular.ttf', 'Poppins-SemiBold.ttf'])
    expect(names([700], true)).toEqual(['Poppins-Bold.ttf', 'Poppins-BoldItalic.ttf'])
  })

  it('uses the variable file when the family has no statics', () => {
    const inter = findFamily('Inter')!
    const files = selectFiles(inter, { weights: [300, 700], italics: true })
    expect(files.map((f) => f.filename).sort()).toEqual(['Inter-Italic[opsz,wght].ttf', 'Inter[opsz,wght].ttf'])
  })

  it('falls back to upright when an italic is asked of a family without one', () => {
    const abel = findFamily('Abel')!
    expect(selectFiles(abel, { weights: [400], italics: true }).map((f) => f.filename)).toEqual(['Abel-Regular.ttf'])
  })
})

describe('buildPlan', () => {
  it('flattens and de-duplicates', () => {
    const p = findFamily('Poppins')!
    const plan = buildPlan([
      { family: p, selection: { weights: [400], italics: false } },
      { family: p, selection: { weights: [400, 700], italics: false } },
    ])
    expect(plan.map((i) => i.filename)).toEqual(['Poppins-Regular.ttf', 'Poppins-Bold.ttf'])
    expect(plan[0]).toMatchObject({ family: 'Poppins', familyId: 'google:poppins', source: 'google', license: 'OFL-1.1', weight: 400 })
  })

  it('estimates and formats sizes', () => {
    const p = findFamily('Poppins')!
    expect(estimateBytes([{ family: p, selection: ALL }])).toBe(p.bytes)
    expect(estimateBytes([{ family: p, selection: { weights: [400], italics: false } }])).toBe(Math.round(p.bytes / p.files.length))
    expect(formatBytes(500)).toBe('500 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatBytes(2.25 * 1024 ** 3)).toBe('2.25 GB')
  })
})
