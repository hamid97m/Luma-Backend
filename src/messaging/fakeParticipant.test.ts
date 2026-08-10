import { describe, it, expect } from 'vitest'
import { pickFakeSender, type FakeChatUser } from './fakeParticipant.js'

const mk = (id: string, is_seed: boolean): FakeChatUser => ({
  id, name: id, is_seed, telegram_id: is_seed ? -1 : 100,
  last_active: null, notified_offline_at: null, allows_write_to_pm: null,
})

describe('pickFakeSender', () => {
  it('picks user1 when user1 is the seed', () => {
    const r = pickFakeSender(mk('fake', true), mk('real', false))
    expect(r?.fake.id).toBe('fake')
    expect(r?.recipient.id).toBe('real')
  })

  it('picks user2 when user2 is the seed', () => {
    const r = pickFakeSender(mk('real', false), mk('fake', true))
    expect(r?.fake.id).toBe('fake')
    expect(r?.recipient.id).toBe('real')
  })

  it('returns null when neither participant is a seed', () => {
    expect(pickFakeSender(mk('a', false), mk('b', false))).toBeNull()
  })

  it('defaults to user1 as sender when both are seeds', () => {
    const r = pickFakeSender(mk('x', true), mk('y', true))
    expect(r?.fake.id).toBe('x')
    expect(r?.recipient.id).toBe('y')
  })
})
