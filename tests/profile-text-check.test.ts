import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  regexFindsContactInfo, parseTextVerdict, checkProfileText, checkProfileTexts,
  ProfileTextLimitError, resetTextCheckUsage, USER_DAILY_AI_LIMIT, TEXT_SYSTEM_PROMPT,
} from '../src/moderation/profileTextCheck.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'

const deepSeekReply = (content: string, usage = { prompt_tokens: 300, completion_tokens: 10 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 })

describe('regexFindsContactInfo', () => {
  it.each([
    '09123456789',
    '۰۹۱۲۳۴۵۶۷۸۹',
    '0912 345 6789',
    '۰۹۱۲-۳۴۵-۶۷۸۹',
    '+98 912 345 6789',
    'زنگ بزن 912 345 67 89',
    '1234567',
    'ali@gmail.com',
    'پیام بده @ali_reza',
    '@sara.k',
    'https://example.com',
    'www.mysite.com',
    't.me/alireza',
    't . me/alireza',
    'wa.me/98912',
    'insta: ali_99',
    'Insta ali_reza',
    'id=reza1370',
    'telegram: mamad',
    'آیدی: ali_r',
    'آیدیم reza_k',
    'اینستا sara.kh',
    'اینستام ali.r',
    'تلگرام mamad99',
    'mysite.ir',
  ])('flags %s', (text) => expect(regexFindsContactInfo(text)).toBe(true))

  it.each([
    'علی',
    'Sara',
    'سلام، من ۲۵ سالمه و عاشق کوهنوردی هستم',
    'قد ۱۸۰ وزن ۷۵',
    'متولد ۱۳۷۵/۰۶/۱۲',
    '1375 06 12',
    '25 180 75',
    'اینستا دارم ولی فعال نیستم',
    'تلگرام بیشتر آنلاینم',
    'هتل Hilton کار می‌کنم',
    'عاشق فیلم و موسیقی و سفر 🌍',
    'I love hiking and coffee.',
    'Ali Reza',
    'دنبال یه رابطه جدی',
    'Kheili khoshhal misham ashna shim',
    'id nadaram',
  ])('allows %s', (text) => expect(regexFindsContactInfo(text)).toBe(false))
})

describe('parseTextVerdict', () => {
  it('approves an approved reply', () => {
    expect(parseTextVerdict('{"approved":true,"reason":null}', 'bio')).toEqual({ approved: true, reason: null })
  })
  it('rejects with a known reason', () => {
    expect(parseTextVerdict('{"approved":false,"reason":"offensive"}', 'bio')).toEqual({ approved: false, reason: 'offensive' })
  })
  it('treats an unknown reason as approved', () => {
    expect(parseTextVerdict('{"approved":false,"reason":"weird"}', 'bio')).toEqual({ approved: true, reason: null })
  })
  it('accepts fake_name only for the name field', () => {
    expect(parseTextVerdict('{"approved":false,"reason":"fake_name"}', 'name')).toEqual({ approved: false, reason: 'fake_name' })
    expect(parseTextVerdict('{"approved":false,"reason":"fake_name"}', 'bio')).toEqual({ approved: true, reason: null })
  })
  it('throws on a malformed reply', () => {
    expect(() => parseTextVerdict('not json', 'bio')).toThrow()
    expect(() => parseTextVerdict('{"reason":"offensive"}', 'bio')).toThrow()
  })
})

describe('checkProfileText', () => {
  const fetchMock = vi.fn()
  beforeEach(async () => {
    await resetDb()
    resetTextCheckUsage()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  const rows = () => sql`select field, text, approved, reason, source, prompt_tokens from profile_text_checks order by created_at`

  it('rejects contact info by regex without calling DeepSeek and logs it', async () => {
    const u = await createUser()
    expect(await checkProfileText(u.id, 'bio', 'insta: ali_99')).toEqual({ approved: false, reason: 'contact_info' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await rows()).toMatchObject([{ field: 'bio', approved: false, reason: 'contact_info', source: 'regex' }])
  })

  it('sends the text to DeepSeek and logs the verdict with tokens', async () => {
    const u = await createUser()
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":false,"reason":"fake_name"}'))
    expect(await checkProfileText(u.id, 'name', ' Admin ')).toEqual({ approved: false, reason: 'fake_name' })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({
      model: 'deepseek-flash', thinking: { type: 'disabled' }, temperature: 0,
      response_format: { type: 'json_object' },
    })
    expect(body.messages[0]).toEqual({ role: 'system', content: TEXT_SYSTEM_PROMPT })
    expect(JSON.parse(body.messages[1].content)).toEqual({ field: 'name', text: 'Admin' })
    expect(await rows()).toMatchObject([{ field: 'name', text: 'Admin', approved: false, reason: 'fake_name', source: 'ai', prompt_tokens: 300 }])
  })

  it('reuses a cached approval for the same user+field+text', async () => {
    const u = await createUser()
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true,"reason":null}'))
    await checkProfileText(u.id, 'bio', 'عاشق سفرم')
    expect(await checkProfileText(u.id, 'bio', 'عاشق سفرم')).toEqual({ approved: true, reason: null })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Another field or user is not covered by that cache.
    await checkProfileText(u.id, 'icebreaker_answer', 'عاشق سفرم')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails open on HTTP error, timeout-like rejection and bad replies (nothing logged)', async () => {
    const u = await createUser()
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }))
    expect(await checkProfileText(u.id, 'bio', 'a')).toEqual({ approved: true, reason: null })
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('timeout'), { name: 'TimeoutError' }))
    expect(await checkProfileText(u.id, 'bio', 'b')).toEqual({ approved: true, reason: null })
    fetchMock.mockResolvedValueOnce(deepSeekReply('garbage'))
    expect(await checkProfileText(u.id, 'bio', 'c')).toEqual({ approved: true, reason: null })
    expect(await rows()).toEqual([])
  })

  it('skips AI without a key or with TEXT_AI_CHECK=off, but still applies the regex', async () => {
    const u = await createUser()
    vi.stubEnv('TEXT_AI_CHECK', 'off')
    expect(await checkProfileText(u.id, 'bio', 'hello')).toEqual({ approved: true, reason: null })
    expect(await checkProfileText(u.id, 'bio', '09123456789')).toEqual({ approved: false, reason: 'contact_info' })
    vi.stubEnv('TEXT_AI_CHECK', '')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect(await checkProfileText(u.id, 'bio', 'hello')).toEqual({ approved: true, reason: null })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips seed users entirely', async () => {
    const u = await createUser({ is_seed: true })
    expect(await checkProfileText(u.id, 'bio', '09123456789')).toEqual({ approved: true, reason: null })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await rows()).toEqual([])
  })

  it('throws the per-user limit error after the daily AI cap', async () => {
    const u = await createUser()
    for (let i = 0; i < USER_DAILY_AI_LIMIT; i++) {
      await insertRow('profile_text_checks', { user_id: u.id, field: 'bio', text: `t${i}`, approved: true, source: 'ai' })
    }
    await expect(checkProfileText(u.id, 'bio', 'new text')).rejects.toBeInstanceOf(ProfileTextLimitError)
    expect(fetchMock).not.toHaveBeenCalled()
    // Yesterday's calls don't count; regex rows don't count either.
    const other = await createUser()
    await insertRow('profile_text_checks', {
      user_id: other.id, field: 'bio', text: 'x', approved: true, source: 'ai',
      created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    })
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":true,"reason":null}'))
    expect(await checkProfileText(other.id, 'bio', 'new text')).toEqual({ approved: true, reason: null })
  })

  it('fails open past the global daily cap', async () => {
    const u = await createUser()
    vi.stubEnv('TEXT_CHECK_DAILY_LIMIT', '1')
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":false,"reason":"offensive"}'))
    expect(await checkProfileText(u.id, 'bio', 'one')).toEqual({ approved: false, reason: 'offensive' })
    expect(await checkProfileText(u.id, 'bio', 'two')).toEqual({ approved: true, reason: null })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('checkProfileTexts returns the first rejected field, and 429 on the limit', async () => {
    const u = await createUser()
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true,"reason":null}'))
    expect(await checkProfileTexts(u.id, { name: 'Ali', bio: 'insta: x_y_z' })).toEqual({
      ok: false, status: 422, body: { error: 'profile_text_rejected', field: 'bio', reason: 'contact_info' },
    })
    for (let i = 0; i < USER_DAILY_AI_LIMIT; i++) {
      await insertRow('profile_text_checks', { user_id: u.id, field: 'bio', text: `t${i}`, approved: true, source: 'ai' })
    }
    expect(await checkProfileTexts(u.id, { bio: 'something new' })).toEqual({
      ok: false, status: 429, body: { error: 'profile_text_check_limit' },
    })
  })
})
