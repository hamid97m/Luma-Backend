import { describe, it, expect, beforeAll, vi } from 'vitest'

// bot.ts imports db.ts, which calls createClient() at load — mock it so the
// import doesn't require Supabase env. buildMessageKeyboard never touches db.
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { buildMessageKeyboard } from '../src/bot.js'

// buildMessageKeyboard reads process.env.WEB_URL for screen deep links.
beforeAll(() => { process.env.WEB_URL = 'https://app.example.com' })

describe('buildMessageKeyboard', () => {
  it('returns undefined when no button is configured', () => {
    expect(buildMessageKeyboard(undefined)).toBeUndefined()
  })

  it('builds a single url button', () => {
    const kb = buildMessageKeyboard({ title: 'Visit', kind: 'url', url: 'https://luma.app/promo' })
    expect(kb!.inline_keyboard).toEqual([[{ text: 'Visit', url: 'https://luma.app/promo' }]])
  })

  it('builds a webApp button pointing at WEB_URL?screen=<tab>', () => {
    const kb = buildMessageKeyboard({ title: 'See likes', kind: 'screen', screen: 'likes' })
    expect(kb!.inline_keyboard).toEqual([[
      { text: 'See likes', web_app: { url: 'https://app.example.com?screen=likes' } },
    ]])
  })
})
