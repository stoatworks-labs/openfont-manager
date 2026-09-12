import { describe, expect, it } from 'vitest'
import { detectFormat, parseCsv, parseList, parseTxt, parseWeights, parseXml, resolveList, toCSV, toXML } from '../src/core/lists'
import { findFamily } from '../src/core/catalogue'
import { ALL } from '../src/core/types'

describe('parseWeights', () => {
  it('reads numbers, words and separators', () => {
    expect(parseWeights('400;700')).toEqual([400, 700])
    expect(parseWeights('700 400')).toEqual([400, 700])
    expect(parseWeights('bold+light')).toEqual([300, 700])
    expect(parseWeights('Semi Bold')).toEqual([600])
    expect(parseWeights('')).toBe('all')
    expect(parseWeights('all')).toBe('all')
    expect(parseWeights('nonsense')).toBe('all')
  })
})

describe('CSV', () => {
  it('reads a header row in any column order', () => {
    const r = parseCsv('source,italic,family,weights\ngoogle,no,Poppins,400;700\n,,Inter,\n')
    expect(r.errors).toEqual([])
    expect(r.entries).toHaveLength(2)
    expect(r.entries[0]).toMatchObject({ family: 'Poppins', weights: [400, 700], italics: false, source: 'google', line: 2 })
    expect(r.entries[1]).toMatchObject({ family: 'Inter', weights: 'all', italics: true, source: 'auto', line: 3 })
  })

  it('takes positional columns without a header, and one-column files', () => {
    const r = parseCsv('Poppins,700,yes\n"Playfair Display"\n')
    expect(r.entries[0]).toMatchObject({ family: 'Poppins', weights: [700], italics: true })
    expect(r.entries[1]).toMatchObject({ family: 'Playfair Display', weights: 'all' })
  })

  it('handles semicolons, quotes, BOM, CRLF and comments', () => {
    const r = parseCsv('﻿family;weights\r\n# a comment\r\n"Noto Sans ""JP""";400\r\n')
    expect(r.entries).toEqual([{ family: 'Noto Sans "JP"', weights: [400], italics: false, source: 'auto', line: 3 }])
  })

  it('reports rows with no family', () => {
    const r = parseCsv('family,weights\n,400\nInter,\n')
    expect(r.errors).toEqual([{ line: 2, message: 'No family name in this row.' }])
    expect(r.entries).toHaveLength(1)
  })
})

describe('XML', () => {
  it('reads attributes, text and child elements', () => {
    const xml = `<?xml version="1.0"?>
<!-- fonts for the show -->
<fontList>
  <font family="Poppins" weights="400 700" italic="true" source="google"/>
  <font>Inter</font>
  <font name="Playfair Display"><weight>700</weight><weight>900</weight><italic>no</italic></font>
  <group><Family family="Lato &amp; friends"/></group>
</fontList>`
    const r = parseXml(xml)
    expect(r.errors).toEqual([])
    expect(r.entries.map((e) => e.family)).toEqual(['Poppins', 'Inter', 'Playfair Display', 'Lato & friends'])
    expect(r.entries[0]).toMatchObject({ weights: [400, 700], italics: true, source: 'google' })
    expect(r.entries[2]).toMatchObject({ weights: [700, 900], italics: false })
    expect(r.entries[1]!.line).toBe(5)
  })

  it('complains when there are no font elements', () => {
    expect(parseXml('<a><b/></a>').errors[0]!.message).toMatch(/No <font>/)
  })
})

describe('detection', () => {
  it('uses the extension first, then the content', () => {
    expect(detectFormat('<fonts/>', 'x.csv')).toBe('csv')
    expect(detectFormat('  <fonts/>')).toBe('xml')
    expect(detectFormat('Poppins\nInter\n')).toBe('txt')
    expect(detectFormat('Poppins,400\nInter,700\n')).toBe('csv')
    expect(parseList('Poppins\n# comment\nInter').entries).toHaveLength(2)
    expect(parseTxt('Poppins').format).toBe('txt')
  })
})

describe('resolution and export', () => {
  it('resolves names against the catalogue and suggests near misses', () => {
    const r = resolveList(parseList('Poppins-Bold\nGaramond\nPoppins\n').entries)
    expect(r.items.map((i) => i.family.name)).toEqual(['Poppins'])
    expect(r.unresolved).toHaveLength(1)
    expect(r.unresolved[0]!.substitutes.map((s) => s.family.name)).toEqual(['EB Garamond', 'Cormorant Garamond'])
    expect(r.unresolved[0]!.suggestions.map((f) => f.name)).not.toContain('EB Garamond')
  })

  it('offers metric-compatible stand-ins for proprietary fonts', () => {
    const r = resolveList(parseList('Calibri\nArial Narrow\nSegoe UI Semibold\nComic Sans MS').entries)
    expect(r.items).toEqual([])
    const subs = Object.fromEntries(r.unresolved.map((u) => [u.entry.family, u.substitutes.map((s) => `${s.family.name}:${s.metric}`)]))
    expect(subs).toEqual({
      Calibri: ['Carlito:true'],
      'Arial Narrow': ['Arimo:true'],
      'Segoe UI Semibold': ['Open Sans:false', 'Source Sans 3:false'],
      'Comic Sans MS': [],
    })
  })

  it('round-trips through CSV and XML', () => {
    const items = [
      { family: findFamily('Poppins')!, selection: { weights: [400, 700] as number[], italics: true } },
      { family: findFamily('Adwaita Sans')!, selection: ALL },
    ]
    const csv = parseCsv(toCSV(items))
    expect(csv.entries[0]).toMatchObject({ family: 'Poppins', weights: [400, 700], italics: true, source: 'google' })
    expect(csv.entries[1]).toMatchObject({ family: 'Adwaita Sans', weights: 'all', italics: true, source: 'fontsource' })
    const xml = parseXml(toXML(items))
    expect(xml.entries[0]).toMatchObject({ family: 'Poppins', weights: [400, 700], italics: true, source: 'google' })
    expect(resolveList(xml.entries).items.map((i) => i.family.id)).toEqual(['google:poppins', 'fontsource:adwaita-sans'])
  })
})
