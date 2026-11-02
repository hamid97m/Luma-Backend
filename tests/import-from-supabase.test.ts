import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from '../src/migrate.js'
import {
  objectFile, openSource, runImport, type ImportConfig,
} from '../scripts/import-from-supabase.js'

// End-to-end test of the Supabase → self-hosted import script against a fake "Supabase":
// a scratch source DB (schema.sql + a minimal storage schema) and a node http server
// serving storage objects at the Supabase paths.

const PG = process.env.TEST_PG_URL ?? 'postgres://postgres:luma@localhost:54329'
const RUN = process.env.LUMA_TEST_RUN ?? 'local'
const SRC_DB = `luma_import_src_${RUN}`
const TGT_DB = `luma_import_tgt_${RUN}`
const SERVICE_KEY = 'sb_secret_test_key'
const MEDIA_PUBLIC_URL = 'https://api.example.test/media'

const ids = {
  admin: '00000000-0000-0000-0000-0000000000ad',
  a: '00000000-0000-0000-0000-00000000000a', // referred_by → c, inserted before c
  b: '00000000-0000-0000-0000-00000000000b',
  c: '00000000-0000-0000-0000-00000000000c',
  match: '00000000-0000-0000-0000-0000000000a1',
  msg1: '00000000-0000-0000-0000-0000000000e1', // replies to msg2, inserted before it
  msg2: '00000000-0000-0000-0000-0000000000e2',
  photoA: '00000000-0000-0000-0000-0000000000f1',
  photoB: '00000000-0000-0000-0000-0000000000f2',
  plan: '00000000-0000-0000-0000-0000000000b1',
  gift: '00000000-0000-0000-0000-0000000000c1',
  ticket: '00000000-0000-0000-0000-0000000000d1',
}

const OBJECTS = [
  { bucket: 'profile-photos', name: `${ids.a}/${ids.photoA}` },
  { bucket: 'profile-photos', name: `${ids.b}/${ids.photoB}` },
  { bucket: 'profile-photos', name: 'seed/7f1c.jpg' },
  { bucket: 'photo-ai-evidence', name: `${ids.a}/${ids.photoA}.jpg` },
]
const bytesOf = (bucket: string, name: string) => Buffer.from(`fake-image-bytes:${bucket}/${name}`)

let server: Server
let supabaseUrl = ''
let requests: string[] = []
let flakyLeft = 1 // first request for the seed object fails with 500 (retry path)

let admin: postgres.Sql
let src: postgres.Sql
let tgt: postgres.Sql
let mediaDir = ''
const logs: string[] = []

function cfg(): ImportConfig {
  return {
    sourceUrl: `${PG}/${SRC_DB}`,
    targetUrl: `${PG}/${TGT_DB}`,
    supabaseUrl,
    serviceKey: SERVICE_KEY,
    mediaDir,
    mediaPublicUrl: MEDIA_PUBLIC_URL,
    log: (l) => logs.push(l),
  }
}

async function tableNames(sql: postgres.Sql): Promise<string[]> {
  return (await sql<{ tablename: string }[]>`
    select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'
    order by tablename`).map((r) => r.tablename)
}

async function counts(sql: postgres.Sql): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const t of await tableNames(sql)) {
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from "${t}"`)
    out[t] = n
  }
  return out
}

/** Content fingerprint of every public + storage table (detects any source write). */
async function fingerprint(sql: postgres.Sql): Promise<string> {
  const parts: string[] = []
  for (const t of [...(await tableNames(sql)).map((t) => `public."${t}"`), 'storage.objects']) {
    const [{ h }] = await sql.unsafe(`select md5(coalesce(string_agg(x::text, '|' order by x::text), '')) as h from ${t} x`)
    parts.push(`${t}:${h}`)
  }
  return parts.join('\n')
}

async function seedSource(sql: postgres.Sql, base: string): Promise<void> {
  const pub = `${base}/storage/v1/object/public`
  await sql.unsafe(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
  await sql.unsafe(`
    create schema storage;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb);`)
  await sql.begin(async (tx) => {
    // Load "out of order" like a real DB's heap can be: rows referencing later rows.
    await tx`set local session_replication_role = replica`
    await tx.unsafe(`
      insert into admins (id, username, password_hash) values ('${ids.admin}', 'root', 'x');
      insert into users (id, telegram_id, name, age, gender, looking_for, interests, referred_by, referral_code, account_status, premium_until)
        values ('${ids.a}', 9000000001, 'Ali', 30, 'man', 'women', '{music,"rock climbing"}', '${ids.c}', 'refA', 'active', '2026-12-01T10:00:00Z'),
               ('${ids.b}', 9000000002, 'Sara', 27, 'woman', 'men', '{}', null, 'refB', 'active', null),
               ('${ids.c}', 9000000003, 'Reza', 33, 'man', 'everyone', '{}', null, 'refC', 'preparing', null);
      insert into user_photos (id, user_id, url, position) values
        ('${ids.photoA}', '${ids.a}', '${pub}/profile-photos/${ids.a}/${ids.photoA}', 0),
        ('${ids.photoB}', '${ids.b}', '${pub}/profile-photos/${ids.b}/${ids.photoB}', 0);
      insert into matches (id, user1_id, user2_id, created_at, last_message_at)
        values ('${ids.match}', '${ids.a}', '${ids.b}', '2020-01-01T00:00:00Z', '2020-01-01T00:00:00Z');
      insert into messages (id, match_id, sender_id, body, created_at, reply_to_message_id) values
        ('${ids.msg1}', '${ids.match}', '${ids.b}', 'reply', '2026-10-02T00:00:00Z', '${ids.msg2}'),
        ('${ids.msg2}', '${ids.match}', '${ids.a}', 'salam', '2026-10-01T00:00:00Z', null);
      insert into swipes (swiper_id, swiped_id, direction) values ('${ids.a}', '${ids.b}', 'like'), ('${ids.b}', '${ids.a}', 'like');
      insert into blocks (blocker_id, blocked_id) values ('${ids.c}', '${ids.a}');
      insert into reports (reporter_id, reported_id, context, reason, note, match_id)
        values ('${ids.b}', '${ids.c}', 'discovery', 'fake', E'tab\\tand\\nnewline', null);
      insert into support_tickets (id, user_id) values ('${ids.ticket}', '${ids.a}');
      insert into support_messages (ticket_id, sender, admin_id, body) values ('${ids.ticket}', 'admin', '${ids.admin}', 'hi');
      insert into broadcasts (created_by, message, filters, status)
        values ('${ids.admin}', 'see ${base}/storage/v1/object/sign/profile-photos/x?token=abc', '{"gender":"man"}', 'completed');
      insert into city_lookups (key, city, country) values ('tehran', 'Tehran', 'IR');
      insert into fake_liker_runs (trigger, started_at, finished_at, likes_sent) values ('manual', now(), now(), 3);
      insert into gift_price_overrides (gift_id, charged_stars) values ('g1', 50);
      insert into gift_transactions (id, buyer_id, recipient_id, context, match_id, gift_id, gift_star_cost, charged_stars)
        values ('${ids.gift}', '${ids.a}', '${ids.b}', 'chat', '${ids.match}', 'g1', 15, 20);
      insert into like_reveals (user_id, swiper_id, revealed_on) values ('${ids.a}', '${ids.b}', '2026-10-03');
      insert into photo_ai_checks (photo_id, user_id, approved, reason, photo_url, evidence_path)
        values ('${ids.photoA}', '${ids.a}', true, null, '${pub}/profile-photos/${ids.a}/${ids.photoA}', '${ids.a}/${ids.photoA}.jpg');
      insert into premium_plans (id, title, price_stars, duration_days, translations)
        values ('${ids.plan}', 'Monthly', 250, 30, '{"fa":{"title":"ماهانه"}}');
      insert into premium_transactions (user_id, plan_id, plan_title, price_stars, duration_days, status)
        values ('${ids.a}', '${ids.plan}', 'Monthly', 250, 30, 'paid');
      insert into purchase_message_sends (user_id) values ('${ids.c}');
      insert into referral_claims (telegram_id, code) values (9000000003, 'refA');
      insert into referral_rewards (referrer_id, milestone) values ('${ids.a}', 1);
      insert into referrals (referrer_id, referred_id) values ('${ids.a}', '${ids.c}');
      update premium_config set premium_enabled = true, toman_per_star = 4200;
      update purchase_message_config set enabled = true,
        button = '{"text":"Open","image":"${pub}/profile-photos/seed/7f1c.jpg"}';
    `)
  })
  for (const o of OBJECTS) {
    await sql`insert into storage.objects (bucket_id, name, metadata)
              values (${o.bucket}, ${o.name}, ${sql.json({ size: bytesOf(o.bucket, o.name).length })})`
  }
  await sql`insert into storage.objects (bucket_id, name, metadata) values
    ('profile-photos', ${`${ids.a}/.emptyFolderPlaceholder`}, '{"size":0}'),
    ('profile-photos', 'evil/../escape.jpg', '{"size":3}'),
    ('other-bucket', 'ignored.jpg', '{"size":3}')`
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? '')
    requests.push(url)
    const pub = url.match(/^\/storage\/v1\/object\/public\/(profile-photos)\/(.+)$/)
    const priv = url.match(/^\/storage\/v1\/object\/authenticated\/(photo-ai-evidence)\/(.+)$/)
    const hit = pub ?? priv
    if (priv && req.headers.apikey !== SERVICE_KEY) { res.writeHead(400).end('{"error":"Unauthorized"}'); return }
    if (!hit || !OBJECTS.some((o) => o.bucket === hit[1] && o.name === hit[2])) { res.writeHead(404).end('not found'); return }
    if (hit[2] === 'seed/7f1c.jpg' && flakyLeft > 0) { flakyLeft--; res.writeHead(500).end('boom'); return }
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(bytesOf(hit[1], hit[2]))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  supabaseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

  admin = postgres(`${PG}/postgres`, { max: 1, onnotice: () => {} })
  for (const db of [SRC_DB, TGT_DB]) {
    await admin.unsafe(`drop database if exists "${db}" with (force)`)
    await admin.unsafe(`create database "${db}"`)
  }
  src = postgres(`${PG}/${SRC_DB}`, { max: 1, onnotice: () => {} })
  tgt = postgres(`${PG}/${TGT_DB}`, { max: 1, onnotice: () => {} })
  await seedSource(src, supabaseUrl)
  await migrate(tgt as never) // schema.sql + schema_migrations, singleton config rows included
  await tgt`insert into schema_migrations (name) values ('0000_marker.sql')`

  mediaDir = await mkdtemp(join(tmpdir(), 'luma-import-media-'))
}, 60_000)

// DROP DATABASE waits for a checkpoint, which can take seconds when other test runs share the server.
afterAll(async () => {
  await src?.end()
  await tgt?.end()
  for (const db of [SRC_DB, TGT_DB]) await admin?.unsafe(`drop database if exists "${db}" with (force)`)
  await admin?.end()
  server?.close()
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true })
}, 60_000)

describe('import-from-supabase', () => {
  let sourceBefore = ''

  it('dry run (no --yes) changes nothing on the target', async () => {
    sourceBefore = await fingerprint(src)
    const before = await counts(tgt)
    const res = await runImport(cfg(), ['data', 'files', 'rewrite-urls'], false)
    expect(res.ok).toBe(true)
    expect(await counts(tgt)).toEqual(before)
    expect(requests).toEqual([])
    expect(res.files).toMatchObject({ total: 4, downloaded: 0, skipped: 0 })
  })

  it('--all --yes copies every table, files and rewrites URLs', async () => {
    const res = await runImport(cfg(), ['data', 'files', 'rewrite-urls', 'verify'], true)
    expect(res.ok, logs.join('\n')).toBe(true)

    // Row counts: exactly the source's rows (schema.sql's singleton rows replaced, not added to).
    const want = await counts(src)
    expect(await counts(tgt)).toEqual(want)
    expect(want.users).toBe(3)
    expect(want.premium_config).toBe(1)
    expect((await tgt`select premium_enabled, toman_per_star from premium_config`)[0])
      .toEqual({ premium_enabled: true, toman_per_star: 4200 })
    // schema_migrations is left alone.
    expect(await tgt`select name from schema_migrations`).toEqual([{ name: '0000_marker.sql' }])

    // Self-referencing FKs survived.
    expect((await tgt`select referred_by from users where id = ${ids.a}`)[0].referred_by).toBe(ids.c)
    expect((await tgt`select reply_to_message_id from messages where id = ${ids.msg1}`)[0].reply_to_message_id).toBe(ids.msg2)
    // Values with arrays / escapes / enums / timestamps round-trip.
    expect((await tgt`select interests from users where id = ${ids.a}`)[0].interests).toEqual(['music', 'rock climbing'])
    expect((await tgt`select note from reports`)[0].note).toBe('tab\tand\nnewline')
    expect((await tgt`select premium_until::text as p from users where id = ${ids.a}`)[0].p)
      .toBe((await src`select premium_until::text as p from users where id = ${ids.a}`)[0].p)

    // The messages insert trigger did NOT fire: last_message_at is still the source value.
    const [m] = await tgt`select last_message_at::text as t from matches where id = ${ids.match}`
    const [ms] = await src`select last_message_at::text as t from matches where id = ${ids.match}`
    expect(m.t).toBe(ms.t)
    expect(m.t).toMatch(/^2020-01-01/)
    // …but the trigger is still enabled for normal writes afterwards.
    const [{ tgenabled }] = await tgt`select tgenabled from pg_trigger where tgname = 'trg_bump_match_last_message_at'`
    expect(tgenabled).toBe('O')

    // Files on disk, in storage.ts's layout, with the right bytes.
    for (const o of OBJECTS) {
      expect(await readFile(objectFile(mediaDir, o.bucket, o.name))).toEqual(bytesOf(o.bucket, o.name))
    }
    expect(objectFile(mediaDir, 'photo-ai-evidence', 'x')).toContain(join('private', 'photo-ai-evidence'))
    await expect(stat(join(mediaDir, 'public', 'profile-photos', 'escape.jpg'))).rejects.toThrow()
    expect(res.files).toMatchObject({ total: 4, downloaded: 4, skipped: 0, failed: [] })
    expect(res.files!.unsafe.map((o) => o.name)).toEqual(['evil/../escape.jpg'])
    expect(requests.filter((r) => r.endsWith('seed/7f1c.jpg'))).toHaveLength(2) // one 500, one retry

    // URL rewrite: text column + jsonb column.
    expect((await tgt`select url from user_photos where id = ${ids.photoA}`)[0].url)
      .toBe(`${MEDIA_PUBLIC_URL}/profile-photos/${ids.a}/${ids.photoA}`)
    expect((await tgt`select photo_url from photo_ai_checks`)[0].photo_url)
      .toBe(`${MEDIA_PUBLIC_URL}/profile-photos/${ids.a}/${ids.photoA}`)
    const [{ button }] = await tgt`select button from purchase_message_config`
    expect(button).toEqual({ text: 'Open', image: `${MEDIA_PUBLIC_URL}/profile-photos/seed/7f1c.jpg` })
    expect(res.rewrite!.updated.get('user_photos.url')).toBe(2)
    expect(res.rewrite!.updated.get('purchase_message_config.button')).toBe(1)
    // Other Supabase URL shapes are reported, not touched.
    expect([...res.rewrite!.leftovers.keys()]).toEqual(['broadcasts.message'])
    expect(res.verify!.ok).toBe(true)
  }, 60_000)

  it('re-running is idempotent and incremental', async () => {
    const before = await counts(tgt)
    requests = []
    const res = await runImport(cfg(), ['data', 'files', 'rewrite-urls', 'verify'], true)
    expect(res.ok, logs.join('\n')).toBe(true)
    expect(await counts(tgt)).toEqual(before)
    expect(res.files).toMatchObject({ downloaded: 0, skipped: 4, failed: [] })
    expect(requests).toEqual([])
    expect((await tgt`select url from user_photos where id = ${ids.photoB}`)[0].url)
      .toBe(`${MEDIA_PUBLIC_URL}/profile-photos/${ids.b}/${ids.photoB}`)
  }, 60_000)

  it('a truncated file on disk is downloaded again', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(objectFile(mediaDir, OBJECTS[0].bucket, OBJECTS[0].name), 'short')
    requests = []
    const res = await runImport(cfg(), ['files'], true)
    expect(res.files).toMatchObject({ downloaded: 1, skipped: 3 })
    expect(await readFile(objectFile(mediaDir, OBJECTS[0].bucket, OBJECTS[0].name))).toEqual(bytesOf(OBJECTS[0].bucket, OBJECTS[0].name))
  })

  it('verify fails when a file is missing', async () => {
    await rm(objectFile(mediaDir, OBJECTS[1].bucket, OBJECTS[1].name))
    const res = await runImport(cfg(), ['verify'], false)
    expect(res.ok).toBe(false)
    expect(res.verify!.problems.join('\n')).toContain('profile-photos: 1 file(s) missing')
  })

  it('never writes to the source', async () => {
    expect(await fingerprint(src)).toBe(sourceBefore)
    const ro = openSource(cfg())
    try {
      await expect(ro`insert into city_lookups (key) values ('x')`).rejects.toMatchObject({ code: '25006' })
    } finally {
      await ro.end()
    }
  })

  it('refuses when the schemas differ', async () => {
    await src`alter table city_lookups add column extra text`
    try {
      const res = await runImport(cfg(), ['data'], true)
      expect(res.ok).toBe(false)
      expect(logs.join('\n')).toContain('city_lookups.extra: missing in target')
      expect(await counts(tgt)).toEqual(await counts(src)) // previous import intact (nothing truncated)
    } finally {
      await src`alter table city_lookups drop column extra`
    }
  })
})
