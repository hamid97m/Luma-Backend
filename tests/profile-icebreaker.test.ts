import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/db.js', () => ({ db: { from: vi.fn(), storage: { from: vi.fn() } } }))
vi.mock('../src/referrals/rewards.js', () => ({ maybeQualifyReferral: vi.fn() }))
vi.mock('../src/geo/resolveCity.js', () => ({ scheduleUserGeo: vi.fn() }))

import { buildApp } from '../src/server.js'
import { verifyInitData } from '../src/auth.js'
import { db } from '../src/db.js'
import { ICEBREAKER_PROMPTS } from '../src/icebreakers/catalog.js'

const AUTH = { authorization: 'valid_init_data' }
const USER_ID = 'user-uuid-1'

function setupAuth() {
  vi.mocked(verifyInitData).mockReturnValue({ id: 1, first_name: 'Ali' } as any)
  vi.mocked(db.from).mockReturnValueOnce({
    select: () => ({ eq: () => ({ single: () => ({ data: { id: USER_ID } }) }) }),
  } as any)
}

// Captures the users.update payload; the saved row is echoed back.
function mockSave(): { updates: Record<string, unknown>[] } {
  const captured = { updates: [] as Record<string, unknown>[] }
  vi.mocked(db.from)
    .mockReturnValueOnce({
      update: (p: Record<string, unknown>) => {
        captured.updates.push(p)
        return {
          eq: () => ({
            select: () => ({
              single: () => ({ data: { id: USER_ID, age: 25, account_status: 'active', ...p }, error: null }),
            }),
          }),
        }
      },
    } as any)
    .mockReturnValueOnce({
      select: () => ({ eq: () => ({ order: () => ({ data: [], error: null }) }) }),
    } as any)
  return captured
}

async function put(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) {
  return app.inject({ method: 'PUT', url: '/profile/me', headers: AUTH, payload })
}

describe('PUT /profile/me icebreaker validation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  beforeEach(async () => {
    vi.mocked(db.from).mockReset()
    app = await buildApp()
  })

  it('accepts a catalog prompt in any locale', async () => {
    for (const prompt of [ICEBREAKER_PROMPTS.fa[3], ICEBREAKER_PROMPTS.en[0], ICEBREAKER_PROMPTS.ar[11]]) {
      setupAuth()
      const saved = mockSave()
      const res = await put(app, { icebreaker_prompt: prompt })
      expect(res.statusCode).toBe(200)
      expect(saved.updates[0].icebreaker_prompt).toBe(prompt)
    }
  })

  it('accepts a null prompt', async () => {
    setupAuth()
    const saved = mockSave()
    const res = await put(app, { icebreaker_prompt: null })
    expect(res.statusCode).toBe(200)
    expect(saved.updates[0].icebreaker_prompt).toBeNull()
  })

  it.each([
    ['a custom prompt', 'Tell me a secret…'],
    ['an empty prompt', ''],
    ['a number', 42],
    ['an object', { text: 'x' }],
  ])('rejects %s with 400 invalid_icebreaker', async (_label, prompt) => {
    setupAuth()
    const res = await put(app, { icebreaker_prompt: prompt })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_icebreaker' })
  })

  it('stores the answer trimmed', async () => {
    setupAuth()
    const saved = mockSave()
    const res = await put(app, { icebreaker_prompt: ICEBREAKER_PROMPTS.fa[0], icebreaker_answer: '  کوه و چای  ' })
    expect(res.statusCode).toBe(200)
    expect(saved.updates[0].icebreaker_answer).toBe('کوه و چای')
  })

  it('stores a whitespace-only answer as null', async () => {
    setupAuth()
    const saved = mockSave()
    const res = await put(app, { icebreaker_answer: '   ' })
    expect(res.statusCode).toBe(200)
    expect(saved.updates[0].icebreaker_answer).toBeNull()
  })

  it('accepts a null answer and a 140-char answer', async () => {
    setupAuth()
    let saved = mockSave()
    let res = await put(app, { icebreaker_answer: null })
    expect(res.statusCode).toBe(200)
    expect(saved.updates[0].icebreaker_answer).toBeNull()

    setupAuth()
    saved = mockSave()
    res = await put(app, { icebreaker_answer: ` ${'ا'.repeat(140)} ` })
    expect(res.statusCode).toBe(200)
    expect(saved.updates[0].icebreaker_answer).toBe('ا'.repeat(140))
  })

  it.each([
    ['a 141-char answer', 'x'.repeat(141)],
    ['a number', 7],
    ['an array', ['hi']],
  ])('rejects %s with 400 invalid_icebreaker', async (_label, answer) => {
    setupAuth()
    const res = await put(app, { icebreaker_answer: answer })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_icebreaker' })
  })
})
