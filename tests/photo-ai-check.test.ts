import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/bot.js', () => ({ notifyPaused: vi.fn(), notifyFakePhotoWarning: vi.fn() }))

import { notifyPaused } from '../src/bot.js'
import { parsePhotoVerdict, askDeepSeekPhoto, checkMainPhoto, scheduleMainPhotoCheck } from '../src/moderation/photoAiCheck.js'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resetDb, createUser, createPhoto, insertRow, sql } from './helpers/db.js'
import { photoFileExists, seedPhotoFile, withMissingTable } from './helpers/profile.js'

const MAN = { gender: 'man', looking_for: 'women', age: 27, is_seed: false, telegram_id: 100, allows_write_to_pm: true, locale: 'fa' }
const MAIN = { id: 'photo-1', url: 'https://cdn.example/user-1/photo-1' }

// askDeepSeekPhoto only uses the id for its per-user budget.
const nextUser = () => randomUUID()

function deepSeekReply(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status })
}

describe('parsePhotoVerdict', () => {
  it('accepts an approval and drops any reason', () => {
    expect(parsePhotoVerdict('{"approved":true,"reason":"ok"}')).toEqual({ approved: true, reason: null })
  })

  it('keeps a known rejection code', () => {
    expect(parsePhotoVerdict('{"approved":false,"reason":"no_face"}')).toEqual({ approved: false, reason: 'no_face' })
  })

  it('approves a rejection that names none of our rules', () => {
    expect(parsePhotoVerdict('{"approved":false,"reason":"low_quality"}')).toEqual({ approved: true, reason: null })
    expect(parsePhotoVerdict('{"approved":false,"reason":null}')).toEqual({ approved: true, reason: null })
  })

  it('throws on non-JSON or a missing verdict so nobody is paused on a bad reply', () => {
    expect(() => parsePhotoVerdict('rejected')).toThrow()
    expect(() => parsePhotoVerdict('{"reason":"no_face"}')).toThrow('photo_check_bad_reply')
    expect(() => parsePhotoVerdict('{"approved":"false"}')).toThrow('photo_check_bad_reply')
  })
})

describe('askDeepSeekPhoto', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.useRealTimers()
    fetchMock.mockReset()
  })

  it('sends the image URL at low detail in a user message, JSON mode, thinking off', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '{"approved":true,"reason":null}' } }],
      usage: { prompt_tokens: 612, completion_tokens: 11 },
    })))

    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).resolves.toEqual({
      approved: true, reason: null, promptTokens: 612, completionTokens: 11,
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect(init.headers.authorization).toBe('Bearer sk-test')
    const body = JSON.parse(init.body)
    expect(body.model).toBe('deepseek-flash')
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[0].role).toBe('system')
    expect(body.messages.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: MAIN.url, detail: 'low' } }],
    })
  })

  it('throws on an HTTP error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('busy', { status: 503 }))
    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).rejects.toThrow('deepseek_http_503')
  })

  it('stops calling DeepSeek once the global daily limit is spent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'))
    vi.stubEnv('PHOTO_CHECK_DAILY_LIMIT', '1')
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true}'))

    await askDeepSeekPhoto(nextUser(), MAIN.url)
    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).rejects.toThrow('photo_check_daily_limit')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caps one user at 10 calls a day without blocking others', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2030-02-01T10:00:00Z'))
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true}'))
    const churner = nextUser()

    for (let i = 0; i < 10; i++) await askDeepSeekPhoto(churner, MAIN.url)
    await expect(askDeepSeekPhoto(churner, MAIN.url)).rejects.toThrow('photo_check_daily_limit')
    await expect(askDeepSeekPhoto(nextUser(), MAIN.url)).resolves.toMatchObject({ approved: true, reason: null })
  })
})

const MAIN_BYTES = Buffer.from('main-photo-bytes')

/** A checkable man (unless overridden) with one main photo, its file on disk
 *  unless `withFile` is false. */
async function setup(user: Record<string, unknown> = {}, withFile = true) {
  const u = await createUser({ ...MAN, ...user })
  const main = await createPhoto(u.id, 0)
  if (withFile) await seedPhotoFile(u.id, main.id, MAIN_BYTES)
  return { u, main }
}

const evidenceFile = (path: string) => join(process.env.MEDIA_DIR!, 'private', 'photo-ai-evidence', ...path.split('/'))

const checks = () => sql`select photo_id, user_id, approved, reason, photo_url, evidence_path, prompt_tokens, completion_tokens from photo_ai_checks`
const pausedAt = async (id: string) => (await sql`select paused_at from users where id = ${id}`)[0].paused_at

describe('checkMainPhoto', () => {
  const fetchMock = vi.fn()
  beforeEach(async () => {
    await resetDb()
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    fetchMock.mockReset()
  })

  it('skips women, unfinished sign-ups, seeds and paused users without calling DeepSeek', async () => {
    const skipped = [
      { gender: 'woman', looking_for: 'men' },
      { gender: 'nonbinary' },
      // every account is created as 'man' with age 0 before onboarding saves
      { age: 0 },
      { is_seed: true },
      { paused_at: '2026-01-01T00:00:00Z' },
      { banned_at: '2026-01-01T00:00:00Z' },
      { deleted_at: '2026-01-01T00:00:00Z' },
    ]
    for (const [i, user] of skipped.entries()) {
      const { u } = await setup({ telegram_id: 200 + i, ...user })
      expect(await checkMainPhoto(u.id), JSON.stringify(user)).toBeNull()
    }
    // No such user.
    expect(await checkMainPhoto(randomUUID())).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips a man without photos', async () => {
    const u = await createUser(MAN)
    expect(await checkMainPhoto(u.id)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('skips a main photo that was already approved', async () => {
    const { u, main } = await setup()
    await insertRow('photo_ai_checks', { photo_id: main.id, user_id: u.id, approved: true })
    expect(await checkMainPhoto(u.id)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('pauses on a cached rejection without calling DeepSeek again', async () => {
    const { u, main } = await setup()
    await insertRow('photo_ai_checks', { photo_id: main.id, user_id: u.id, approved: false, reason: 'nudity' })
    expect(await checkMainPhoto(u.id)).toEqual({ approved: false, reason: 'nudity' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(notifyPaused).toHaveBeenCalledWith(100, 'fa')
    expect(await pausedAt(u.id)).not.toBeNull()
  })

  it('records an approval and does not pause', async () => {
    const { u, main } = await setup()
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":true,"reason":null}'))

    expect(await checkMainPhoto(u.id)).toEqual({ approved: true, reason: null })
    expect(await checks()).toEqual([{
      photo_id: main.id, user_id: u.id, approved: true, reason: null,
      photo_url: main.url, evidence_path: null, prompt_tokens: null, completion_tokens: null,
    }])
    expect(notifyPaused).not.toHaveBeenCalled()
    expect(await pausedAt(u.id)).toBeNull()
  })

  it('keeps a private copy, then pauses, deletes photos and DMs on a rejection', async () => {
    const { u, main } = await setup()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '{"approved":false,"reason":"celebrity_or_stock"}' } }],
      usage: { prompt_tokens: 600, completion_tokens: 12 },
    })))

    expect(await checkMainPhoto(u.id)).toEqual({ approved: false, reason: 'celebrity_or_stock' })
    const path = `${u.id}/${main.id}`
    // The private copy holds the original bytes — so it was made before the
    // pause deleted the original (a later copy would have found no file).
    expect(await readFile(evidenceFile(path))).toEqual(MAIN_BYTES)
    expect(await checks()).toEqual([expect.objectContaining({
      approved: false, reason: 'celebrity_or_stock', evidence_path: path, prompt_tokens: 600, completion_tokens: 12,
    })])
    expect(photoFileExists(u.id, main.id)).toBe(false)
    expect((await sql`select count(*)::int as n from user_photos`)[0].n).toBe(0)
    expect(await pausedAt(u.id)).not.toBeNull()
    expect(notifyPaused).toHaveBeenCalledWith(100, 'fa')
  })

  it('still pauses when the evidence copy fails (source file missing)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { u } = await setup({}, false)
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":false,"reason":"no_face"}'))

    await checkMainPhoto(u.id)
    expect(await checks()).toEqual([expect.objectContaining({ evidence_path: null })])
    expect(notifyPaused).toHaveBeenCalled()
    expect(await pausedAt(u.id)).not.toBeNull()
    expect(errorSpy).toHaveBeenCalledWith('[moderation] evidence download failed:', 'empty')
    errorSpy.mockRestore()
  })

  it('still pauses when the evidence copy cannot be written', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { u, main } = await setup()
    fetchMock.mockResolvedValueOnce(deepSeekReply('{"approved":false,"reason":"no_face"}'))
    const bucketDir = join(process.env.MEDIA_DIR!, 'private', 'photo-ai-evidence')
    await mkdir(bucketDir, { recursive: true })
    await chmod(bucketDir, 0o500) // read-only: creating <userId>/ fails with EACCES
    try {
      await checkMainPhoto(u.id)
    } finally {
      await chmod(bucketDir, 0o700)
    }
    expect(await checks()).toEqual([expect.objectContaining({ evidence_path: null })])
    expect(notifyPaused).toHaveBeenCalled()
    expect(photoFileExists(u.id, main.id)).toBe(false)
    expect(errorSpy).toHaveBeenCalledWith('[moderation] evidence upload failed:', expect.any(String))
    errorSpy.mockRestore()
  })

  it('does not pause when the main photo changed while DeepSeek was answering', async () => {
    const { u, main } = await setup()
    fetchMock.mockImplementationOnce(async () => {
      // He swaps his main photo mid-review.
      await sql`update user_photos set position = 1 where id = ${main.id}`
      await createPhoto(u.id, 0)
      return deepSeekReply('{"approved":false,"reason":"no_face"}')
    })

    expect(await checkMainPhoto(u.id)).toEqual({ approved: false, reason: 'no_face' })
    expect(notifyPaused).not.toHaveBeenCalled()
    expect(await pausedAt(u.id)).toBeNull()
  })

  it('does not pause when he switched gender while DeepSeek was answering', async () => {
    const { u } = await setup()
    fetchMock.mockImplementationOnce(async () => {
      await sql`update users set gender = 'woman' where id = ${u.id}`
      return deepSeekReply('{"approved":false,"reason":"no_face"}')
    })

    await checkMainPhoto(u.id)
    expect(notifyPaused).not.toHaveBeenCalled()
    expect(await pausedAt(u.id)).toBeNull()
  })

  it('makes one DeepSeek call for concurrent triggers on the same photo', async () => {
    const { u } = await setup()
    fetchMock.mockImplementation(async () => deepSeekReply('{"approved":true,"reason":null}'))

    await Promise.all([checkMainPhoto(u.id), checkMainPhoto(u.id)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await checks()).toHaveLength(1)
  })

  it('ignores a duplicate check row (on conflict do nothing)', async () => {
    const { u, main } = await setup()
    fetchMock.mockImplementationOnce(async () => {
      // Another process recorded this photo while we waited.
      await insertRow('photo_ai_checks', { photo_id: main.id, user_id: u.id, approved: true })
      return deepSeekReply('{"approved":true,"reason":null}')
    })
    await expect(checkMainPhoto(u.id)).resolves.toEqual({ approved: true, reason: null })
    expect(await checks()).toHaveLength(1)
  })

  it('records and pauses nothing when DeepSeek fails', async () => {
    const { u } = await setup()
    fetchMock.mockRejectedValueOnce(new Error('network down'))

    await expect(checkMainPhoto(u.id)).rejects.toThrow('network down')
    expect(await checks()).toEqual([])
    expect(notifyPaused).not.toHaveBeenCalled()
  })

  it('does not call DeepSeek when the review lookup errors', async () => {
    const { u } = await setup()

    await withMissingTable('photo_ai_checks', () =>
      expect(checkMainPhoto(u.id)).rejects.toThrow('photo_check_lookup_failed'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws photo_check_user_failed when the user read errors', async () => {
    await expect(checkMainPhoto('user-1')).rejects.toThrow('photo_check_user_failed')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('scheduleMainPhotoCheck', () => {
  const log = { warn: vi.fn(), info: vi.fn() } as any
  beforeEach(async () => { await resetDb(); vi.clearAllMocks() })
  afterEach(() => vi.unstubAllEnvs())

  it('is a no-op without DEEPSEEK_API_KEY or when switched off', async () => {
    // A malformed id would make any DB read fail and log.warn — so silence proves no work ran.
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    scheduleMainPhotoCheck('user-1', log)
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    vi.stubEnv('PHOTO_AI_CHECK', 'off')
    scheduleMainPhotoCheck('user-2', log)
    await new Promise((r) => setTimeout(r, 50))
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('logs instead of throwing when the check fails', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-test')
    scheduleMainPhotoCheck('user-1', log) // malformed id → Postgres throws → logged
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalled())
  })
})
