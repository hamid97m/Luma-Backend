import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isMyketConfigured, verifyMyketPurchase } from '../src/payments/myket.js'
import { isBazaarConfigured, verifyBazaarPurchase, _resetBazaarTokenCache } from '../src/payments/bazaar.js'
import { StoreUnavailableError } from '../src/payments/storeTypes.js'

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubEnv('MYKET_ACCESS_TOKEN', 'myk-secret')
  vi.stubEnv('MYKET_PACKAGE_NAME', '')
  vi.stubEnv('BAZAAR_CLIENT_ID', 'cid')
  vi.stubEnv('BAZAAR_CLIENT_SECRET', 'csec')
  vi.stubEnv('BAZAAR_REFRESH_TOKEN', 'rtok')
  vi.stubEnv('BAZAAR_PACKAGE_NAME', '')
  _resetBazaarTokenCache()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('myket', () => {
  it('sends X-Access-Token to the product token URL', async () => {
    fetchMock.mockResolvedValue(json(200, { purchaseState: 0 }))
    await verifyMyketPurchase('premium_30', 'tok1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://developer.myket.ir/api/applications/com.lumi/purchases/products/premium_30/tokens/tok1')
    expect(init.headers['X-Access-Token']).toBe('myk-secret')
  })
  it('purchaseState 0 → purchased with developerPayload', async () => {
    fetchMock.mockResolvedValue(json(200, { purchaseState: 0, developerPayload: 'u-1', purchaseTime: 1492839267000 }))
    expect(await verifyMyketPurchase('s', 't')).toEqual({ status: 'purchased', payload: 'u-1', purchaseTime: 1492839267000 })
  })
  it('empty developerPayload → null', async () => {
    fetchMock.mockResolvedValue(json(200, { purchaseState: 0, developerPayload: '' }))
    expect(await verifyMyketPurchase('s', 't')).toEqual({ status: 'purchased', payload: null, purchaseTime: null })
  })
  it('404 or purchaseState 1 → invalid', async () => {
    fetchMock.mockResolvedValueOnce(json(404))
    expect(await verifyMyketPurchase('s', 't')).toEqual({ status: 'invalid' })
    fetchMock.mockResolvedValueOnce(json(200, { purchaseState: 1 }))
    expect(await verifyMyketPurchase('s', 't')).toEqual({ status: 'invalid' })
  })
  it('500 / 401 / fetch reject → StoreUnavailableError', async () => {
    fetchMock.mockResolvedValueOnce(json(500))
    await expect(verifyMyketPurchase('s', 't')).rejects.toBeInstanceOf(StoreUnavailableError)
    fetchMock.mockResolvedValueOnce(json(401))
    await expect(verifyMyketPurchase('s', 't')).rejects.toBeInstanceOf(StoreUnavailableError)
    fetchMock.mockRejectedValueOnce(new Error('boom'))
    await expect(verifyMyketPurchase('s', 't')).rejects.toBeInstanceOf(StoreUnavailableError)
  })
  it('url-encodes sku and token', async () => {
    fetchMock.mockResolvedValue(json(200, { purchaseState: 0 }))
    await verifyMyketPurchase('a/b', 'x/y')
    expect(fetchMock.mock.calls[0][0]).toContain('/products/a%2Fb/tokens/x%2Fy')
  })
  it('isMyketConfigured is false without credentials', () => {
    expect(isMyketConfigured()).toBe(true)
    vi.stubEnv('MYKET_ACCESS_TOKEN', '')
    expect(isMyketConfigured()).toBe(false)
  })
})

describe('bazaar', () => {
  const tokenRes = () => json(200, { access_token: 'acc', expires_in: 3600 })
  it('exchanges the refresh token once and caches the access token', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockImplementation(async () => json(200, { purchaseState: 0, developerPayload: 'u-1', purchaseTime: 5 }))
    expect(await verifyBazaarPurchase('sku', 'tok')).toEqual({ status: 'purchased', payload: 'u-1', purchaseTime: 5 })
    await verifyBazaarPurchase('sku', 'tok')
    const tokenCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/auth/token/'))
    expect(tokenCalls).toHaveLength(1)
    const [turl, tinit] = tokenCalls[0]
    expect(turl).toBe('https://pardakht.cafebazaar.ir/devapi/v2/auth/token/')
    expect(tinit.method).toBe('POST')
    const body = new URLSearchParams(String(tinit.body))
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'refresh_token', client_id: 'cid', client_secret: 'csec', refresh_token: 'rtok',
    })
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://pardakht.cafebazaar.ir/devapi/v2/api/validate/com.lumi/inapp/sku/purchases/tok/',
    )
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer acc')
  })
  it('401 on validate → refreshes once and retries', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(401))
      .mockResolvedValueOnce(json(200, { access_token: 'acc2', expires_in: 3600 }))
      .mockResolvedValueOnce(json(200, { purchaseState: 0 }))
    expect((await verifyBazaarPurchase('s', 't')).status).toBe('purchased')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer acc2')
  })
  it('second 401 → StoreUnavailableError', async () => {
    fetchMock
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(401))
      .mockResolvedValueOnce(tokenRes())
      .mockResolvedValueOnce(json(401))
    await expect(verifyBazaarPurchase('s', 't')).rejects.toBeInstanceOf(StoreUnavailableError)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('purchaseState 0 → purchased; 404 → invalid; purchaseState 1 → invalid', async () => {
    fetchMock.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(json(404))
    expect(await verifyBazaarPurchase('s', 't')).toEqual({ status: 'invalid' })
    fetchMock.mockResolvedValueOnce(json(200, { purchaseState: 1 }))
    expect(await verifyBazaarPurchase('s', 't')).toEqual({ status: 'invalid' })
  })
  it('token endpoint failure / 5xx / reject → StoreUnavailableError', async () => {
    fetchMock.mockResolvedValueOnce(json(400))
    await expect(verifyBazaarPurchase('s', 't')).rejects.toBeInstanceOf(StoreUnavailableError)
    fetchMock.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(json(503))
    await expect(verifyBazaarPurchase('s', 't')).rejects.toBeInstanceOf(StoreUnavailableError)
    fetchMock.mockRejectedValueOnce(new Error('net'))
    _resetBazaarTokenCache()
    await expect(verifyBazaarPurchase('s', 't')).rejects.toBeInstanceOf(StoreUnavailableError)
  })
  it('url-encodes sku and token', async () => {
    fetchMock.mockResolvedValueOnce(tokenRes()).mockResolvedValueOnce(json(200, { purchaseState: 0 }))
    await verifyBazaarPurchase('a/b', 'x/y')
    expect(String(fetchMock.mock.calls[1][0])).toContain('/inapp/a%2Fb/purchases/x%2Fy/')
  })
  it('isBazaarConfigured is false without credentials', () => {
    expect(isBazaarConfigured()).toBe(true)
    vi.stubEnv('BAZAAR_REFRESH_TOKEN', '')
    expect(isBazaarConfigured()).toBe(false)
  })
})
