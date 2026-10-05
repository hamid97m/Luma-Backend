import { describe, it, expect } from 'vitest'
import { fa } from '../src/i18n/fa.js'
import { en } from '../src/i18n/en.js'
import { ar } from '../src/i18n/ar.js'

/** Flatten to "path → kind" where kind is 'string' | 'fn:<arity>' | 'array'. */
function shape(obj: any, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'function') out[p] = `fn:${v.length}`
    else if (Array.isArray(v)) out[p] = 'array'
    else if (v && typeof v === 'object') Object.assign(out, shape(v, p))
    else out[p] = typeof v
  }
  return out
}

describe('backend locale shape', () => {
  const base = shape(fa)
  it('en has exactly the same keys and function arities as fa', () => {
    expect(shape(en)).toEqual(base)
  })
  it('ar has exactly the same keys and function arities as fa', () => {
    expect(shape(ar)).toEqual(base)
  })
  it('no locale string is empty', () => {
    for (const loc of [fa, en, ar]) {
      for (const [k, kind] of Object.entries(shape(loc))) {
        if (kind !== 'string') continue
        const v = k.split('.').reduce((o: any, p) => o[p], loc)
        expect(v, k).not.toBe('')
      }
    }
  })
})
