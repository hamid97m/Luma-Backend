import { describe, it, expect } from 'vitest'
import { mapTelegramLang, isLocale, LOCALES } from '../src/i18n/locale.js'
import { tFor } from '../src/i18n/index.js'
import { fa } from '../src/i18n/fa.js'
import { en } from '../src/i18n/en.js'
import { ar } from '../src/i18n/ar.js'

describe('mapTelegramLang', () => {
  it('maps fa / fa-IR to fa', () => {
    expect(mapTelegramLang('fa')).toBe('fa')
    expect(mapTelegramLang('fa-IR')).toBe('fa')
  })
  it('maps ar / ar-SA to ar', () => {
    expect(mapTelegramLang('ar')).toBe('ar')
    expect(mapTelegramLang('ar-SA')).toBe('ar')
  })
  it('maps everything else (and undefined) to en', () => {
    expect(mapTelegramLang('en')).toBe('en')
    expect(mapTelegramLang('de')).toBe('en')
    expect(mapTelegramLang(undefined)).toBe('en')
    expect(mapTelegramLang(null)).toBe('en')
    expect(mapTelegramLang('')).toBe('en')
  })
})

describe('isLocale', () => {
  it('accepts the three locales and rejects anything else', () => {
    for (const l of LOCALES) expect(isLocale(l)).toBe(true)
    expect(isLocale('de')).toBe(false)
    expect(isLocale(null)).toBe(false)
    expect(isLocale(1)).toBe(false)
  })
})

describe('tFor', () => {
  it('returns fa for null/undefined (backfilled users)', () => {
    expect(tFor(null)).toBe(fa)
    expect(tFor(undefined)).toBe(fa)
  })
  it('returns the requested locale', () => {
    expect(tFor('en')).toBe(en)
    expect(tFor('ar')).toBe(ar)
    expect(tFor('fa')).toBe(fa)
  })
})
