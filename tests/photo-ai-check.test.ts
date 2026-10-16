import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn(), notifyFakePhotoWarning: vi.fn() }))

import { db } from '../src/db.js'
import { notifyPaused } from '../src/bot.js'
import { parsePhotoVerdict, askDeepSeekPhoto, checkMainPhoto, scheduleMainPhotoCheck } from '../src/moderation/photoAiCheck.js'
import { chainable } from './admin-helpers.js'

const MAN = { gender: 'man', age: 27, is_seed: false, paused_at: null, banned_at: null, deleted_at: null }
const MAIN = { id: 'photo-1', url: 'https://cdn.example/user-1/photo-1' }
const PAUSE_ROW = { telegram_id: 100, allows_write_to_pm: true, locale: 'fa' }

let userSeq = 0
const nextUser = () => `user-${++userSeq}`

function deepSeekReply(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })
}

describe('parsePhotoVerdict', () => {
  it('accepts an approval and drops any reason', () => {
    expect(parsePhotoVerdict('{"approved":true,"reason":"ok"}')).toEqual({ approved: true, reason: null })
  })

  it('keeps a known rejection code', () => {
    expect(parsePhotoVerdict('{"approved":false,"reason":"no_face"}')).toEqual({ approved: false, reason: 'no_face' })
  })

  it('approves a rejection that names none of our rules', () => {
    expect(parsePhotoVerdict('{"approved":false,"reason":"low_quality"}')).toEqual({ approved: true, reason: null })
    expect(parsePhotoVerdict('{"approved":false,"reason":null}')).toEqual({ approved: true, reason: null })
  })

  it('throws on non-JSON or a missing verdict so nobody is paused on a bad reply', () => {
    expect(() => parsePhotoVerdict('rejected')).toThrow()
    expect(() => parsePhotoVerdict('{"reason":"no_face"}')).toThrow('photo_check_bad_reply')
    expect(() => parsePhotoVerdict('{"approved":"false"}')).toThrow('photo_check_bad_reply')
  })
})

describe('askDeepSeekPhoto', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    fetchMock.mockReset()
  })

  it('sends the image URL at low detail in a user message, JSON mode, thinking off', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '{"approved":true,"reason":null}' } }],
      usage: { prompt_tokens: 612, completion_tokens: 11 },
    })))

    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).resolves.toEqual({
      approved: true, reason: null, promptTokens: 612, completionTokens: 11,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0].role).toBe('system')
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: MAIN.url, detail: 'low' } }],
    })
  })

  it('throws on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }))
    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).rejects.toThrow('deepseek_http_503')
  })

  it('stops calling DeepSeek once the global daily limit is spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'))
    vi.stubEnv('PHOTO_CHECK_DAILY_LIMIT', '1')
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true}'))

    await askDeepSeekPhoto(nextUser(), MAIN.url)
    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).rejects.toThrow('photo_check_daily_limit')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caps one user at 10 calls a day without blocking others', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-02-01T10:00:00Z'))
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true}'))
    const churner = nextUser()

    for (let i = 0; i < 10; i++) await askDeepSeekPhoto(churner, MAIN.url)
    await expect(askDeepSeekPhoto(churner, MAIN.url)).rejects.toThrow('photo_check_daily_limit')
    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).resolves.toMatchObject({ approved: true, reason: null })
  })
})

/** Routes db.from by table; `users` and `user_photos` answers are consumed in call order. */
function mockDb({ users, mains, checked = null }: { users: unknown[]; mains: unknown[]; checked?: unknown }) {
  let usersCalls = 0
  let photoCalls = 0
  const upsert = vi.fn().mockResolvedValue({ error: null })
  const remove = vi.fn().mockResolvedValue({ error: null })
  const blob = new Blob(['img'], { type: 'image/jpeg' })
  const download = vi.fn().mockResolvedValue({ data: blob, error: null })
  const upload = vi.fn().mockResolvedValue({ error: null })
  vi.mocked(db.storage.from).mockImplementation((bucket: string) => ({ remove, download, upload, bucket } as any))
  vi.mocked(db.from).mockImplementation((table: string) => {
    if (table === 'users') return chainable({ data: users[Math.min(usersCalls++, users.length - 1)], error: null })
    if (table === 'user_photos') {
      // mainPhoto lookups first; the pause's deleteAllPhotosForUser reads the list after.
      const data = photoCalls < mains.length ? mains[photoCalls] : [{ id: MAIN.id }]
      photoCalls++
      return chainable({ data, error: null })
    }
    if (table === 'photo_ai_checks') {
      const chain = chainable({ data: checked, error: null })
      return new Proxy(chain, { get: (t, p) => (p === 'upsert' ? upsert : t[p]) })
    }
    return chainable({ data: null, error: null })
  })
  return { upsert, remove, download, upload, blob }
}

describe('checkMainPhoto', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('skips women, unfinished sign-ups, seeds and paused users without calling DeepSeek', async () => {
    const skipped = [
      { ...MAN, gender: 'woman' },
      { ...MAN, gender: 'nonbinary' },
      // every account is created as 'man' with age 0 before onboarding saves
      { ...MAN, age: 0 },
      { ...MAN, is_seed: true },
      { ...MAN, paused_at: '2026-01-01' },
      null,
    ]
    for (const user of skipped) {
      mockDb({ users: [user], mains: [MAIN] })
      expect(await checkMainPhoto(nextUser())).toBeNull()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips a main photo that was already approved', async () => {
    mockDb({ users: [MAN], mains: [MAIN], checked: { approved: true, reason: null } })
    expect(await checkMainPhoto(nextUser())).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pauses on a cached rejection without calling DeepSeek again', async () => {
    mockDb({ users: [MAN, MAN, PAUSE_ROW], mains: [MAIN, MAIN], checked: { approved: false, reason: 'nudity' } })
    expect(await checkMainPhoto(nextUser())).toEqual({ approved: false, reason: 'nudity' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(notifyPaused).toHaveBeenCalledWith(100, 'fa')
  })

  it('records an approval and does not pause', async () => {
    const user = nextUser()
    const { upsert } = mockDb({ users: [MAN], mains: [MAIN] })
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":true,"reason":null}'))

    expect(await checkMainPhoto(user)).toEqual({ approved: true, reason: null })
    expect(upsert).toHaveBeenCalledWith(
      {
        photo_id: MAIN.id, user_id: user, approved: true, reason: null,
        photo_url: MAIN.url, evidence_path: null, prompt_tokens: null, completion_tokens: null,
      },
      { onConflict: 'photo_id', ignoreDuplicates: true },
    )
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('keeps a private copy, then pauses, deletes photos and DMs on a rejection', async () => {
    const user = nextUser()
    const { upsert, remove, download, upload, blob } = mockDb({ users: [MAN, MAN, PAUSE_ROW], mains: [MAIN, MAIN] })
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":false,"reason":"celebrity_or_stock"}'))

    expect(await checkMainPhoto(user)).toEqual({ approved: false, reason: 'celebrity_or_stock' })
    const path = `${user}/${MAIN.id}`
    expect(download).toHaveBeenCalledWith(path)
    expect(upload).toHaveBeenCalledWith(path, blob, { contentType: 'image/jpeg', upsert: true })
    expect(vi.mocked(db.storage.from).mock.calls.map((c) => c[0])).toContain('photo-ai-evidence')
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ approved: false, reason: 'celebrity_or_stock', evidence_path: path }),
      expect.anything(),
    )
    // the copy must exist before the pause deletes the original
    expect(upload.mock.invocationCallOrder[0]).toBeLessThan(remove.mock.invocationCallOrder[0])
    expect(remove).toHaveBeenCalledWith([path])
    expect(notifyPaused).toHaveBeenCalledWith(100, 'fa')
  })

  it('still pauses when the evidence copy fails', async () => {
    const { upsert, download } = mockDb({ users: [MAN, MAN, PAUSE_ROW], mains: [MAIN, MAIN] })
    download.mockResolvedValueOnce({ data: null, error: { message: 'not found' } })
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":false,"reason":"no_face"}'))

    await checkMainPhoto(nextUser())
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ evidence_path: null }), expect.anything())
    expect(notifyPaused).toHaveBeenCalled()
  })

  it('does not pause when the main photo changed while DeepSeek was answering', async () => {
    mockDb({ users: [MAN, MAN, PAUSE_ROW], mains: [MAIN, { id: 'photo-2', url: 'x' }] })
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":false,"reason":"no_face"}'))

    expect(await checkMainPhoto(nextUser())).toEqual({ approved: false, reason: 'no_face' })
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('does not pause when he switched gender while DeepSeek was answering', async () => {
    mockDb({ users: [MAN, { ...MAN, gender: 'woman' }, PAUSE_ROW], mains: [MAIN, MAIN] })
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":false,"reason":"no_face"}'))

    await checkMainPhoto(nextUser())
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('makes one DeepSeek call for concurrent triggers on the same photo', async () => {
    const user = nextUser()
    mockDb({ users: [MAN], mains: [MAIN, MAIN] })
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true,"reason":null}'))

    await Promise.all([checkMainPhoto(user), checkMainPhoto(user)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('records and pauses nothing when DeepSeek fails', async () => {
    const { upsert } = mockDb({ users: [MAN], mains: [MAIN] })
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    await expect(checkMainPhoto(nextUser())).rejects.toThrow('network down')
    expect(upsert).not.toHaveBeenCalled()
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('does not call DeepSeek when the review lookup errors', async () => {
    vi.mocked(db.from).mockImplementation((table: string) => {
      if (table === 'users') return chainable({ data: MAN, error: null })
      if (table === 'user_photos') return chainable({ data: MAIN, error: null })
      return chainable({ data: null, error: { message: 'relation "photo_ai_checks" does not exist' } })
    })

    await expect(checkMainPhoto(nextUser())).rejects.toThrow('photo_check_lookup_failed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('scheduleMainPhotoCheck', () => {
  const log = { warn: vi.fn(), info: vi.fn() } as any
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => vi.unstubAllEnvs())

  it('is a no-op without DEEPSEEK_API_KEY or when switched off', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    scheduleMainPhotoCheck(nextUser(), log)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    vi.stubEnv('PHOTO_AI_CHECK', 'off')
    scheduleMainPhotoCheck(nextUser(), log)
    expect(db.from).not.toHaveBeenCalled()
  })

  it('logs instead of throwing when the check fails', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    vi.mocked(db.from).mockImplementation(() => { throw new Error('boom') })
    scheduleMainPhotoCheck(nextUser(), log)
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled())
  })
})
