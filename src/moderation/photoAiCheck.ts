import type { FastifyBaseLogger } from 'fastify'
import { sql } from '../db.js'
import * as storage from '../storage.js'
import { pauseForPhotoReview } from './autoPause.js'

export type PhotoVerdict = { approved: boolean; reason: string | null }
export type PhotoReview = PhotoVerdict & { promptTokens: number | null; completionTokens: number | null }

// Private copies of rejected photos (the pause deletes the originals).
export const EVIDENCE_BUCKET = 'photo-ai-evidence' as const

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-flash'
const TIMEOUT_MS = 30_000
// Hard spend ceiling per process per UTC day (~$0.0003 per call). Over the cap
// the check is skipped uncached; the user's next photo change retries it.
const DEFAULT_DAILY_LIMIT = 1000

export const REJECT_REASONS = ['no_face', 'not_real_person', 'celebrity_or_stock', 'nudity', 'contact_or_ad'] as const

// Per user per UTC day, so one account churning its main photo can't spend
// everyone's daily budget.
const USER_DAILY_LIMIT = 10

let usage = { day: '', calls: 0, perUser: new Map<string, number>() }

function takeDailySlot(userId: string): boolean {
  const limit = Number(process.env.PHOTO_CHECK_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT
  const day = new Date().toISOString().slice(0, 10)
  if (usage.day !== day) usage = { day, calls: 0, perUser: new Map() }
  const userCalls = usage.perUser.get(userId) ?? 0
  if (usage.calls >= limit || userCalls >= USER_DAILY_LIMIT) return false
  usage.calls++
  usage.perUser.set(userId, userCalls + 1)
  return true
}

// Photo ids with a DeepSeek call in flight; repeat triggers wait on it.
const inFlight = new Map<string, Promise<PhotoVerdict>>()

const SYSTEM_PROMPT = `You review the main profile photo of a user on a dating app. Other users see this photo first, so it must show the real user.
Reply with a JSON object only, exactly: {"approved": boolean, "reason": string | null}
Reject (approved false) only when the photo clearly breaks one of these rules, with reason set to the rule's code:
- "no_face": no clearly visible human face — back of the head, too far away, face hidden by a mask, emoji or sticker, or too dark or blurry to see the face.
- "not_real_person": not a real photo of a person — cartoon, drawing, anime, AI-generated art, logo, meme, landscape, object, animal or a screenshot.
- "celebrity_or_stock": a recognizable celebrity, athlete or public figure, or a professional stock, model or advertising photo.
- "nudity": nudity or sexual content. Swimwear at a beach or pool and gym clothes are fine; exposed genitals or nipples, underwear-only shots or sexual poses are not.
- "contact_or_ad": a visible phone number, social-media handle or ID, URL, QR code, or advertising text.
Sunglasses, hats, filters, selfies and casual or low-quality photos are fine. If you are unsure, approve.
When approved, reason is null.`

/**
 * Validates the model's JSON reply. Throws on non-JSON or a missing verdict
 * (a transient model failure, so nothing is cached and nobody is paused). A
 * rejection pauses the user and deletes every photo, so one that names none of
 * our rules counts as approved.
 */
export function parsePhotoVerdict(content: string): PhotoVerdict {
  const parsed = JSON.parse(content) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object' || typeof parsed.approved !== 'boolean') {
    throw new Error('photo_check_bad_reply')
  }
  if (parsed.approved || !(REJECT_REASONS as readonly unknown[]).includes(parsed.reason)) {
    return { approved: true, reason: null }
  }
  return { approved: false, reason: parsed.reason as string }
}

/** One DeepSeek vision call. Throws on network/API/parse failure. */
export async function askDeepSeekPhoto(userId: string, imageUrl: string): Promise<PhotoReview> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set')
  if (!takeDailySlot(userId)) throw new Error('photo_check_daily_limit')

  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      // Thinking is on by default and bills hundreds of hidden output tokens.
      thinking: { type: 'disabled' },
      temperature: 0,
      max_tokens: 40,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        // Images are only accepted in user messages. "low" downscales to
        // 512×512, which caps the image at a fraction of the full-size tokens.
        { role: 'user', content: [{ type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }] },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`deepseek_http_${res.status}`)

  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const content = body.choices?.[0]?.message?.content
  if (!content) throw new Error('deepseek_empty_reply')
  return {
    ...parsePhotoVerdict(content),
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
  }
}

/** Copies a photo into the private evidence bucket. Never throws; null on failure. */
async function saveEvidence(userId: string, photoId: string): Promise<string | null> {
  const path = `${userId}/${photoId}`
  let data: Buffer | null
  try {
    data = await storage.download('profile-photos', path)
  } catch (err) {
    console.error('[moderation] evidence download failed:', (err as Error).message)
    return null
  }
  if (!data) {
    console.error('[moderation] evidence download failed:', 'empty')
    return null
  }
  try {
    await storage.upload(EVIDENCE_BUCKET, path, data)
  } catch (err) {
    console.error('[moderation] evidence upload failed:', (err as Error).message)
    return null
  }
  return path
}

async function mainPhoto(userId: string): Promise<{ id: string; url: string } | null> {
  // A failed read counts as "no main photo", as before.
  const [data] = await sql<{ id: string; url: string }[]>`
    select id, url from user_photos where user_id = ${userId}
    order by position asc limit 1`.catch(() => [])
  return data ?? null
}

async function isCheckableUser(userId: string): Promise<boolean> {
  let user
  try {
    ;[user] = await sql`
      select age, is_seed, paused_at, banned_at, deleted_at from users where id = ${userId}`
  } catch (error) {
    throw new Error(`photo_check_user_failed: ${(error as Error).message}`)
  }
  // New accounts are created with age 0; the real profile only lands with the
  // onboarding profile save, so age 0 means sign-up is unfinished.
  return Boolean(user && user.age > 0 && !user.is_seed && !user.paused_at && !user.banned_at && !user.deleted_at)
}

async function review(userId: string, photo: { id: string; url: string }): Promise<PhotoVerdict> {
  const { promptTokens, completionTokens, ...verdict } = await askDeepSeekPhoto(userId, photo.url)
  const evidencePath = verdict.approved ? null : await saveEvidence(userId, photo.id)
  try {
    await sql`
      insert into photo_ai_checks ${sql({
        photo_id: photo.id,
        user_id: userId,
        approved: verdict.approved,
        reason: verdict.reason,
        photo_url: photo.url,
        evidence_path: evidencePath,
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
      })}
      on conflict (photo_id) do nothing`
  } catch (error) {
    console.error('[moderation] photo_ai_checks upsert failed:', (error as Error).message)
  }
  return verdict
}

function reviewOnce(userId: string, photo: { id: string; url: string }): Promise<PhotoVerdict> {
  let pending = inFlight.get(photo.id)
  if (!pending) {
    pending = review(userId, photo).finally(() => inFlight.delete(photo.id))
    inFlight.set(photo.id, pending)
  }
  return pending
}

/**
 * AI-reviews a user's main (position 0) photo once per photo, and pauses them
 * for photo review when it is rejected. Seed, paused, banned, deleted and
 * unfinished accounts, and approved photos, are skipped. Returns the verdict,
 * or null when nothing was checked.
 */
export async function checkMainPhoto(userId: string): Promise<PhotoVerdict | null> {
  if (!(await isCheckableUser(userId))) return null

  const photo = await mainPhoto(userId)
  if (!photo) return null

  let done: { approved: boolean; reason: string | null } | undefined
  try {
    ;[done] = await sql<{ approved: boolean; reason: string | null }[]>`
      select approved, reason from photo_ai_checks where photo_id = ${photo.id}`
  } catch (error) {
    throw new Error(`photo_check_lookup_failed: ${(error as Error).message}`)
  }
  if (done?.approved) return null

  // A cached rejection still pauses: an earlier pause can have been skipped
  // because the photo briefly stopped being main.
  const verdict: PhotoVerdict = done ? { approved: false, reason: done.reason } : await reviewOnce(userId, photo)

  // The call takes seconds; if they swapped their main photo or the account
  // changed state meanwhile, this verdict must not pause them.
  if (!verdict.approved && (await mainPhoto(userId))?.id === photo.id && (await isCheckableUser(userId))) {
    await pauseForPhotoReview(userId)
  }
  return verdict
}

/**
 * Fire-and-forget: a photo or profile save must never wait on, or fail
 * because of, DeepSeek. No-op without DEEPSEEK_API_KEY or with PHOTO_AI_CHECK=off.
 */
export function scheduleMainPhotoCheck(userId: string, log: FastifyBaseLogger): void {
  if (!process.env.DEEPSEEK_API_KEY || process.env.PHOTO_AI_CHECK === 'off') return
  checkMainPhoto(userId)
    .then((verdict) => {
      if (verdict && !verdict.approved) log.info({ userId, reason: verdict.reason }, 'main photo rejected by AI check')
    })
    .catch((err) => log.warn({ err, userId }, 'main photo AI check failed'))
}
