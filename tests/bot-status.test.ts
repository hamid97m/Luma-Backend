import { describe, it, expect, beforeEach } from 'vitest'
import { botStatusTracker, botStatusFromError, recordBotStatus } from '../src/botStatus.js'
import { resetDb, createUser, sql } from './helpers/db.js'

const statusOf = async (id: string) =>
  (await sql<{ bot_status: string | null }[]>`select bot_status from users where id = ${id}`)[0].bot_status

const settle = () => new Promise((r) => setTimeout(r, 50))

describe('bot status', () => {
  beforeEach(async () => { await resetDb() })

  it('maps 403 descriptions to statuses and ignores other errors', () => {
    expect(botStatusFromError(403, 'Forbidden: bot was blocked by the user')).toBe('blocked')
    expect(botStatusFromError(403, 'Forbidden: user is deactivated')).toBe('deactivated')
    expect(botStatusFromError(403, "Forbidden: bot can't initiate conversation with a user")).toBe('not_started')
    expect(botStatusFromError(429, 'Too Many Requests')).toBeNull()
    expect(botStatusFromError(400, 'Bad Request: chat not found')).toBeNull()
  })

  it('tracker: delivered send → active, 403 blocked → blocked; other methods untouched', async () => {
    const u = await createUser({ telegram_id: 5001 })
    const ok = async () => ({ ok: true, result: true }) as any
    const blocked = async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) as any

    await botStatusTracker(blocked, 'sendMessage', { chat_id: 5001, text: 'x' } as any)
    await settle()
    expect(await statusOf(u.id)).toBe('blocked')

    await botStatusTracker(ok, 'getMe', {} as any)
    await settle()
    expect(await statusOf(u.id)).toBe('blocked')

    await botStatusTracker(ok, 'sendPhoto', { chat_id: 5001 } as any)
    await settle()
    expect(await statusOf(u.id)).toBe('active')
  })

  it('recordBotStatus only bumps the timestamp on a change and skips seed (negative) ids', async () => {
    const u = await createUser({ telegram_id: 5002 })
    const seed = await createUser({ telegram_id: -7, is_seed: true })
    await recordBotStatus(5002, 'active')
    const [{ bot_status_at: first }] = await sql`select bot_status_at from users where id = ${u.id}`
    await recordBotStatus(5002, 'active')
    const [{ bot_status_at: second }] = await sql`select bot_status_at from users where id = ${u.id}`
    expect(second).toEqual(first)
    await recordBotStatus(-7, 'blocked')
    expect(await statusOf(seed.id)).toBeNull()
  })
})
