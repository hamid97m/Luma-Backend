import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OAuth2Client } from 'google-auth-library'
import { verifyGoogleIdToken } from '../src/googleAuth.js'

const ticket = (payload: Record<string, unknown>) => ({ getPayload: () => payload }) as any

describe('verifyGoogleIdToken', () => {
  let verify: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLIENT_IDS', 'web-client.apps.googleusercontent.com, other-client')
    verify = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken') as any
  })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  it('returns the identity for a verified email, checking every configured client id', async () => {
    verify.mockResolvedValue(ticket({ sub: 'g-1', email: 'ali@gmail.com', email_verified: true, given_name: 'Ali' }))

    expect(await verifyGoogleIdToken('tok')).toEqual({ sub: 'g-1', email: 'ali@gmail.com', givenName: 'Ali' })
    expect(verify).toHaveBeenCalledWith({
      idToken: 'tok', audience: ['web-client.apps.googleusercontent.com', 'other-client'],
    })
  })

  it('returns null when email_verified is false', async () => {
    verify.mockResolvedValue(ticket({ sub: 'g-1', email: 'ali@gmail.com', email_verified: false, given_name: 'Ali' }))

    expect(await verifyGoogleIdToken('tok')).toBeNull()
  })

  it('returns null when the token does not verify', async () => {
    verify.mockRejectedValue(new Error('Wrong recipient'))

    expect(await verifyGoogleIdToken('tok')).toBeNull()
  })

  it('returns null when GOOGLE_CLIENT_IDS is not configured', async () => {
    vi.stubEnv('GOOGLE_CLIENT_IDS', '')
    verify.mockResolvedValue(ticket({ sub: 'g-1', email: 'ali@gmail.com', email_verified: true, given_name: 'Ali' }))

    expect(await verifyGoogleIdToken('tok')).toBeNull()
    expect(verify).not.toHaveBeenCalled()
  })

  it('givenName falls back to name, then the email local-part', async () => {
    verify.mockResolvedValueOnce(ticket({ sub: 'g-1', email: 'ali@gmail.com', email_verified: true, name: 'Ali R' }))
    verify.mockResolvedValueOnce(ticket({ sub: 'g-1', email: 'ali.r@gmail.com', email_verified: true }))

    expect((await verifyGoogleIdToken('tok'))?.givenName).toBe('Ali R')
    expect((await verifyGoogleIdToken('tok'))?.givenName).toBe('ali.r')
  })
})
