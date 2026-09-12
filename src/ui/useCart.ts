import { useCallback, useEffect, useMemo, useState } from 'react'
import { familyById } from '../core/catalogue'
import { ALL, type CartItem, type Family, type Selection } from '../core/types'

/**
 * The cart: which families, and which of their faces. Kept in localStorage
 * so a half-built order survives a reload — the catalogue is 2,000 families
 * and nobody wants to find the same forty twice.
 */

const KEY = 'openfont.cart.v1'

interface Stored {
  id: string
  weights: 'all' | number[]
  italics: boolean
}

function load(): Map<string, CartItem> {
  const out = new Map<string, CartItem>()
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return out
    for (const s of JSON.parse(raw) as Stored[]) {
      const family = familyById(s.id)
      if (!family) continue
      out.set(s.id, { family, selection: { weights: s.weights, italics: s.italics } })
    }
  } catch {
    // Storage unavailable or corrupt: start empty.
  }
  return out
}

function persist(cart: Map<string, CartItem>): void {
  try {
    const stored: Stored[] = [...cart.values()].map(({ family, selection }) => ({
      id: family.id,
      weights: selection.weights,
      italics: selection.italics,
    }))
    localStorage.setItem(KEY, JSON.stringify(stored))
  } catch {
    // Nothing to do — the cart still works for this session.
  }
}

export function useCart() {
  const [cart, setCart] = useState<Map<string, CartItem>>(() => load())

  useEffect(() => persist(cart), [cart])

  const add = useCallback((family: Family, selection: Selection = ALL) => {
    setCart((prev) => {
      const next = new Map(prev)
      next.set(family.id, { family, selection })
      return next
    })
  }, [])

  const addMany = useCallback((items: Array<{ family: Family; selection?: Selection }>) => {
    setCart((prev) => {
      const next = new Map(prev)
      for (const { family, selection } of items) {
        if (family.files.length === 0) continue
        if (!next.has(family.id)) next.set(family.id, { family, selection: selection ?? ALL })
      }
      return next
    })
  }, [])

  const remove = useCallback((id: string) => {
    setCart((prev) => {
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const setSelection = useCallback((id: string, selection: Selection) => {
    setCart((prev) => {
      const item = prev.get(id)
      if (!item) return prev
      const next = new Map(prev)
      next.set(id, { ...item, selection })
      return next
    })
  }, [])

  const clear = useCallback(() => setCart(new Map()), [])

  const items = useMemo(() => [...cart.values()].sort((a, b) => a.family.name.localeCompare(b.family.name)), [cart])

  return { cart, items, add, addMany, remove, setSelection, clear }
}

export type Cart = ReturnType<typeof useCart>
