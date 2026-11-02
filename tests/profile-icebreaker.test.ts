import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/geo/resolveCity.js', () => ({ scheduleUserGeo: vi.fn() }))

import { buildApp } from '../src/server.js'
import { ICEBREAKER_PROMPTS } from '../src/icebreakers/catalog.js'
import { AUTH, authAs } from './helpers/auth.js'
import { resetDb, createUser, sql } from './helpers/db.js'

let me: Record<string, any>
const saved = async () =>
  (await sql`select icebreaker_prompt, icebreaker_answer from users where id = ${me.id}`)[0]

async function put(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload })
}

describe('PUT /profile/me icebreaker validation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    await resetDb()
    app = await buildApp()
    me = await createUser({ icebreaker_prompt: ICEBREAKER_PROMPTS.en[1], icebreaker_answer: 'old answer' })
    authAs(me)
  })

  it('accepts a catalog prompt in any locale', async () => {
    for (const prompt of [ICEBREAKER_PROMPTS.fa[3], ICEBREAKER_PROMPTS.en[0], ICEBREAKER_PROMPTS.ar[11]]) {
      const res = await put(app, { icebreaker_prompt: prompt })
      expect(res.statusCode).toBe(200)
      expect(res.json().icebreaker_prompt).toBe(prompt)
      expect((await saved()).icebreaker_prompt).toBe(prompt)
    }
  })

  it('accepts a null prompt', async () => {
    const res = await put(app, { icebreaker_prompt: null })
    expect(res.statusCode).toBe(200)
    expect((await saved()).icebreaker_prompt).toBeNull()
  })

  it.each([
    ['a custom prompt', 'Tell me a secret…'],
    ['an empty prompt', ''],
    ['a number', 42],
    ['an object', { text: 'x' }],
  ])('rejects %s with 400 invalid_icebreaker', async (_label, prompt) => {
    const res = await put(app, { icebreaker_prompt: prompt })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_icebreaker' })
    expect((await saved()).icebreaker_prompt).toBe(ICEBREAKER_PROMPTS.en[1])
  })

  it('stores the answer trimmed', async () => {
    const res = await put(app, { icebreaker_prompt: ICEBREAKER_PROMPTS.fa[0], icebreaker_answer: '  کوه و چای  ' })
    expect(res.statusCode).toBe(200)
    expect(await saved()).toEqual({ icebreaker_prompt: ICEBREAKER_PROMPTS.fa[0], icebreaker_answer: 'کوه و چای' })
  })

  it('stores a whitespace-only answer as null', async () => {
    const res = await put(app, { icebreaker_answer: '   ' })
    expect(res.statusCode).toBe(200)
    expect((await saved()).icebreaker_answer).toBeNull()
  })

  it('accepts a null answer and a 140-char answer', async () => {
    let res = await put(app, { icebreaker_answer: null })
    expect(res.statusCode).toBe(200)
    expect((await saved()).icebreaker_answer).toBeNull()

    res = await put(app, { icebreaker_answer: ` ${'ا'.repeat(140)} ` })
    expect(res.statusCode).toBe(200)
    expect((await saved()).icebreaker_answer).toBe('ا'.repeat(140))
  })

  it.each([
    ['a 141-char answer', 'x'.repeat(141)],
    ['a number', 7],
    ['an array', ['hi']],
  ])('rejects %s with 400 invalid_icebreaker', async (_label, answer) => {
    const res = await put(app, { icebreaker_answer: answer })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_icebreaker' })
    expect((await saved()).icebreaker_answer).toBe('old answer')
  })
})
