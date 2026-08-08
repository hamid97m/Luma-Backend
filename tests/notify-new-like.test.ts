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

  it('sends a text message naming the liker, never a photo', async () => {
    await notifyNewLike(123, 'Sara')
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendMessage.mock.calls[0]
    expect(chatId).toBe(123)
    expect(text).toContain('Sara')
    expect(sendPhoto).not.toHaveBeenCalled()
  })
})
