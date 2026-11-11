import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendPhoto = vi.fn()
const sendMessage = vi.fn().mockResolvedValue(undefined)
const webApp = vi.fn(function (this: unknown) { return this })
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({ api: { sendPhoto, sendMessage, config: { use: vi.fn() } } })),
  InlineKeyboard: vi.fn().mockImplementation(() => ({ webApp })),
  Context: class {},
}))

import { notifyNewMessage } from '../src/bot.js'
import { fa } from '../src/i18n/fa.js'

describe('notifyNewMessage photo fallback', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.WEB_URL = 'https://luma.test'; process.env.BOT_TOKEN = 'x' })

  it('sends the photo when Telegram accepts the URL', async () => {
    sendPhoto.mockResolvedValueOnce(undefined)
    await notifyNewMessage(7, 'Sara', 'hi', 'https://p/s.jpg', 'm1', null)
    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to a text DM when Telegram cannot fetch the photo URL', async () => {
    sendPhoto.mockRejectedValueOnce(new Error("Call to 'sendPhoto' failed! (400: Bad Request: failed to get HTTP URL content)"))
    await notifyNewMessage(7, 'Sara', 'hi', 'https://p/s', 'm1', null)
    expect(sendPhoto).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][0]).toBe(7)
    expect(sendMessage.mock.calls[0][1]).toBe(fa.notify.newMessage('Sara', 'hi'))
    expect(webApp).toHaveBeenCalledWith(fa.bot.replyButton, 'https://luma.test?screen=matches&chat=m1')
  })

  it('does not fall back when the user blocked the bot (text would fail too)', async () => {
    sendPhoto.mockRejectedValueOnce(Object.assign(new Error('Forbidden: bot was blocked by the user'), { error_code: 403 }))
    await expect(notifyNewMessage(7, 'Sara', 'hi', 'https://p/s', 'm1', null)).rejects.toThrow('blocked')
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
