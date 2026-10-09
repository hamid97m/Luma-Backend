import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))

import { db } from '../src/db.js'
import { ICEBREAKER_PROMPTS, icebreakerIndex, icebreakerQuestion } from '../src/icebreakers/catalog.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'

describe('ICEBREAKER_PROMPTS', () => {
  it('has the same 12 prompts in every locale', () => {
    expect(ICEBREAKER_PROMPTS.fa).toHaveLength(12)
    expect(ICEBREAKER_PROMPTS.en).toHaveLength(12)
    expect(ICEBREAKER_PROMPTS.ar).toHaveLength(12)
  })
})

describe('icebreakerIndex', () => {
  it('finds a prompt by the same index in fa, en and ar', () => {
    expect(icebreakerIndex('جمعه ایده‌آل من…')).toBe(0)
    expect(icebreakerIndex('My ideal Friday…')).toBe(0)
    expect(icebreakerIndex('يوم الجمعة المثالي بالنسبة لي…')).toBe(0)
    expect(icebreakerIndex(ICEBREAKER_PROMPTS.fa[11])).toBe(11)
    expect(icebreakerIndex(ICEBREAKER_PROMPTS.en[11])).toBe(11)
    expect(icebreakerIndex(ICEBREAKER_PROMPTS.ar[11])).toBe(11)
  })

  it('trims before matching', () => {
    expect(icebreakerIndex('  My weirdest skill…  ')).toBe(8)
  })

  it('returns null for an unknown, blank or missing prompt', () => {
    expect(icebreakerIndex('My perfect Sunday')).toBeNull()
    expect(icebreakerIndex('   ')).toBeNull()
    expect(icebreakerIndex('')).toBeNull()
    expect(icebreakerIndex(null)).toBeNull()
    expect(icebreakerIndex(undefined)).toBeNull()
  })
})

describe('icebreakerQuestion', () => {
  it("returns the question in the viewer's locale, whatever the prompt's language", () => {
    expect(icebreakerQuestion('جمعه ایده‌آل من…', 'en')).toBe('What does your ideal Friday look like?')
    expect(icebreakerQuestion('Two truths and a lie…', 'ar')).toBe('هل تستطيع تخمين أيّها الكذبة؟')
    expect(icebreakerQuestion('My weirdest skill…', 'fa')).toBe('عجیب‌ترین مهارت تو چیست؟')
  })

  it('falls back to the generic question for an unknown prompt', () => {
    expect(icebreakerQuestion('My perfect Sunday', 'en')).toBe('What about you?')
    expect(icebreakerQuestion('My perfect Sunday', 'ar')).toBe('وأنت؟')
    expect(icebreakerQuestion(null, 'fa')).toBe('تو چطور؟')
  })

  it('treats a null/undefined locale as Persian', () => {
    expect(icebreakerQuestion('My ideal Friday…', null)).toBe('جمعه ایده‌آل تو چه شکلی است؟')
    expect(icebreakerQuestion('My perfect Sunday', undefined)).toBe('تو چطور؟')
  })
})

type UserRow = { id: string; icebreaker_prompt: string | null; icebreaker_answer: string | null }

/** users: select().in() → rows; messages: insert(rows) → { error }. */
function mockDb(opts: { users?: UserRow[]; usersError?: boolean; insertError?: boolean }) {
  const userIn = vi.fn(() => (opts.usersError
    ? { data: null, error: { message: 'boom' } }
    : { data: opts.users ?? [], error: null }))
  const userSelect = vi.fn(() => ({ in: userIn }))
  const insert = vi.fn(() => ({ error: opts.insertError ? { message: 'insert boom' } : null }))
  vi.mocked(db.from).mockImplementation(((table: string) => {
    if (table === 'users') return { select: userSelect }
    if (table === 'messages') return { insert }
    throw new Error(`unexpected table ${table}`)
  }) as any)
  return { userSelect, userIn, insert }
}

const NOW = new Date('2026-10-09T12:00:00.000Z').getTime()

describe('seedIcebreakers', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('inserts one row per user with both fields, in the given order, 1 ms apart', async () => {
    const { userSelect, userIn, insert } = mockDb({
      users: [
        { id: 'u2', icebreaker_prompt: '  My weirdest skill…  ', icebreaker_answer: '  Juggling  ' },
        { id: 'u1', icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: 'Hiking' },
      ],
    })

    await seedIcebreakers('match-1', ['u1', 'u2'])

    expect(userSelect).toHaveBeenCalledWith('id, icebreaker_prompt, icebreaker_answer')
    expect(userIn).toHaveBeenCalledWith('id', ['u1', 'u2'])
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith([
      {
        match_id: 'match-1', sender_id: 'u1', type: 'icebreaker',
        body: 'My ideal Friday…', icebreaker_answer: 'Hiking', created_at: new Date(NOW).toISOString(),
      },
      {
        match_id: 'match-1', sender_id: 'u2', type: 'icebreaker',
        body: 'My weirdest skill…', icebreaker_answer: 'Juggling', created_at: new Date(NOW + 1).toISOString(),
      },
    ])
  })

  it('skips users missing a prompt or an answer (null or blank)', async () => {
    const { insert } = mockDb({
      users: [
        { id: 'u1', icebreaker_prompt: null, icebreaker_answer: 'Hiking' },
        { id: 'u2', icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: '   ' },
        { id: 'u3', icebreaker_prompt: 'My weirdest skill…', icebreaker_answer: 'Juggling' },
      ],
    })

    await seedIcebreakers('match-1', ['u1', 'u2', 'u3'])

    const rows = (insert.mock.calls[0] as unknown[])[0] as Array<{ sender_id: string }>
    expect(rows.map((r) => r.sender_id)).toEqual(['u3'])
  })

  it('does not insert when nobody qualifies', async () => {
    const { insert } = mockDb({
      users: [
        { id: 'u1', icebreaker_prompt: null, icebreaker_answer: null },
        { id: 'u2', icebreaker_prompt: '  ', icebreaker_answer: 'x' },
      ],
    })

    await seedIcebreakers('match-1', ['u1', 'u2'])

    expect(insert).not.toHaveBeenCalled()
  })

  it('swallows a users read error without inserting', async () => {
    const { insert } = mockDb({ usersError: true })
    await expect(seedIcebreakers('match-1', ['u1', 'u2'])).resolves.toBeUndefined()
    expect(insert).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('swallows an insert error', async () => {
    mockDb({
      users: [{ id: 'u1', icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: 'Hiking' }],
      insertError: true,
    })
    await expect(seedIcebreakers('match-1', ['u1'])).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('swallows a thrown db error', async () => {
    vi.mocked(db.from).mockImplementation(() => { throw new Error('network down') })
    await expect(seedIcebreakers('match-1', ['u1'])).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalled()
  })
})
