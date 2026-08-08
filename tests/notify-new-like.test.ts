import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendPhoto = vi.fn().mockResolvedValue(undefined)
const sendMessage = vi.fn().mockResolvedValue(undefined)
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({ api: { sendPhoto, sendMessage } })),
  InlineKeyboard: vi.fn().mockImplementation(() => ({ webApp() { return this } })),
  Context: class {},
}))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { notifyNewLike } from '../src/bot.js'

describe('notifyNewLike', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.WEB_URL = 'https://luma.test'; process.env.BOT_TOKEN = 'x' })

  it('sends a photo caption naming the liker when a photo is given', async () => {
    await notifyNewLike(123, 'Sara', 'https://cdn/sara.jpg')
    expect(sendPhoto).toHaveBeenCalledTimes(1)
    const [chatId, photo, opts] = sendPhoto.mock.calls[0]
    expect(chatId).toBe(123)
    expect(photo).toBe('https://cdn/sara.jpg')
    expect(opts.caption).toContain('Sara')
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to a text message naming the liker when no photo', async () => {
    await notifyNewLike(456, 'Sara', null)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendMessage.mock.calls[0]
    expect(chatId).toBe(456)
    expect(text).toContain('Sara')
    expect(sendPhoto).not.toHaveBeenCalled()
  })
})
