import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { ICEBREAKER_PROMPTS, icebreakerIndex, icebreakerQuestion } from '../src/icebreakers/catalog.js'
import { seedIcebreakers } from '../src/icebreakers/seed.js'
import { resetDb, createUser, createMatch, sql } from './helpers/db.js'

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

const NOW = new Date('2026-10-09T12:00:00.000Z').getTime()

const seeded = (matchId: string) => sql`
  select sender_id, type, body, icebreaker_answer, created_at from messages
  where match_id = ${matchId} order by created_at`

describe('seedIcebreakers', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    await resetDb()
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('inserts one row per user with both fields, in the given order, 1 ms apart', async () => {
    const u1 = await createUser({ icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: 'Hiking' })
    const u2 = await createUser({ icebreaker_prompt: '  My weirdest skill…  ', icebreaker_answer: '  Juggling  ' })
    const match = await createMatch(u2.id, u1.id)

    await seedIcebreakers(match.id, [u1.id, u2.id])

    expect(await seeded(match.id)).toEqual([
      {
        sender_id: u1.id, type: 'icebreaker',
        body: 'My ideal Friday…', icebreaker_answer: 'Hiking', created_at: new Date(NOW).toISOString(),
      },
      {
        sender_id: u2.id, type: 'icebreaker',
        body: 'My weirdest skill…', icebreaker_answer: 'Juggling', created_at: new Date(NOW + 1).toISOString(),
      },
    ])
  })

  it('skips users missing a prompt or an answer (null or blank)', async () => {
    const u1 = await createUser({ icebreaker_prompt: null, icebreaker_answer: 'Hiking' })
    const u2 = await createUser({ icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: '   ' })
    const u3 = await createUser({ icebreaker_prompt: 'My weirdest skill…', icebreaker_answer: 'Juggling' })
    const match = await createMatch(u1.id, u3.id)

    await seedIcebreakers(match.id, [u1.id, u2.id, u3.id])

    expect((await seeded(match.id)).map((r) => r.sender_id)).toEqual([u3.id])
  })

  it('does not insert when nobody qualifies', async () => {
    const u1 = await createUser({ icebreaker_prompt: null, icebreaker_answer: null })
    const u2 = await createUser({ icebreaker_prompt: '  ', icebreaker_answer: 'x' })
    const match = await createMatch(u1.id, u2.id)

    await seedIcebreakers(match.id, [u1.id, u2.id])

    expect(await seeded(match.id)).toEqual([])
  })

  it('swallows a users read error without inserting', async () => {
    // Malformed ids: Postgres throws 22P02 → logged, no insert.
    await expect(seedIcebreakers('match-1', ['u1', 'u2'])).resolves.toBeUndefined()
    expect((await sql`select count(*)::int as n from messages`)[0].n).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith('[icebreakers] users read failed', expect.anything())
  })

  it('swallows an insert error', async () => {
    const u1 = await createUser({ icebreaker_prompt: 'My ideal Friday…', icebreaker_answer: 'Hiking' })
    // No such match → foreign-key violation on insert.
    await expect(seedIcebreakers('00000000-0000-0000-0000-000000000000', [u1.id])).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith('[icebreakers] insert failed', expect.anything())
  })

  it('handles an empty user list without querying errors', async () => {
    await expect(seedIcebreakers('00000000-0000-0000-0000-000000000000', [])).resolves.toBeUndefined()
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
