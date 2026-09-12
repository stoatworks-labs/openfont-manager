import { describe, expect, it } from 'vitest'
import { fetchBytes, isSfnt, runQueue } from '../src/core/fetch'

const TTF = new Uint8Array([0, 1, 0, 0, 0, 12])
const OTF = new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 1])

function response(status: number, body: Uint8Array | string, headers: Record<string, string> = {}): Response {
  return new Response(body as BodyInit, { status, headers })
}

describe('isSfnt', () => {
  it('accepts sfnt signatures and rejects anything else', () => {
    expect(isSfnt(TTF)).toBe(true)
    expect(isSfnt(OTF)).toBe(true)
    expect(isSfnt(new TextEncoder().encode('<!doctype html>'))).toBe(false)
    expect(isSfnt(new Uint8Array(2))).toBe(false)
  })
})

describe('fetchBytes', () => {
  it('retries a 429 with backoff, honouring Retry-After', async () => {
    const calls: string[] = []
    const fetch = async (url: string) => {
      calls.push(url)
      return calls.length === 1 ? response(429, '', { 'retry-after': '0' }) : response(200, TTF)
    }
    const got = await fetchBytes(['a'], { fetch, attempts: 3 })
    expect(got.url).toBe('a')
    expect(calls).toEqual(['a', 'a'])
  })

  it('moves to the mirror on a 404 and on a non-font body', async () => {
    const calls: string[] = []
    const fetch = async (url: string) => {
      calls.push(url)
      if (url === 'a') return response(404, 'nope')
      if (url === 'b') return response(200, '<html>rate limited</html>')
      return response(200, TTF)
    }
    const got = await fetchBytes(['a', 'b', 'c'], { fetch })
    expect(got.url).toBe('c')
    expect(calls).toEqual(['a', 'b', 'c'])
  })

  it('throws the last error when every URL fails', async () => {
    const fetch = async () => response(500, '')
    await expect(fetchBytes(['a', 'b'], { fetch, attempts: 1 })).rejects.toThrow(/500 for b/)
  })

  it('does not require a font signature for text', async () => {
    const fetch = async () => response(200, 'licence text')
    const got = await fetchBytes(['a'], { fetch, expectFont: false })
    expect(new TextDecoder().decode(got.data)).toBe('licence text')
  })
})

describe('runQueue', () => {
  it('limits concurrency and collects failures without stopping', async () => {
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 10 }, (_, i) => i)
    const { failures } = await runQueue(
      items,
      3,
      async (i) => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        if (i % 4 === 0) throw new Error(`boom ${i}`)
        return i
      },
      { label: (i) => String(i) },
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(failures.map((f) => f.item)).toEqual([0, 4, 8])
  })
})
