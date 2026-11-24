import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/geo/resolveCity.js', () => ({ scheduleUserGeo: vi.fn() }))
vi.mock('../src/moderation/photoAiCheck.js', () => ({ scheduleMainPhotoCheck: vi.fn() }))

import { buildApp } from '../src/server.js'
import { resetTextCheckUsage, USER_DAILY_AI_LIMIT } from '../src/moderation/profileTextCheck.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, insertRow, sql } from './helpers/db.js'

const deepSeekReply = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))

let app: Awaited<ReturnType<typeof buildApp>>
let me: Record<string, any>
const fetchMock = vi.fn()

beforeEach(async () => {
  await resetDb()
  resetTextCheckUsage()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  app = await buildApp()
  me = await createUser({ name: 'Ali', age: 25, bio: 'old bio', location: 'Tehran' })
  authAs(me)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fetchMock.mockReset()
})

const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload: payload as any })
const userRow = async () => (await sql`select * from users where id = ${me.id}`)[0]

describe('PUT /profile/me text check', () => {
  it('422s on an AI rejection and saves nothing', async () => {
    fetchMock.mockImplementation(async (_url: string, init: any) => {
      const { text } = JSON.parse(JSON.parse(init.body).messages[1].content)
      return deepSeekReply(text === 'bad words' ? '{"approved":false,"reason":"offensive"}' : '{"approved":true,"reason":null}')
    })
    const res = await put({ name: 'Reza', bio: 'bad words', age: 30 })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'profile_text_rejected', field: 'bio', reason: 'offensive' })
    const row = await userRow()
    expect(row).toMatchObject({ name: 'Ali', bio: 'old bio', age: 25 })
  })

  it('422s on regex contact info in the icebreaker answer without calling DeepSeek', async () => {
    const res = await put({ icebreaker_answer: 'پیام بده ۰۹۱۲۳۴۵۶۷۸۹' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'profile_text_rejected', field: 'icebreaker_answer', reason: 'contact_info' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not check unchanged or empty values', async () => {
    const res = await put({ name: 'Ali', bio: ' old bio ', age: 26 })
    expect(res.statusCode).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await put({ icebreaker_answer: '   ' })).statusCode).toBe(200)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('saves an approved change', async () => {
    fetchMock.mockResolvedValue(deepSeekReply('{"approved":true,"reason":null}'))
    const res = await put({ bio: 'عاشق کوهنوردی' })
    expect(res.statusCode).toBe(200)
    expect((await userRow()).bio).toBe('عاشق کوهنوردی')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails open when DeepSeek is down', async () => {
    fetchMock.mockRejectedValue(new Error('network'))
    const res = await put({ name: 'Reza' })
    expect(res.statusCode).toBe(200)
    expect((await userRow()).name).toBe('Reza')
  })

  it('429s once the user is out of AI checks', async () => {
    for (let i = 0; i < USER_DAILY_AI_LIMIT; i++) {
      await insertRow('profile_text_checks', { user_id: me.id, field: 'bio', text: `t${i}`, approved: true, source: 'ai' })
    }
    const res = await put({ bio: 'brand new' })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'profile_text_check_limit' })
    expect((await userRow()).bio).toBe('old bio')
  })
})

describe('POST /profile/me/check-text', () => {
  const check = (payload: unknown) =>
    app.inject({ method: 'POST', url: '/profile/me/check-text', headers: AUTH, payload: payload as any })

  it('returns ok for an approved name', async () => {
    fetchMock.mockResolvedValue(deepSeekReply('{"approved":true,"reason":null}'))
    const res = await check({ field: 'name', text: 'سارا' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
  })

  it('422s with the reason for a fake name', async () => {
    fetchMock.mockResolvedValue(deepSeekReply('{"approved":false,"reason":"fake_name"}'))
    const res = await check({ field: 'name', text: 'سلام' })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'profile_text_rejected', field: 'name', reason: 'fake_name' })
  })

  it('400s on a bad body', async () => {
    expect((await check({ field: 'location', text: 'x' })).statusCode).toBe(400)
    expect((await check({ field: 'name', text: '' })).statusCode).toBe(400)
    expect((await check({})).statusCode).toBe(400)
  })
})
