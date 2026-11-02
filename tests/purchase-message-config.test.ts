import { describe, it, expect, beforeEach } from 'vitest'

import { updatePurchaseMessageConfig, getPurchaseMessageConfig } from '../src/jobs/purchaseMessageConfig.js'
import { resetDb, sql } from './helpers/db.js'

const NOW = '2026-09-09T12:00:00.000Z'

const setRow = (patch: Record<string, unknown>) =>
  sql`update purchase_message_config set ${sql(patch)} where id = true`
const row = async () => (await sql`select * from purchase_message_config where id = true`)[0]

describe('updatePurchaseMessageConfig', () => {
  beforeEach(async () => { await resetDb() })

  it('stamps active_since when enabling (off → on)', async () => {
    const res = await updatePurchaseMessageConfig({ enabled: true }, undefined, NOW)
    const r = await row()
    expect(r.enabled).toBe(true)
    expect(r.active_since).toBe(NOW)
    expect(res?.activeSince).toBe(NOW)
    expect(res?.enabled).toBe(true)
  })

  it('does NOT move active_since when re-saving an already-enabled message', async () => {
    await setRow({ enabled: true, active_since: '2026-01-01T00:00:00.000Z' })
    const res = await updatePurchaseMessageConfig({ enabled: true, message: 'hi' }, undefined, NOW)
    const r = await row()
    expect(r.active_since).toBe('2026-01-01T00:00:00.000Z')
    expect(r.message).toBe('hi')
    expect(res?.activeSince).toBe('2026-01-01T00:00:00.000Z')
  })

  it('does not stamp active_since when only editing content (enabled untouched)', async () => {
    await updatePurchaseMessageConfig({ message: 'draft' }, undefined, NOW)
    const r = await row()
    expect(r.active_since).toBeNull()
    expect(r.enabled).toBe(false)
    expect(r.updated_at).toBe(NOW)
  })

  it('maps forward fields to snake_case columns', async () => {
    const res = await updatePurchaseMessageConfig(
      { kind: 'forward', message: 'https://t.me/c/1/2', sourceChatId: '-1001', sourceMessageId: 2 },
      undefined, NOW,
    )
    const r = await row()
    expect(r.kind).toBe('forward')
    expect(r.source_chat_id).toBe('-1001')
    expect(r.source_message_id).toBe(2) // bigint column comes back as a number
    expect(res).toMatchObject({ kind: 'forward', sourceChatId: '-1001', sourceMessageId: 2 })
  })

  it('writes translations and serializes them back; untouched translations keep the column default ({})', async () => {
    const translations = { en: { message: 'Come back!', buttonTitle: 'Plans' } }
    const res = await updatePurchaseMessageConfig({ translations }, undefined, NOW)
    expect((await row()).translations).toEqual(translations) // stored as a jsonb object, not a string
    expect(res?.translations).toEqual(translations)

    await resetDb()
    const res2 = await updatePurchaseMessageConfig({ message: 'hi' }, undefined, NOW)
    expect(res2?.translations).toEqual({})
  })

  it('writes and clears the jsonb button', async () => {
    const button = { kind: 'screen', screen: 'plans', title: 'طرح‌ها' } as any
    const res = await updatePurchaseMessageConfig({ button }, undefined, NOW)
    expect((await row()).button).toEqual(button)
    expect(res?.button).toEqual(button)

    const cleared = await updatePurchaseMessageConfig({ button: null }, undefined, NOW)
    expect((await row()).button).toBeNull()
    expect(cleared?.button).toBeNull()
  })
})

describe('getPurchaseMessageConfig', () => {
  beforeEach(async () => { await resetDb() })

  it('reads the singleton with defaults', async () => {
    expect(await getPurchaseMessageConfig()).toEqual({
      enabled: false, kind: 'text', message: null, sourceChatId: null, sourceMessageId: null,
      button: null, activeSince: null, translations: {},
    })
  })

  it('returns null (never throws) when the row is missing', async () => {
    await sql`delete from purchase_message_config`
    expect(await getPurchaseMessageConfig()).toBeNull()
    expect(await updatePurchaseMessageConfig({ message: 'x' }, undefined, NOW)).toBeNull()
  })
})
