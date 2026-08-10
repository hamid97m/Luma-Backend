import { FastifyInstance } from 'fastify'
import { db } from '../../db.js'
import { pickFakeSender, type FakeChatUser } from '../../messaging/fakeParticipant.js'
import { deliverMessageNotification } from '../../messaging/deliver.js'

const PAGE_SIZE = 20
const MESSAGES_PAGE_SIZE = 50

const MATCH_SELECT = `
  id, created_at, user1_id, user2_id,
  user1:users!matches_user1_id_fkey(id, name, is_seed, telegram_id, last_active, notified_offline_at, allows_write_to_pm, user_photos(url, position)),
  user2:users!matches_user2_id_fkey(id, name, is_seed, telegram_id, last_active, notified_offline_at, allows_write_to_pm, user_photos(url, position))
`

function participant(u: any) {
  const photo =
    (u?.user_photos ?? []).slice().sort((a: any, b: any) => a.position - b.position)[0]?.url ?? null
  return { id: u?.id ?? null, name: u?.name ?? '', photo, isSeed: !!u?.is_seed }
}

function fakeChatUser(u: any): FakeChatUser {
  return {
    id: u?.id, name: u?.name ?? '', is_seed: !!u?.is_seed,
    telegram_id: u?.telegram_id ?? null, last_active: u?.last_active ?? null,
    notified_offline_at: u?.notified_offline_at ?? null, allows_write_to_pm: u?.allows_write_to_pm ?? null,
  }
}

// Match ids where a fake chat has ≥1 unread message from the real user.
// Reused by GET /chats/unread-count and the ?filter=fake-unread list.
async function fakeUnreadMatchIds(): Promise<string[]> {
  const { data: seeds } = await db.from('users').select('id').eq('is_seed', true)
  const seedIds = (seeds ?? []).map((s: any) => s.id)
  if (seedIds.length === 0) return []

  const inList = `(${seedIds.join(',')})`
  const { data: matches } = await db
    .from('matches')
    .select('id, user1_id, user2_id')
    .or(`user1_id.in.${inList},user2_id.in.${inList}`)

  const realByMatch = new Map<string, string>() // matchId -> real participant id
  for (const m of matches ?? []) {
    const u1Seed = seedIds.includes(m.user1_id)
    const u2Seed = seedIds.includes(m.user2_id)
    if (u1Seed && u2Seed) continue // both fake -> no real recipient
    realByMatch.set(m.id, u1Seed ? m.user2_id : m.user1_id)
  }
  if (realByMatch.size === 0) return []

  const matchIds = [...realByMatch.keys()]
  const { data: unread } = await db
    .from('messages')
    .select('match_id, sender_id')
    .is('read_at', null)
    .in('match_id', matchIds)

  const result = new Set<string>()
  for (const msg of unread ?? []) {
    if (realByMatch.get(msg.match_id) === msg.sender_id) result.add(msg.match_id)
  }
  return [...result]
}

export async function adminChatsRoutes(app: FastifyInstance) {
  app.get('/chats/unread-count', async () => {
    const ids = await fakeUnreadMatchIds()
    return { count: ids.length }
  })

  app.get('/chats', async (req, reply) => {
    const { page = '1', filter } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * PAGE_SIZE

    if (filter === 'fake-unread') {
      const unreadIds = await fakeUnreadMatchIds()
      const total = unreadIds.length
      if (total === 0) return { items: [], total: 0, page: pageNum, pageCount: 1 }
      const pageIds = unreadIds.slice(from, from + PAGE_SIZE)
      const { data: rows, error } = await db
        .from('matches').select(MATCH_SELECT).in('id', pageIds).order('created_at', { ascending: false })
      if (error) return reply.status(500).send({ error: 'chats_fetch_failed' })
      const items = await Promise.all((rows ?? []).map(async (row: any) => {
        const [{ count: messageCount }, { data: lastRows }] = await Promise.all([
          db.from('messages').select('id', { count: 'exact', head: true }).eq('match_id', row.id),
          db.from('messages').select('body, created_at').eq('match_id', row.id).order('created_at', { ascending: false }).limit(1),
        ])
        const last = lastRows?.[0]
        return {
          matchId: row.id, matchedAt: row.created_at,
          users: [participant(row.user1), participant(row.user2)],
          messageCount: messageCount ?? 0,
          lastMessage: last ? { body: last.body, createdAt: last.created_at } : null,
        }
      }))
      return { items, total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) }
    }

    const { data: rows, count, error } = await db
      .from('matches')
      .select(MATCH_SELECT, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, from + PAGE_SIZE - 1)

    if (error) return reply.status(500).send({ error: 'chats_fetch_failed' })

    let items
    try {
      items = await Promise.all(
        (rows ?? []).map(async (row: any) => {
          const [{ count: messageCount, error: countErr }, { data: lastRows, error: lastErr }] = await Promise.all([
            db.from('messages').select('id', { count: 'exact', head: true }).eq('match_id', row.id),
            db.from('messages').select('body, created_at').eq('match_id', row.id)
              .order('created_at', { ascending: false }).limit(1),
          ])
          if (countErr || lastErr) throw new Error('chats sub-query failed')
          const last = lastRows?.[0]
          return {
            matchId: row.id,
            matchedAt: row.created_at,
            users: [participant(row.user1), participant(row.user2)],
            messageCount: messageCount ?? 0,
            lastMessage: last ? { body: last.body, createdAt: last.created_at } : null,
          }
        })
      )
    } catch (err) {
      req.log.error({ err }, 'chats fetch failed')
      return reply.status(500).send({ error: 'chats_fetch_failed' })
    }

    const total = count ?? 0
    return { items, total, page: pageNum, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)) }
  })

  app.get('/chats/:matchId', async (req, reply) => {
    const { matchId } = req.params as { matchId: string }
    const { page = '1' } = req.query as Record<string, string>
    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const from = (pageNum - 1) * MESSAGES_PAGE_SIZE

    const { data: match, error: matchErr } = await db
      .from('matches')
      .select(MATCH_SELECT)
      .eq('id', matchId)
      .single()

    if (matchErr && matchErr.code !== 'PGRST116') {
      req.log.error({ err: matchErr }, 'match lookup failed')
      return reply.status(500).send({ error: 'chats_fetch_failed' })
    }
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    // If this is a fake chat, opening it "reads" the real user's messages so
    // the unread badge clears. Never do this for real↔real chats (would forge
    // read-receipts between two real users).
    const picked = pickFakeSender(fakeChatUser((match as any).user1), fakeChatUser((match as any).user2))
    if (picked) {
      await db
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('match_id', matchId)
        .eq('sender_id', picked.recipient.id)
        .is('read_at', null)
    }

    const { data: rows, count, error } = await db
      .from('messages')
      .select('id, sender_id, body, created_at, read_at', { count: 'exact' })
      .eq('match_id', matchId)
      .order('created_at', { ascending: true })
      .range(from, from + MESSAGES_PAGE_SIZE - 1)

    if (error) return reply.status(500).send({ error: 'messages_fetch_failed' })

    const total = count ?? 0
    return {
      match: {
        id: (match as any).id,
        matchedAt: (match as any).created_at,
        users: [participant((match as any).user1), participant((match as any).user2)],
      },
      messages: {
        items: (rows ?? []).map((m: any) => ({
          id: m.id, senderId: m.sender_id, body: m.body, createdAt: m.created_at, readAt: m.read_at,
        })),
        total,
        page: pageNum,
        pageCount: Math.max(1, Math.ceil(total / MESSAGES_PAGE_SIZE)),
      },
    }
  })

  app.post('/chats/:matchId/messages', async (req, reply) => {
    const { matchId } = req.params as { matchId: string }
    const { body } = req.body as { body?: string }
    const trimmed = (body ?? '').trim()
    if (!trimmed) return reply.status(400).send({ error: 'empty_message' })
    if (trimmed.length > 2000) return reply.status(400).send({ error: 'message_too_long' })

    const { data: match, error: matchErr } = await db
      .from('matches').select(MATCH_SELECT).eq('id', matchId).single()
    if (matchErr && matchErr.code !== 'PGRST116') {
      req.log.error({ err: matchErr }, 'match lookup failed')
      return reply.status(500).send({ error: 'chats_fetch_failed' })
    }
    if (!match) return reply.status(404).send({ error: 'match_not_found' })

    const picked = pickFakeSender(fakeChatUser((match as any).user1), fakeChatUser((match as any).user2))
    if (!picked) return reply.status(400).send({ error: 'no_fake_participant' })

    const { data: message, error } = await db
      .from('messages')
      .insert({ match_id: matchId, sender_id: picked.fake.id, body: trimmed, type: 'text' })
      .select('id, sender_id, body, created_at')
      .single()
    if (error || !message) return reply.status(500).send({ error: 'send_failed' })

    void deliverMessageNotification(
      {
        id: picked.recipient.id, telegram_id: picked.recipient.telegram_id,
        last_active: picked.recipient.last_active, notified_offline_at: picked.recipient.notified_offline_at,
        allows_write_to_pm: picked.recipient.allows_write_to_pm,
      },
      picked.fake.id, picked.fake.name, trimmed, req.log,
    )

    return { message: { id: message.id, senderId: message.sender_id, body: message.body, createdAt: message.created_at, readAt: null } }
  })
}
