import { unzipSync, strFromU8 } from 'fflate'
import { describe, expect, it } from 'vitest'
import { downloadBundle } from '../src/core/bundle'
import { findFamily } from '../src/core/catalogue'
import { buildPlan } from '../src/core/plan'
import { ALL } from '../src/core/types'

function ttf(tag: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(64))
  out.set([0, 1, 0, 0])
  out.set(new TextEncoder().encode(tag), 8)
  return out
}

describe('downloadBundle', () => {
  it('streams a zip with fonts per family, licences, scripts and a manifest', async () => {
    const poppins = findFamily('Poppins')!
    const adwaita = findFamily('Adwaita Sans')!
    const plan = buildPlan([
      { family: poppins, selection: { weights: [400, 700], italics: false } },
      { family: adwaita, selection: { weights: [400], italics: false } },
    ])

    const seen: string[] = []
    const fetch = async (url: string) => {
      seen.push(url)
      if (url.endsWith('OFL.txt')) return new Response('SIL OPEN FONT LICENSE', { status: 200 })
      if (url.endsWith('/LICENSE')) return new Response('MIT-ish', { status: 200 })
      if (url.includes('Poppins-Bold')) {
        // Primary rate-limits; the mirror serves it.
        return url.startsWith('https://raw.') ? new Response('', { status: 429 }) : new Response(ttf('bold'), { status: 200 })
      }
      return new Response(ttf(url.slice(-20)), { status: 200 })
    }

    const chunks: Uint8Array[] = []
    let finals = 0
    const result = await downloadBundle(plan, {
      fetch,
      sink: (chunk, final) => {
        chunks.push(chunk)
        if (final) finals++
      },
      title: 'Test bundle',
      compress: false,
      concurrency: 2,
    })

    expect(finals).toBe(1)
    expect(result.failures).toEqual([])
    expect(result.entries).toHaveLength(3)
    expect(result.entries.find((e) => e.filename === 'Poppins-Bold.ttf')!.fetchedFrom).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/gh\//)

    const total = chunks.reduce((n, c) => n + c.length, 0)
    const zip = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      zip.set(c, off)
      off += c.length
    }
    const files = unzipSync(zip)
    const names = Object.keys(files).sort()
    expect(names).toEqual([
      'MANIFEST.txt',
      'README.txt',
      'fonts/Adwaita Sans/AdwaitaSans-Regular.ttf',
      'fonts/Adwaita Sans/LICENSE.txt',
      'fonts/Poppins/OFL.txt',
      'fonts/Poppins/Poppins-Bold.ttf',
      'fonts/Poppins/Poppins-Regular.ttf',
      'install-fonts.cmd',
      'install-fonts.command',
      'install-fonts.ps1',
      'install-fonts.sh',
    ])
    expect(files['fonts/Poppins/Poppins-Bold.ttf']!.slice(0, 4)).toEqual(new Uint8Array([0, 1, 0, 0]))
    const manifest = strFromU8(files['MANIFEST.txt']!)
    expect(manifest).toContain('2 families, 3 files')
    expect(manifest).toContain('licence:  OFL-1.1')
    expect(manifest).toContain('Poppins-Bold.ttf')
    expect(strFromU8(files['README.txt']!)).toContain('2 families, 3 font files')
    expect(strFromU8(files['install-fonts.command']!)).toContain('find fonts -type f \\(')
  })

  it('records files it could not fetch and still finishes', async () => {
    const abel = findFamily('Abel')!
    const plan = buildPlan([{ family: abel, selection: ALL }])
    const fetch = async () => new Response('', { status: 500 })
    const chunks: Uint8Array[] = []
    const result = await downloadBundle(plan, {
      fetch,
      sink: (c) => chunks.push(c),
      title: 't',
      licences: false,
    })
    expect(result.entries).toEqual([])
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]!.error).toMatch(/500/)
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const zip = new Uint8Array(total)
    let off = 0
    for (const c of chunks) {
      zip.set(c, off)
      off += c.length
    }
    expect(strFromU8(unzipSync(zip)['MANIFEST.txt']!)).toContain('NOT INCLUDED')
  })
})
