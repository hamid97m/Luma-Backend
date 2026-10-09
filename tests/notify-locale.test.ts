import { describe, it, expect, vi, beforeEach } from 'vitest'

const sendPhoto = vi.fn().mockResolvedValue(undefined)
const sendMessage = vi.fn().mockResolvedValue(undefined)
const webApp = vi.fn(function (this: unknown) { return this })
vi.mock('grammy', () => ({
  Bot: vi.fn().mockImplementation(() => ({ api: { sendPhoto, sendMessage } })),
  InlineKeyboard: vi.fn().mockImplementation(() => ({ webApp })),
  Context: class {},
}))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import {
  notifyMatch, notifyNewLike, notifyPaused, notifyFakePhotoWarning, notifyNewMessage, notifyTicketReply,
} from '../src/bot.js'
import { fa } from '../src/i18n/fa.js'
import { en } from '../src/i18n/en.js'
import { ar } from '../src/i18n/ar.js'

describe('notify helpers pick the recipient locale', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.WEB_URL = 'https://luma.test'; process.env.BOT_TOKEN = 'x' })

  it('notifyMatch sends each recipient their own language', async () => {
    await notifyMatch([
      { telegramId: 1, matchName: 'Sara', matchPhoto: null, locale: 'en' },
      { telegramId: 2, matchName: 'Sara', matchPhoto: null, locale: 'ar' },
      { telegramId: 3, matchName: 'Sara', matchPhoto: null, locale: null },
    ])
    const texts = sendMessage.mock.calls.map((c) => c[1])
    expect(texts).toContain(en.notify.match('Sara'))
    expect(texts).toContain(ar.notify.match('Sara'))
    expect(texts).toContain(fa.notify.match('Sara'))
  })

  it('notifyMatch asks the match question and deep-links to the chat when both are given', async () => {
    await notifyMatch([
      { telegramId: 1, matchName: 'Sara', matchPhoto: null, locale: 'en', question: 'What makes you laugh?', matchId: 'm 1' },
    ])
    expect(sendMessage.mock.calls[0][1]).toBe(en.notify.matchWithQuestion('Sara', 'What makes you laugh?'))
    expect(webApp).toHaveBeenCalledWith(en.bot.replyButton, 'https://luma.test?screen=matches&chat=m%201')
  })

  it('notifyMatch puts the question in the photo caption', async () => {
    await notifyMatch([
      { telegramId: 1, matchName: 'Sara', matchPhoto: 'https://p/s.jpg', locale: 'ar', question: 'وأنت؟', matchId: 'm1' },
    ])
    expect(sendPhoto.mock.calls[0][2].caption).toBe(ar.notify.matchWithQuestion('Sara', 'وأنت؟'))
  })

  it('notifyMatch keeps the plain caption and app button without a question or matchId', async () => {
    await notifyMatch([{ telegramId: 1, matchName: 'Sara', matchPhoto: null, locale: 'en', question: null }])
    expect(sendMessage.mock.calls[0][1]).toBe(en.notify.match('Sara'))
    expect(webApp).toHaveBeenCalledWith(en.bot.openAppButton, 'https://luma.test')
  })

  it('notifyMatch deep-links with the plain caption when there is a matchId but no question', async () => {
    await notifyMatch([{ telegramId: 1, matchName: 'Sara', matchPhoto: null, locale: null, question: null, matchId: 'm1' }])
    expect(sendMessage.mock.calls[0][1]).toBe(fa.notify.match('Sara'))
    expect(webApp).toHaveBeenCalledWith(fa.bot.replyButton, 'https://luma.test?screen=matches&chat=m1')
  })

  it('matchWithQuestion copy is exact in every locale', () => {
    expect(fa.notify.matchWithQuestion('سارا', 'س؟')).toBe('سارا لایکت کرد و ازت پرسیده:\n«س؟»\nلوما را باز کن و جوابش را بده ❤️')
    expect(en.notify.matchWithQuestion('Sara', 'Q?')).toBe('Sara liked you back and asks:\n“Q?”\nOpen Luma and answer ❤️')
    expect(ar.notify.matchWithQuestion('سارة', 'س؟')).toBe('سارة أعجب بك أيضًا ويسألك:\n«س؟»\nافتح لوما وأجب ❤️')
  })

  it('notifyNewLike with null locale falls back to Persian', async () => {
    await notifyNewLike(9, 'Sara', null)
    expect(sendMessage.mock.calls[0][1]).toBe(fa.notify.newLike('Sara'))
  })

  it('notifyNewLike in English and Arabic', async () => {
    await notifyNewLike(9, 'Sara', 'en')
    await notifyNewLike(9, 'Sara', 'ar')
    expect(sendMessage.mock.calls[0][1]).toBe(en.notify.newLike('Sara'))
    expect(sendMessage.mock.calls[1][1]).toBe(ar.notify.newLike('Sara'))
  })

  it('notifyPaused in English', async () => {
    await notifyPaused(9, 'en')
    expect(sendMessage.mock.calls[0][1]).toBe(en.notify.paused)
  })

  it('notifyFakePhotoWarning picks gender copy and falls back to Persian', async () => {
    await notifyFakePhotoWarning(9, 'en', 'woman')
    await notifyFakePhotoWarning(9, 'ar', 'man')
    await notifyFakePhotoWarning(9, null, 'man')
    expect(sendMessage.mock.calls[0][1]).toBe(en.notify.fakePhotoWarningWoman)
    expect(sendMessage.mock.calls[1][1]).toBe(ar.notify.fakePhotoWarningMan)
    expect(sendMessage.mock.calls[2][1]).toBe(fa.notify.fakePhotoWarningMan)
  })

  it('notifyNewMessage captions in the recipient locale', async () => {
    await notifyNewMessage(9, 'Sara', 'hi', null, 'm1', 'ar')
    expect(sendMessage.mock.calls[0][1]).toBe(ar.notify.newMessage('Sara', 'hi'))
    expect(sendPhoto).not.toHaveBeenCalled()
  })

  it('notifyTicketReply in English', async () => {
    await notifyTicketReply(9, 'my issue', 'the answer', 'en')
    expect(sendMessage.mock.calls[0][1]).toBe(en.support.ticketReply('my issue', 'the answer'))
  })
})

describe('/start replies in the user locale or Telegram language', () => {
  // Fresh module graph per test so getBot()/registerHandlers state and the db
  // mock shape don't leak between cases.
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); process.env.WEB_URL = 'https://luma.test'; process.env.BOT_TOKEN = 'x' })

  async function runStart(savedLocale: string | null | undefined, languageCode: string | undefined) {
    const handlers: Record<string, (ctx: any) => Promise<void>> = {}
    const commandMock = vi.fn((name: string, fn: (ctx: any) => Promise<void>) => { handlers[name] = fn })
    vi.doMock('grammy', () => ({
      Bot: vi.fn().mockImplementation(() => ({
        api: { sendPhoto, sendMessage },
        command: commandMock,
        on: vi.fn(),
      })),
      InlineKeyboard: vi.fn().mockImplementation(() => ({ webApp() { return this } })),
      Context: class {},
      webhookCallback: vi.fn(() => async () => undefined),
    }))
    const maybeSingle = vi.fn().mockResolvedValue({ data: savedLocale === undefined ? null : { locale: savedLocale } })
    const eq = vi.fn().mockReturnValue({ maybeSingle })
    const select = vi.fn().mockReturnValue({ eq })
    const update = vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({}) })
    vi.doMock('../src/db.js', () => ({ db: { from: vi.fn(() => ({ select, update })) } }))

    const { mountWebhook } = await import('../src/bot.js')
    mountWebhook({ post: vi.fn() } as any)
    const reply = vi.fn().mockResolvedValue(undefined)
    await handlers.start({ match: '', from: { id: 42, language_code: languageCode }, reply })
    return reply.mock.calls[0]
  }

  it('uses the saved locale when the user has one', async () => {
    const [text] = await runStart('en', 'fa')
    expect(text).toBe(en.bot.start)
  })

  it('maps the Telegram language_code when the user has no row', async () => {
    const [text] = await runStart(undefined, 'ar-SA')
    expect(text).toBe(ar.bot.start)
  })

  it('falls back to English for an unknown language_code with a NULL locale', async () => {
    const [text] = await runStart(null, 'de')
    expect(text).toBe(en.bot.start)
  })
})
