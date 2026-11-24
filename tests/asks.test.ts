import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))
vi.mock('../src/asks/notify.js', () => ({
  notifyAskMember: vi.fn().mockResolvedValue(true),
  notifyAskAnswered: vi.fn().mockResolvedValue(true),
  notifyAskRemind: vi.fn().mockResolvedValue(true),
  notifyAskNudge: vi.fn().mockResolvedValue(true),
}))
vi.mock('../src/icebreakers/seed.js', () => ({ seedIcebreakers: vi.fn().mockResolvedValue(undefined) }))

import { verifyInitData } from '../src/auth.js'
import { buildApp } from '../src/server.js'
import { signIn } from '../src/accounts.js'
import { runAskJob } from '../src/asks/job.js'
import { hashAskToken } from '../src/asks/tokens.js'
import { notifyAskMember, notifyAskAnswered, notifyAskRemind, notifyAskNudge } from '../src/asks/notify.js'
import { resetDb, sql, createMatch } from './helpers/db.js'
import * as storage from '../src/storage.js'
import { createProfile, block } from './helpers/discovery.js'

type App = Awaited<ReturnType<typeof buildApp>>
let app: App

// Each test Telegram account authenticates with header `tg:<id>`.
const tgNames = new Map<number, string>()
const H = (tgId: number) => ({ authorization: `tg:${tgId}` })
function tgAccount(id: number, firstName = 'Maryam') {
  tgNames.set(id, firstName)
  return id
}
const asUser = (u: { telegram_id: number; name?: string }) => {
  tgNames.set(u.telegram_id, u.name ?? 'Test')
  return H(u.telegram_id)
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

let sara: Record<string, any> // requester
let amir: Record<string, any> // target
let negar: Record<string, any> // member friend (joined from Sara's invite)

beforeEach(async () => {
  await resetDb()
  vi.mocked(verifyInitData).mockImplementation((h: string) => {
    const m = /^tg:(\d+)$/.exec(h)
    if (!m) return null
    const id = Number(m[1])
    return { id, first_name: tgNames.get(id) ?? 'TG' } as any
  })
  app = await buildApp()
  sara = await createProfile({ name: 'Sara', gender: 'woman', looking_for: 'men' })
  amir = await createProfile(
    { name: 'Amir', gender: 'man', looking_for: 'women', bio: 'Hiker', interests: ['music'], location: 'Tehran', username: 'amir_secret' },
    2,
  )
  negar = await createProfile({ name: 'Negar', gender: 'woman', looking_for: 'men', invited_by: sara.id })
})

afterEach(() => {
  delete process.env.ASK_FRIEND_PERCENT
})

const create = (payload: Record<string, unknown>, who = sara) =>
  app.inject({ method: 'POST', url: '/asks', headers: asUser(who), payload })

async function createWithLink(linkCount = 1, memberIds: string[] = []) {
  const res = await create({ targetId: amir.id, question: 'reply', memberIds, linkCount })
  expect(res.statusCode).toBe(200)
  const body = res.json()
  const tokens = (body.links as string[]).map((l) => l.split('startapp=ask_')[1])
  return { ask: body.ask, links: body.links as string[], tokens }
}

const openLink = (token: string, tgId?: number) =>
  app.inject({ method: 'GET', url: `/asks/link/${token}`, headers: tgId ? H(tgId) : {} })
const declare = (token: string, tgId: number, gender: string) =>
  app.inject({ method: 'POST', url: `/asks/link/${token}/gender`, headers: H(tgId), payload: { gender } })
const answerLink = (token: string, tgId: number, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/asks/link/${token}/answer`, headers: H(tgId), payload })

describe('GET /asks/config', () => {
  it('enabled for a woman, not for a man', async () => {
    expect((await app.inject({ method: 'GET', url: '/asks/config', headers: asUser(sara) })).json()).toEqual({ enabled: true })
    expect((await app.inject({ method: 'GET', url: '/asks/config', headers: asUser(amir) })).json()).toEqual({ enabled: false })
  })

  it('off when the rollout is 0%', async () => {
    process.env.ASK_FRIEND_PERCENT = '0'
    expect((await app.inject({ method: 'GET', url: '/asks/config', headers: asUser(sara) })).json()).toEqual({ enabled: false })
  })
})

describe('GET /asks/friends', () => {
  it('lists women who joined from her link or exchanged an ask, not men', async () => {
    await createProfile({ name: 'Ali', gender: 'man', invited_by: sara.id })
    const res = await app.inject({ method: 'GET', url: '/asks/friends', headers: asUser(sara) })
    expect(res.json().friends).toMatchObject([{ id: negar.id, name: 'Negar' }])
    expect(res.json().friends[0].photoUrl).toContain(negar.id)
  })
})

describe('POST /asks — create rules', () => {
  it('a man cannot ask', async () => {
    const res = await create({ targetId: sara.id, question: 'reply', linkCount: 1 }, amir)
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'not_allowed' })
  })

  it('needs 1-3 recipients and a known question', async () => {
    expect((await create({ targetId: amir.id, question: 'reply', memberIds: [], linkCount: 0 })).statusCode).toBe(400)
    expect((await create({ targetId: amir.id, question: 'reply', memberIds: [negar.id], linkCount: 3 })).statusCode).toBe(400)
    expect((await create({ targetId: amir.id, question: 'hot', linkCount: 1 })).statusCode).toBe(400)
  })

  it('rejects a member who is not in her friends list', async () => {
    const stranger = await createProfile({ name: 'Stranger', gender: 'woman' })
    const res = await create({ targetId: amir.id, question: 'reply', memberIds: [stranger.id], linkCount: 0 })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_member' })
  })

  it('rejects a target blocked either way', async () => {
    await block(amir, sara)
    const res = await create({ targetId: amir.id, question: 'reply', linkCount: 1 })
    expect(res.json()).toEqual({ error: 'invalid_target' })
  })

  it('returns the raw link once and stores only its hash; DMs the member friend', async () => {
    const { ask, links, tokens } = await createWithLink(1, [negar.id])
    expect(ask).toMatchObject({ targetId: amir.id, targetName: 'Amir', question: 'reply', status: 'open', total: 2, answered: 0 })
    expect(links[0]).toMatch(/startapp=ask_[A-Za-z0-9_-]{22}$/)
    const rows = await sql`select kind, recipient_id, token_hash from ask_recipients order by kind`
    expect(rows.find((r) => r.kind === 'link')!.token_hash).toEqual(hashAskToken(tokens[0]))
    expect(rows.find((r) => r.kind === 'member')!.recipient_id).toBe(negar.id)
    await vi.waitFor(() => expect(notifyAskMember).toHaveBeenCalledTimes(1))
    expect(vi.mocked(notifyAskMember).mock.calls[0][1]).toBe('Sara')
  })

  it('a second ask on the same target while one is open → 409 ask_exists with its id', async () => {
    const { ask } = await createWithLink()
    const res = await create({ targetId: amir.id, question: 'date', linkCount: 1 })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'ask_exists', askId: ask.id })
  })

  it('max 3 recipients per target overall, across asks', async () => {
    await createWithLink(2)
    await sql`update ask_requests set status = 'expired', closed_at = now()`
    const res = await create({ targetId: amir.id, question: 'reply', linkCount: 2 })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toMatchObject({ error: 'ask_limit' })
  })

  it('max 5 open asks at once', async () => {
    for (let i = 0; i < 5; i++) {
      const t = await createProfile({ gender: 'man', looking_for: 'women' })
      expect((await create({ targetId: t.id, question: 'reply', linkCount: 1 })).statusCode).toBe(200)
    }
    const res = await create({ targetId: amir.id, question: 'reply', linkCount: 1 })
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'ask_limit', reason: 'open' })
  })

  it('max 10 created per 24h', async () => {
    for (let i = 0; i < 10; i++) {
      const t = await createProfile({ gender: 'man', looking_for: 'women' })
      await sql`insert into ask_requests (requester_id, target_id, question, status, expires_at, closed_at)
                values (${sara.id}, ${t.id}, 'reply', 'closed', now(), now())`
    }
    const res = await create({ targetId: amir.id, question: 'reply', linkCount: 1 })
    expect(res.json()).toEqual({ error: 'ask_limit', reason: 'daily' })
  })
})

describe('link: landing, claim, lock', () => {
  it('no auth → landing with requester name and question only', async () => {
    const { tokens } = await createWithLink()
    const res = await openLink(tokens[0])
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ state: 'landing', requesterName: 'Sara', question: 'reply' })
  })

  it('unknown token → invalid', async () => {
    expect((await openLink('AAAAAAAAAAAAAAAAAAAAAA')).json()).toEqual({ state: 'invalid' })
  })

  it('non-member claims, declares female, sees the profile without identifying fields', async () => {
    const { tokens } = await createWithLink()
    const maryam = tgAccount(555_001, 'Maryam')
    const first = await openLink(tokens[0], maryam)
    expect(first.json()).toEqual({ state: 'need_gender', requesterName: 'Sara', question: 'reply' })

    const res = await declare(tokens[0], maryam, 'female')
    const body = res.json()
    expect(body.state).toBe('ready')
    expect(body.view).toMatchObject({
      requesterName: 'Sara', question: 'reply', status: 'open',
      profile: { name: 'Amir', age: 28, location: 'Tehran', bio: 'Hiker', interests: ['music'] },
      myAnswer: null,
      isMember: false,
    })
    expect(body.view.profile.photos).toHaveLength(2)
    expect(body.view.watermark).toHaveLength(6)
    const text = JSON.stringify(body)
    expect(Object.keys(body.view.profile).sort()).toEqual(['age', 'bio', 'interests', 'location', 'name', 'photos'])
    expect(text).not.toContain(amir.id)
    expect(text).not.toContain('amir_secret')
    expect(text).not.toContain(String(amir.telegram_id))

    const [rec] = await sql`select advisor_tg_id, advisor_name, advisor_gender, seen_at from ask_recipients`
    expect(rec).toMatchObject({ advisor_tg_id: maryam, advisor_name: 'Maryam', advisor_gender: 'female' })
    expect(rec.seen_at).not.toBeNull()
    expect(await sql`select tag, telegram_id, existing_user from join_tag_starts`).toEqual([
      { tag: 'friend_ask', telegram_id: maryam, existing_user: false },
    ])
  })

  it('a second Telegram account gets taken and the open is recorded', async () => {
    const { tokens } = await createWithLink()
    await openLink(tokens[0], tgAccount(555_001))
    const res = await openLink(tokens[0], tgAccount(555_002))
    expect(res.json()).toEqual({ state: 'taken' })
    const [rec] = await sql`select advisor_tg_id, foreign_open_at from ask_recipients`
    expect(rec.advisor_tg_id).toBe(555_001)
    expect(rec.foreign_open_at).not.toBeNull()
    // The original account still gets in.
    expect((await openLink(tokens[0], 555_001)).json().state).toBe('need_gender')
  })

  it('declaring male releases the claim; he stays out, the friend gets in', async () => {
    const { tokens } = await createWithLink()
    const reza = tgAccount(555_006, 'Reza')
    expect((await openLink(tokens[0], reza)).json().state).toBe('need_gender')
    expect((await declare(tokens[0], reza, 'male')).json()).toEqual({ state: 'not_for_you' })
    const [rec] = await sql`select advisor_tg_id, advisor_name, advisor_gender, recipient_id from ask_recipients`
    expect(rec).toEqual({ advisor_tg_id: null, advisor_name: null, advisor_gender: null, recipient_id: null })

    // Re-opening: still not_for_you, no claim.
    expect((await openLink(tokens[0], reza)).json()).toEqual({ state: 'not_for_you' })
    expect((await sql`select advisor_tg_id from ask_recipients`)[0].advisor_tg_id).toBeNull()

    const maryam = tgAccount(555_007, 'Maryam')
    expect((await declare(tokens[0], maryam, 'female')).json().state).toBe('ready')
    // And now he isn't told it's taken either.
    expect((await openLink(tokens[0], reza)).json()).toEqual({ state: 'not_for_you' })
    expect((await sql`select foreign_open_at from ask_recipients`)[0].foreign_open_at).toBeNull()
  })

  it('a self-declared man sees not_for_you and nothing else', async () => {
    const { tokens } = await createWithLink()
    const res = await declare(tokens[0], tgAccount(555_003, 'Reza'), 'male')
    expect(res.json()).toEqual({ state: 'not_for_you' })
    // Cannot flip to female afterwards.
    expect((await declare(tokens[0], 555_003, 'female')).json()).toEqual({ state: 'not_for_you' })
  })

  it('a male member sees not_for_you (his users.gender decides, no prompt)', async () => {
    const { tokens } = await createWithLink()
    const ali = await createProfile({ name: 'Ali', gender: 'man', looking_for: 'women' })
    expect((await openLink(tokens[0], ali.telegram_id)).json()).toEqual({ state: 'not_for_you' })
    // He never claims it: the real friend can still open it.
    expect((await sql`select advisor_tg_id from ask_recipients`)[0].advisor_tg_id).toBeNull()
    expect((await openLink(tokens[0], tgAccount(555_005))).json().state).toBe('need_gender')
  })

  it('a female member goes straight to ready', async () => {
    const { tokens } = await createWithLink()
    const res = await openLink(tokens[0], negar.telegram_id)
    expect(res.json().state).toBe('ready')
    expect(res.json().view.isMember).toBe(true)
    const [rec] = await sql`select recipient_id from ask_recipients`
    expect(rec.recipient_id).toBe(negar.id)
  })

  it('the requester opening her own link does not claim it', async () => {
    const { tokens } = await createWithLink()
    expect((await openLink(tokens[0], sara.telegram_id)).json()).toEqual({ state: 'not_for_you' })
    const [rec] = await sql`select advisor_tg_id from ask_recipients`
    expect(rec.advisor_tg_id).toBeNull()
  })

  it('a recipient blocked with the target sees closed', async () => {
    const { tokens } = await createWithLink()
    await block(amir, negar)
    expect((await openLink(tokens[0], negar.telegram_id)).json()).toEqual({ state: 'closed' })
  })

  it('invalid initData → 401', async () => {
    const { tokens } = await createWithLink()
    const res = await app.inject({ method: 'GET', url: `/asks/link/${tokens[0]}`, headers: { authorization: 'garbage' } })
    expect(res.statusCode).toBe(401)
  })
})

describe('link by recipient id (r_<id>, remind button)', () => {
  async function claimed() {
    const { tokens } = await createWithLink()
    const m = tgAccount(555_040, 'Maryam')
    await declare(tokens[0], m, 'female')
    const [rec] = await sql`select id from ask_recipients`
    return { m, ref: `r_${rec.id}` }
  }

  it('the claiming account reopens, declares and answers by r_<id>', async () => {
    const { m, ref } = await claimed()
    const res = await openLink(ref, m)
    expect(res.json()).toMatchObject({ state: 'ready', view: { profile: { name: 'Amir' }, isMember: false } })
    expect((await answerLink(ref, m, { verdict: 'unsure' })).json()).toEqual({ ok: true })
    expect((await sql`select verdict from ask_recipients`)[0].verdict).toBe('unsure')
  })

  it('another Telegram account gets invalid; nothing is recorded', async () => {
    const { ref } = await claimed()
    expect((await openLink(ref, tgAccount(555_041))).json()).toEqual({ state: 'invalid' })
    expect((await declare(ref, 555_041, 'female')).json()).toEqual({ state: 'invalid' })
    expect((await answerLink(ref, 555_041, { verdict: 'yes' })).statusCode).toBe(404)
    const [rec] = await sql`select advisor_tg_id, foreign_open_at, verdict from ask_recipients`
    expect(rec).toEqual({ advisor_tg_id: 555_040, foreign_open_at: null, verdict: null })
  })

  it('anonymous → invalid; an unclaimed link never resolves by id', async () => {
    const { ref } = await claimed()
    expect((await openLink(ref)).json()).toEqual({ state: 'invalid' })
    await createProfile({ gender: 'man', looking_for: 'women' }).then(async (t) => {
      const r = await create({ targetId: t.id, question: 'date', linkCount: 1 })
      const [un] = await sql`select ar.id from ask_recipients ar where ar.request_id = ${r.json().ask.id}`
      expect((await openLink(`r_${un.id}`, tgAccount(555_042))).json()).toEqual({ state: 'invalid' })
      expect((await sql`select advisor_tg_id from ask_recipients where id = ${un.id}`)[0].advisor_tg_id).toBeNull()
    })
  })

  it('the link advisor remind DM opens screen=ask_link', async () => {
    const { m, ref } = await claimed()
    const [{ request_id }] = await sql`select request_id from ask_recipients`
    await sql`update ask_requests set created_at = ${hoursAgo(13)}`
    const res = await app.inject({ method: 'POST', url: `/asks/${request_id}/remind/${ref.slice(2)}`, headers: asUser(sara) })
    expect(res.json()).toEqual({ ok: true })
    expect(notifyAskRemind).toHaveBeenCalledWith({ telegram_id: m, allows_write_to_pm: null, locale: null }, 'Sara', ref.slice(2), 'ask_link')
  })
})

describe('photo proxy', () => {
  const path = (url: string) => new URL(url).pathname + new URL(url).search

  async function readyView() {
    await storage.upload('profile-photos', `${amir.id}/0.jpg`, Buffer.from('JPEGDATA'))
    const { tokens } = await createWithLink()
    const m = tgAccount(555_050, 'Maryam')
    const body = (await declare(tokens[0], m, 'female')).json()
    return { view: body.view, tokens }
  }

  it('serves the target photo by signed URL; the URL carries no target id', async () => {
    const { view } = await readyView()
    const url = view.profile.photos[0] as string
    expect(url).toMatch(/\/asks\/photo\/[0-9a-f-]{36}\/0\?exp=\d+&sig=/)
    expect(url).not.toContain(amir.id)
    const res = await app.inject({ method: 'GET', url: path(url) })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('JPEGDATA')
    expect(res.headers['cache-control']).toBe('private, max-age=3600')
    expect(res.headers['content-type']).toBe('image/jpeg')
  })

  it('404 for a bad signature, a missing file, or once the ask is closed', async () => {
    const { view } = await readyView()
    const url = path(view.profile.photos[0])
    expect((await app.inject({ method: 'GET', url: url.replace(/sig=.*/, 'sig=AAAA') })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: path(view.profile.photos[1]) })).statusCode).toBe(404) // no file on disk
    await sql`update ask_requests set status = 'closed', closed_at = now()`
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404)
  })

  it('404 for an unclaimed link even with a valid signature', async () => {
    await storage.upload('profile-photos', `${amir.id}/0.jpg`, Buffer.from('JPEGDATA'))
    await createWithLink()
    const [rec] = await sql`select id from ask_recipients`
    const { askPhotoUrl } = await import('../src/asks/photoUrl.js')
    expect((await app.inject({ method: 'GET', url: path(askPhotoUrl(rec.id, 0)) })).statusCode).toBe(404)
  })
})

describe('known gender from an existing users row', () => {
  it('a soft-deleted man cannot self-declare and never claims', async () => {
    const { tokens } = await createWithLink()
    const gone = await createProfile({ gender: 'man', looking_for: 'women', age: 0, deleted_at: new Date().toISOString() })
    expect((await declare(tokens[0], gone.telegram_id, 'female')).json()).toEqual({ state: 'not_for_you' })
    expect((await sql`select advisor_tg_id from ask_recipients`)[0].advisor_tg_id).toBeNull()
  })

  it('a soft-deleted woman goes straight to ready', async () => {
    const { tokens } = await createWithLink()
    const gone = await createProfile({ gender: 'woman', age: 0, deleted_at: new Date().toISOString() })
    const res = (await openLink(tokens[0], gone.telegram_id)).json()
    expect(res.state).toBe('ready')
    expect(res.view.isMember).toBe(false)
  })
})

describe('answers', () => {
  it('link answer, edit within 10 min, locked after', async () => {
    const { ask, tokens } = await createWithLink()
    const m = tgAccount(555_010, 'Maryam')
    await declare(tokens[0], m, 'female')
    const res = await answerLink(tokens[0], m, { verdict: 'yes', note: '  looks kind ' })
    expect(res.json()).toEqual({ ok: true })
    await vi.waitFor(() => expect(notifyAskAnswered).toHaveBeenCalledTimes(1))
    expect(vi.mocked(notifyAskAnswered).mock.calls[0].slice(1)).toEqual(['Maryam', ask.id])

    expect((await answerLink(tokens[0], m, { verdict: 'no' })).statusCode).toBe(200)
    const [rec] = await sql`select verdict, note from ask_recipients`
    expect(rec).toEqual({ verdict: 'no', note: null })

    await sql`update ask_recipients set answered_at = ${minutesAgo(11)}`
    const locked = await answerLink(tokens[0], m, { verdict: 'yes' })
    expect(locked.statusCode).toBe(409)
    expect(locked.json()).toEqual({ error: 'answer_locked' })
  })

  it('rejects a bad verdict or a note over 300 chars', async () => {
    const { tokens } = await createWithLink()
    const m = tgAccount(555_011)
    await declare(tokens[0], m, 'female')
    expect((await answerLink(tokens[0], m, { verdict: 'maybe' })).statusCode).toBe(400)
    expect((await answerLink(tokens[0], m, { verdict: 'yes', note: 'x'.repeat(301) })).statusCode).toBe(400)
  })

  it('member answers via /asks/for-me; requester notified at most once an hour', async () => {
    const lina = await createProfile({ name: 'Lina', gender: 'woman', invited_by: sara.id })
    const { ask } = await createWithLink(0, [negar.id, lina.id])
    const recs = await sql`select id, recipient_id from ask_recipients`
    const negarRec = recs.find((r) => r.recipient_id === negar.id)!
    const linaRec = recs.find((r) => r.recipient_id === lina.id)!

    const view = await app.inject({ method: 'GET', url: `/asks/for-me/${negarRec.id}`, headers: asUser(negar) })
    expect(view.json()).toMatchObject({ recipientId: negarRec.id, requesterName: 'Sara', profile: { name: 'Amir' } })

    // Someone else's recipient row → 404.
    expect((await app.inject({ method: 'GET', url: `/asks/for-me/${negarRec.id}`, headers: asUser(lina) })).statusCode).toBe(404)

    await app.inject({ method: 'POST', url: `/asks/for-me/${negarRec.id}/answer`, headers: asUser(negar), payload: { verdict: 'yes' } })
    await app.inject({ method: 'POST', url: `/asks/for-me/${linaRec.id}/answer`, headers: asUser(lina), payload: { verdict: 'unsure' } })
    await vi.waitFor(async () => {
      const [r] = await sql`select last_answer_notified_at from ask_requests`
      expect(r.last_answer_notified_at).not.toBeNull()
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(notifyAskAnswered).toHaveBeenCalledTimes(1)

    const detail = await app.inject({ method: 'GET', url: `/asks/${ask.id}`, headers: asUser(sara) })
    expect(detail.json()).toMatchObject({ total: 2, answered: 2, yes: 1, unsure: 1, no: 0, target: { id: amir.id, name: 'Amir' } })
    expect(detail.json().recipients.map((r: any) => [r.displayName, r.status, r.verdict])).toEqual(
      expect.arrayContaining([['Negar', 'answered', 'yes'], ['Lina', 'answered', 'unsure']]),
    )
    // Not hers → 404.
    expect((await app.inject({ method: 'GET', url: `/asks/${ask.id}`, headers: asUser(negar) })).statusCode).toBe(404)
  })

  it('closed ask → 409 ask_closed, and the member view carries no profile', async () => {
    await createWithLink(0, [negar.id])
    const [rec] = await sql`select id from ask_recipients`
    await sql`update ask_requests set expires_at = now() - interval '1 minute'`
    const view = await app.inject({ method: 'GET', url: `/asks/for-me/${rec.id}`, headers: asUser(negar) })
    expect(view.json()).toMatchObject({ status: 'expired', requesterName: '', profile: { name: '', photos: [] } })
    const res = await app.inject({ method: 'POST', url: `/asks/for-me/${rec.id}/answer`, headers: asUser(negar), payload: { verdict: 'yes' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'ask_closed' })
  })
})

describe('closing', () => {
  it('her swipe on the target closes the ask; recipients then see closed', async () => {
    const { ask, tokens } = await createWithLink()
    const res = await app.inject({ method: 'POST', url: '/swipes', headers: asUser(sara), payload: { targetUserId: amir.id, direction: 'pass' } })
    expect(res.statusCode).toBe(200)
    const [r] = await sql`select status, closed_reason from ask_requests where id = ${ask.id}`
    expect(r).toEqual({ status: 'closed', closed_reason: 'passed' })
    expect((await openLink(tokens[0])).json()).toEqual({ state: 'closed' })
  })

  it('a block between requester and target closes it', async () => {
    const { ask } = await createWithLink()
    await app.inject({ method: 'POST', url: '/block', headers: asUser(sara), payload: { userId: amir.id } })
    const [r] = await sql`select status, closed_reason from ask_requests where id = ${ask.id}`
    expect(r).toEqual({ status: 'closed', closed_reason: 'blocked' })
  })

  it('the target deleting their account purges asks about them', async () => {
    await createWithLink()
    const res = await app.inject({ method: 'DELETE', url: '/profile/me', headers: asUser(amir), payload: {} })
    expect(res.statusCode).toBe(200)
    expect(await sql`select id from ask_requests`).toHaveLength(0)
  })
})

describe('closing on chat', () => {
  it('her message to the target closes the ask (messaged)', async () => {
    const { ask } = await createWithLink()
    const match = await createMatch(sara.id, amir.id)
    const res = await app.inject({ method: 'POST', url: `/matches/${match.id}/messages`, headers: asUser(sara), payload: { body: 'hi' } })
    expect(res.statusCode).toBe(200)
    expect((await sql`select status, closed_reason from ask_requests where id = ${ask.id}`)[0]).toEqual({ status: 'closed', closed_reason: 'messaged' })
  })

  it('starting a direct chat with the target closes it', async () => {
    const { ask } = await createWithLink()
    const res = await app.inject({ method: 'POST', url: '/discovery/direct-chat', headers: asUser(sara), payload: { targetUserId: amir.id } })
    expect(res.statusCode).toBe(200)
    expect((await sql`select status, closed_reason from ask_requests where id = ${ask.id}`)[0]).toEqual({ status: 'closed', closed_reason: 'messaged' })
  })
})

describe('discovery & coming back to an asked profile', () => {
  it('a profile she sent to friends leaves her feed while the ask is open; the target never sees asks', async () => {
    const before = await app.inject({ method: 'GET', url: '/discovery', headers: asUser(sara) })
    expect(before.json().profiles.some((p: any) => p.id === amir.id)).toBe(true)
    await createWithLink(2)
    const res = await app.inject({ method: 'GET', url: '/discovery', headers: asUser(sara) })
    expect(res.json().profiles.some((p: any) => p.id === amir.id)).toBe(false)

    const his = await app.inject({ method: 'GET', url: '/discovery', headers: asUser(amir) })
    expect(JSON.stringify(his.json())).not.toContain('"ask"')
  })

  it('GET /asks/:id/profile returns the card with her ask; 404 for others or after she decides', async () => {
    const { ask } = await createWithLink(2)
    const res = await app.inject({ method: 'GET', url: `/asks/${ask.id}/profile`, headers: asUser(sara) })
    expect(res.statusCode).toBe(200)
    const p = res.json().profile
    expect(p).toMatchObject({ id: amir.id, name: 'Amir', bio: 'Hiker', interests: ['music'] })
    expect(p.photos.length).toBe(2)
    expect(p.ask).toEqual({ id: ask.id, status: 'open', answered: 0, total: 2, yes: 0, question: 'reply' })
    expect(JSON.stringify(p)).not.toContain('amir_secret')

    const other = await app.inject({ method: 'GET', url: `/asks/${ask.id}/profile`, headers: asUser(negar) })
    expect(other.statusCode).toBe(404)

    await app.inject({ method: 'POST', url: '/swipes', headers: asUser(sara), payload: { targetUserId: amir.id, direction: 'pass' } })
    const after = await app.inject({ method: 'GET', url: `/asks/${ask.id}/profile`, headers: asUser(sara) })
    expect(after.statusCode).toBe(404)
  })
})

describe('remind', () => {
  it('only after 12h, once, and not for an unclaimed link', async () => {
    const { ask } = await createWithLink(1, [negar.id])
    const recs = await sql`select id, kind from ask_recipients`
    const member = recs.find((r) => r.kind === 'member')!
    const link = recs.find((r) => r.kind === 'link')!
    const remind = (id: string) => app.inject({ method: 'POST', url: `/asks/${ask.id}/remind/${id}`, headers: asUser(sara) })

    expect((await remind(member.id)).json()).toEqual({ error: 'cannot_remind' })

    await sql`update ask_requests set created_at = ${hoursAgo(13)}`
    expect((await remind(member.id)).json()).toEqual({ ok: true })
    expect(notifyAskRemind).toHaveBeenCalledWith(expect.objectContaining({ telegram_id: negar.telegram_id }), 'Sara', member.id, 'ask')
    expect((await remind(member.id)).statusCode).toBe(409)

    expect((await remind(link.id)).json()).toEqual({ error: 'cannot_remind' })

    // A claimer recorded as male is never DMed.
    await sql`update ask_recipients set advisor_tg_id = 555060, advisor_gender = 'male' where id = ${link.id}`
    expect((await remind(link.id)).json()).toEqual({ error: 'cannot_remind' })
    expect(notifyAskRemind).toHaveBeenCalledTimes(1)

    const detail = (await app.inject({ method: 'GET', url: `/asks/${ask.id}`, headers: asUser(sara) })).json()
    expect(detail.recipients.find((r: any) => r.id === member.id).canRemind).toBe(false)
    expect(detail.recipients.find((r: any) => r.id === link.id)).toMatchObject({ displayName: null, status: 'unseen', canRemind: false })
  })
})

describe('job', () => {
  it('expires asks past 48h and purges 30 days after close', async () => {
    const { ask } = await createWithLink()
    await sql`update ask_requests set expires_at = now() - interval '1 minute'`
    const r1 = await runAskJob()
    expect(r1.expired).toBe(1)
    expect((await sql`select status, closed_reason from ask_requests`)[0]).toEqual({ status: 'expired', closed_reason: 'expired' })

    await sql`update ask_requests set closed_at = now() - interval '31 days' where id = ${ask.id}`
    await runAskJob()
    expect(await sql`select id from ask_requests`).toHaveLength(0)
    expect(await sql`select id from ask_recipients`).toHaveLength(0)
  })

  it('purges ask events older than 30 days', async () => {
    await sql`insert into ask_events (name, created_at) values ('ask_entry_tap', now() - interval '31 days'), ('ask_entry_tap', now())`
    await runAskJob()
    expect(await sql`select name from ask_events`).toHaveLength(1)
  })

  it('closes when the target is banned and purges when soft-deleted', async () => {
    await createWithLink()
    await sql`update users set banned_at = now() where id = ${amir.id}`
    await runAskJob()
    expect((await sql`select status, closed_reason from ask_requests`)[0]).toEqual({ status: 'closed', closed_reason: 'target_gone' })
    await sql`update users set deleted_at = now() where id = ${amir.id}`
    await runAskJob()
    expect(await sql`select id from ask_requests`).toHaveLength(0)
  })

  it('sends the catch-up answer DM when one landed inside the hour', async () => {
    await createWithLink(0, [negar.id])
    await sql`update ask_requests set last_answer_notified_at = ${minutesAgo(61)}`
    await sql`update ask_recipients set verdict = 'yes', answered_at = ${minutesAgo(30)}`
    const r = await runAskJob()
    expect(r.notified).toBe(1)
    expect(vi.mocked(notifyAskAnswered).mock.calls[0][1]).toBe('Negar')
    expect((await runAskJob()).notified).toBe(0)
  })

  it('nudges a non-member advisor 3 days after answering, once', async () => {
    const { tokens } = await createWithLink()
    const m = tgAccount(555_020)
    await declare(tokens[0], m, 'female')
    await answerLink(tokens[0], m, { verdict: 'yes' })
    await sql`update ask_recipients set answered_at = ${hoursAgo(73)}`
    expect((await runAskJob()).nudged).toBe(1)
    expect(notifyAskNudge).toHaveBeenCalledWith({ telegram_id: m })
    expect((await runAskJob()).nudged).toBe(0)
  })
})

describe('signup attribution', () => {
  it('a non-member advisor who signs up gets invited_by + join_tag friend_ask', async () => {
    const { ask, tokens } = await createWithLink()
    const m = tgAccount(555_030, 'Maryam')
    await declare(tokens[0], m, 'female')
    await answerLink(tokens[0], m, { verdict: 'yes' })

    const res = await signIn({ kind: 'telegram', tgUser: { id: m, first_name: 'Maryam' } })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const [u] = await sql`select invited_by, join_tag from users where id = ${res.userId}`
    expect(u).toEqual({ invited_by: sara.id, join_tag: 'friend_ask' })
    const [rec] = await sql`select recipient_id from ask_recipients`
    expect(rec.recipient_id).toBe(res.userId)
    const [ev] = await sql`select request_id, props from ask_events where name = 'advisor_converted'`
    expect(ev).toMatchObject({ request_id: ask.id, props: { days_since_answer: 0 } })
  })
})

describe('events', () => {
  it('accepts allowlisted names only', async () => {
    const bad = await app.inject({ method: 'POST', url: '/asks/events', headers: asUser(sara), payload: { name: 'drop_table' } })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({ method: 'POST', url: '/asks/events', headers: asUser(sara), payload: { name: 'ask_entry_tap', props: { source: 'discovery' } } })
    expect(ok.statusCode).toBe(204)
  })

  it('landing events work without auth and take the request from the token', async () => {
    const { ask, tokens } = await createWithLink()
    const res = await app.inject({ method: 'POST', url: `/asks/link/${tokens[0]}/events`, payload: { name: 'ask_link_landed', requestId: '00000000-0000-0000-0000-000000000000' } })
    expect(res.statusCode).toBe(204)
    const [ev] = await sql`select request_id, recipient_kind from ask_events where name = 'ask_link_landed'`
    expect(ev).toEqual({ request_id: ask.id, recipient_kind: 'link' })
  })
})

