import { describe, it, expect, beforeEach } from 'vitest'
import { sql, resetDb, createUser } from './helpers/db.js'

describe('0004 user_devices + push broadcast columns', () => {
  beforeEach(resetDb)

  it('enforces unique (user_id, device_id)', async () => {
    const u = await createUser()
    await sql`insert into user_devices (user_id, device_id, platform) values (${u.id}, 'd1', 'android')`
    await expect(
      sql`insert into user_devices (user_id, device_id, platform) values (${u.id}, 'd1', 'android')`,
    ).rejects.toThrow()
  })

  it('rejects an unknown platform', async () => {
    const u = await createUser()
    await expect(
      sql`insert into user_devices (user_id, device_id, platform) values (${u.id}, 'd1', 'ios')`,
    ).rejects.toThrow()
  })

  it('keeps a push token unique across rows but allows many null tokens', async () => {
    const a = await createUser()
    const b = await createUser()
    await sql`insert into user_devices (user_id, device_id, platform, push_token) values (${a.id}, 'd1', 'android', 'tok')`
    await expect(
      sql`insert into user_devices (user_id, device_id, platform, push_token) values (${b.id}, 'd2', 'android', 'tok')`,
    ).rejects.toThrow()
    await sql`insert into user_devices (user_id, device_id, platform) values (${a.id}, 'd3', 'android')`
    await sql`insert into user_devices (user_id, device_id, platform) values (${b.id}, 'd4', 'android')`
  })

  it('cascades device rows when the user is deleted', async () => {
    const u = await createUser()
    await sql`insert into user_devices (user_id, device_id, platform) values (${u.id}, 'd1', 'web')`
    await sql`delete from users where id = ${u.id}`
    const [{ n }] = await sql`select count(*)::int as n from user_devices where user_id = ${u.id}`
    expect(n).toBe(0)
  })

  it('accepts push broadcasts and rejects unknown channels', async () => {
    const [row] = await sql`
      insert into broadcasts (message, channel, kind, title) values ('m', 'push', 'push', 'T') returning channel, kind, title`
    expect(row).toMatchObject({ channel: 'push', kind: 'push', title: 'T' })
    const [d] = await sql`insert into broadcasts (message) values ('x') returning channel`
    expect(d.channel).toBe('bot')
    await expect(sql`insert into broadcasts (message, channel) values ('m', 'sms')`).rejects.toThrow()
  })
})
