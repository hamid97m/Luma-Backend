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
import { fa } from '../src/i18n/fa.js'
import { en } from '../src/i18n/en.js'

describe('notifyNewLike', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.WEB_URL = 'https://luma.test'; process.env.BOT_TOKEN = 'x' })

  it('sends a text message naming the liker, never a photo (Persian when locale is null)', async () => {
    await notifyNewLike(123, 'Sara', null)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [chatId, text] = sendMessage.mock.calls[0]
    expect(chatId).toBe(123)
    expect(text).toContain('Sara')
    expect(text).toBe(fa.notify.newLike('Sara'))
    expect(sendPhoto).not.toHaveBeenCalled()
  })

  it('words the DM in the recipient\'s locale', async () => {
    await notifyNewLike(123, 'Sara', 'en')
    expect(sendMessage.mock.calls[0][1]).toBe(en.notify.newLike('Sara'))
  })
})
