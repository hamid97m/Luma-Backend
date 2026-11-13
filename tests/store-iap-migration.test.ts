import { describe, it, expect, beforeEach } from 'vitest'
import { sql, resetDb, createUser } from './helpers/db.js'

async function insertTx(userId: string, provider: string, token: string | null = null) {
  return sql`
    insert into premium_transactions
      (user_id, plan_title, price_stars, duration_days, provider, store_purchase_token)
    values (${userId}, 'Plan', 0, 30, ${provider}, ${token})`
}

describe('0010 store IAP (Bazaar/Myket)', () => {
  beforeEach(resetDb)

  it('accepts bazaar/myket providers and rejects unknown', async () => {
    const u = await createUser()
    await insertTx(u.id, 'myket')
    await insertTx(u.id, 'bazaar')
    await expect(insertTx(u.id, 'zarinpal')).rejects.toThrow()
  })

  it('rejects the same purchase token twice for one provider but allows it across providers', async () => {
    const u = await createUser()
    await insertTx(u.id, 'myket', 'tok-1')
    await expect(insertTx(u.id, 'myket', 'tok-1')).rejects.toThrow()
    await insertTx(u.id, 'bazaar', 'tok-1')
    await insertTx(u.id, 'myket', null)
    await insertTx(u.id, 'myket', null)
  })

  it('keeps plan SKUs unique per store, many nulls allowed', async () => {
    await sql`insert into premium_plans (title, price_stars, duration_days, bazaar_sku) values ('A', 100, 30, 'sku.a')`
    await expect(
      sql`insert into premium_plans (title, price_stars, duration_days, bazaar_sku) values ('B', 100, 30, 'sku.a')`,
    ).rejects.toThrow()
    await sql`insert into premium_plans (title, price_stars, duration_days, myket_sku) values ('C', 100, 30, 'sku.a')`
    await sql`insert into premium_plans (title, price_stars, duration_days) values ('D', 100, 30)`
    await sql`insert into premium_plans (title, price_stars, duration_days) values ('E', 100, 30)`
  })

  it('rejects a non-positive store price', async () => {
    await expect(
      sql`insert into premium_plans (title, price_stars, duration_days, bazaar_price_toman) values ('A', 100, 30, 0)`,
    ).rejects.toThrow()
    await expect(
      sql`insert into premium_plans (title, price_stars, duration_days, myket_price_toman) values ('A', 100, 30, -5)`,
    ).rejects.toThrow()
    await sql`insert into premium_plans (title, price_stars, duration_days, myket_price_toman) values ('A', 100, 30, 150000)`
  })
})
