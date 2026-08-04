import { describe, it, expect, beforeEach } from 'vitest'
import { signAdminToken, verifyAdminToken, hashPassword, verifyPassword } from '../src/routes/admin/auth-utils.js'

describe('admin auth utils', () => {
  beforeEach(() => { process.env.ADMIN_JWT_SECRET = 'test-secret' })

  it('signs and verifies a token roundtrip', () => {
    const token = signAdminToken({ adminId: 'a1', username: 'root' })
    expect(verifyAdminToken(token)).toMatchObject({ adminId: 'a1', username: 'root' })
  })

  it('rejects a token signed with a different secret', () => {
    const token = signAdminToken({ adminId: 'a1', username: 'root' })
    process.env.ADMIN_JWT_SECRET = 'other-secret'
    expect(verifyAdminToken(token)).toBeNull()
  })

  it('rejects garbage tokens', () => {
    expect(verifyAdminToken('not-a-jwt')).toBeNull()
  })

  it('hashes and verifies passwords', async () => {
    const hash = await hashPassword('s3cret')
    expect(hash).not.toBe('s3cret')
    expect(await verifyPassword('s3cret', hash)).toBe(true)
    expect(await verifyPassword('wrong', hash)).toBe(false)
  })
})
