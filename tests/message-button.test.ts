import { describe, it, expect } from 'vitest'
import { validateButton } from '../src/messaging/messageButton.js'

describe('validateButton', () => {
  it('treats absent / null as no button', () => {
    expect(validateButton(undefined)).toEqual({ ok: true })
    expect(validateButton(null)).toEqual({ ok: true })
  })

  it('treats an all-empty object as no button', () => {
    expect(validateButton({})).toEqual({ ok: true })
    expect(validateButton({ title: '   ', url: '', screen: '' })).toEqual({ ok: true })
  })

  it('accepts a valid url button', () => {
    expect(validateButton({ title: 'Visit', kind: 'url', url: 'https://luma.app/promo' }))
      .toEqual({ ok: true, button: { title: 'Visit', kind: 'url', url: 'https://luma.app/promo' } })
  })

  it('accepts a valid screen button', () => {
    expect(validateButton({ title: 'See likes', kind: 'screen', screen: 'likes' }))
      .toEqual({ ok: true, button: { title: 'See likes', kind: 'screen', screen: 'likes' } })
  })

  it('trims the title', () => {
    const r = validateButton({ title: '  Open  ', kind: 'screen', screen: 'matches' })
    expect(r).toEqual({ ok: true, button: { title: 'Open', kind: 'screen', screen: 'matches' } })
  })

  it('rejects a title over 64 chars', () => {
    expect(validateButton({ title: 'x'.repeat(65), kind: 'url', url: 'https://a.b' }))
      .toEqual({ ok: false, error: 'button_title_too_long' })
  })

  it('rejects a url button without a valid http(s) url', () => {
    expect(validateButton({ title: 'Go', kind: 'url', url: 'ftp://x' }).ok).toBe(false)
    expect(validateButton({ title: 'Go', kind: 'url', url: 'not a url' }).ok).toBe(false)
    expect(validateButton({ title: 'Go', kind: 'url', url: '' }).ok).toBe(false)
  })

  it('rejects a screen button with an unknown screen', () => {
    expect(validateButton({ title: 'Go', kind: 'screen', screen: 'chat' }))
      .toEqual({ ok: false, error: 'button_screen_invalid' })
  })

  it('rejects a title with no target (partially filled)', () => {
    expect(validateButton({ title: 'Go' })).toEqual({ ok: false, error: 'button_kind_invalid' })
  })

  it('rejects an unknown kind', () => {
    expect(validateButton({ title: 'Go', kind: 'sticker', url: 'https://a.b' }))
      .toEqual({ ok: false, error: 'button_kind_invalid' })
  })
})
