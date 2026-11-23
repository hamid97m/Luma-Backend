import { sql } from '../db.js'

/**
 * Save-time review of user-written profile text (name, bio, icebreaker answer).
 * A free regex pre-check catches obvious contact info; everything else goes to
 * DeepSeek. A rejection blocks the save (the route returns 422 with the reason).
 * DeepSeek trouble never blocks a save: it fails open.
 */

export const TEXT_FIELDS = ['name', 'bio', 'icebreaker_answer'] as const
export type TextField = (typeof TEXT_FIELDS)[number]

export const TEXT_REJECT_REASONS = ['contact_info', 'fake_name', 'offensive', 'sexual', 'ad_or_spam'] as const
export type TextRejectReason = (typeof TEXT_REJECT_REASONS)[number]

export type TextVerdict = { approved: boolean; reason: TextRejectReason | null }

/** Thrown when one user has spent their daily AI checks (→ HTTP 429). */
export class ProfileTextLimitError extends Error {
  constructor() {
    super('profile_text_check_limit')
  }
}

export function isTextField(v: unknown): v is TextField {
  return (TEXT_FIELDS as readonly unknown[]).includes(v)
}

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
const DEEPSEEK_MODEL = 'deepseek-flash'
const TIMEOUT_MS = 8_000
// Global spend ceiling per process per UTC day; over it the check is skipped (fail-open).
const DEFAULT_DAILY_LIMIT = 3000
// AI calls per user per UTC day; over it the save is refused (429), so one
// account can't brute-force the model by retrying variants.
export const USER_DAILY_AI_LIMIT = 30

let usage = { day: '', calls: 0 }

function takeGlobalSlot(): boolean {
  const limit = Number(process.env.TEXT_CHECK_DAILY_LIMIT) || DEFAULT_DAILY_LIMIT
  const day = new Date().toISOString().slice(0, 10)
  if (usage.day !== day) usage = { day, calls: 0 }
  if (usage.calls >= limit) return false
  usage.calls++
  return true
}

/** Test hook: forget today's global call count. */
export function resetTextCheckUsage(): void {
  usage = { day: '', calls: 0 }
}

// ---------------------------------------------------------------------------
// Regex pre-check (contact info only — high precision; the model handles the rest)
// ---------------------------------------------------------------------------

/** Persian/Arabic-Indic digits → ASCII, full-width @ → @, zero-width chars removed. */
function normalize(text: string): string {
  return text
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/＠/g, '@')
    .replace(/[​-‍⁠﻿]/g, '')
}

const CONTACT_PATTERNS: RegExp[] = [
  // Emails.
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  // @handles (not an email: the @ is not glued to a preceding word character).
  /(?:^|[^A-Za-z0-9._%+-])@\s?[A-Za-z0-9_][A-Za-z0-9_.]{2,}/,
  // URLs and link shorteners, incl. spaced-out "t . me".
  /https?:\/\//i,
  /\bwww\s?\./i,
  /\b(?:t|wa|telegram)\s?\.\s?me\b/i,
  /\b[a-z0-9-]{2,}\.(?:com|ir|net|org|io|app|link|xyz|info|site|online|shop|store|ly|gg)\b/i,
  // Platform word + explicit separator + handle: "insta: ali_99", "id=reza".
  /\b(?:insta(?:gram)?|ig|telegram|tele|tg|whats\s?app|wa|snap(?:chat)?|id|aydi|aidi|eydi)\s*[:=\-]\s*[A-Za-z0-9_.]{3,}/i,
  // Platform word + handle that looks like one (has a digit, _ or .): "insta ali_reza".
  /\b(?:insta(?:gram)?|ig|telegram|tele|tg|whats\s?app|snap(?:chat)?|aydi|aidi|eydi)\s+[A-Za-z0-9]*[_.\d][A-Za-z0-9_.]*[A-Za-z0-9_]/i,
  // Persian platform word followed by a Latin handle: "آیدی: ali_r", "اینستا reza.k".
  // The lookbehind keeps "تل" in "هتل Hilton" from counting; م/مو/ش = "my/his".
  /(?<![\u0600-\u06FF])(?:آیدی|ایدی|آی\s?دی|اینستا(?:گرام)?|تلگرام|تل|واتساپ|واتس\s?اپ|اسنپ\s?چت)(?:م|مو|ش)?\s*[:：=\-]?\s*@?[A-Za-z][A-Za-z0-9_.]{2,}/,
]

/**
 * Phone numbers: a run of 7+ digits. A run split by spaces/dashes/brackets
 * ("0912 345 6789") only counts when it starts like a phone number (+, 0 or 9),
 * so "1375 06 12" or "25 180 75" in a bio stay allowed. Slashes and dots are
 * not separators (dates like 1402/05/12).
 */
function hasPhoneNumber(t: string): boolean {
  for (const [run] of t.matchAll(/\+?\d(?:[\s\-()]{0,2}\d)*/g)) {
    const digits = run.replace(/\D/g, '')
    if (digits.length < 7) continue
    if (/^\+?\d+$/.test(run) || /^[+09]/.test(run)) return true
  }
  return false
}

/** True when the text contains obvious contact info (phone, handle, link, email). */
export function regexFindsContactInfo(text: string): boolean {
  const t = normalize(text)
  return hasPhoneNumber(t) || CONTACT_PATTERNS.some((re) => re.test(t))
}

// ---------------------------------------------------------------------------
// DeepSeek
// ---------------------------------------------------------------------------

export const TEXT_SYSTEM_PROMPT = `You moderate text that a user wrote on their dating-app profile. Users are mostly Iranian; text is usually Persian, Finglish (Persian written in Latin letters) or English.
You get a JSON object {"field": "name" | "bio" | "icebreaker_answer", "text": string}.
Reply with a JSON object only, exactly: {"approved": boolean, "reason": string | null}
Reject (approved false) only when the text clearly breaks one of these rules, with reason set to the rule's code:
- "contact_info": any way to contact the user outside the app — phone number (also written with spaces, words or mixed digits), Telegram/Instagram/WhatsApp/Snapchat username or ID (also obfuscated, e.g. "insta: ali_r", "آیدی تل", "پیج اینستام", "add me on ..."), @username, t.me or any link/URL, email address.
- "fake_name": ONLY for field "name". Not a plausible personal first name or nickname: a celebrity or fictional character name, a brand, "admin"/"support"/"test"/"bot", random letters or keyboard mash, a sentence, greeting or phrase ("سلام", "hi", "دنبال دوست"), or only emoji/symbols.
- "offensive": anything written to insult, hurt or upset other people: insults, swearing or profanity (including Persian slang and Finglish swear words); hate or mocking of any group, ethnicity, nationality, religion, gender or sexuality; threats, harassment or bullying; body-shaming; degrading or hateful statements about men or women in general; gore or glorified violence; promoting drugs; provocative political or religious statements aimed at offending others.
- "sexual": explicit sexual content, sexual solicitation or offering sexual services.
- "ad_or_spam": advertising, selling, money or crypto offers, channel/group/page promotion, paid services.
Allowed: ordinary Persian, Finglish or English first names and nicknames (e.g. "علی", "Sara", "ممد", "Ali Reza", "نازی", "Mamad"), a first name plus surname, names from any culture, a name with an emoji. Normal bios about hobbies, job, city, age, height, what they are looking for, jokes, poems and mild flirting are fine. Mentioning Instagram or Telegram without giving an ID is fine. Mild personal opinions, preferences ("no smokers please"), light jokes and normal mentions of religion or politics are fine.
If you are unsure, approve. When approved, reason is null.`

/**
 * Validates the model's JSON reply. Throws on non-JSON or a missing verdict (a
 * transient model failure: the caller fails open). A rejection blocks the
 * user's save, so an unknown reason — or fake_name outside the name field —
 * counts as approved.
 */
export function parseTextVerdict(content: string, field: TextField): TextVerdict {
  const parsed = JSON.parse(content) as Record<string, unknown> | null
  if (!parsed || typeof parsed !== 'object' || typeof parsed.approved !== 'boolean') {
    throw new Error('text_check_bad_reply')
  }
  const reason = parsed.reason
  if (parsed.approved || !(TEXT_REJECT_REASONS as readonly unknown[]).includes(reason)) {
    return { approved: true, reason: null }
  }
  if (reason === 'fake_name' && field !== 'name') return { approved: true, reason: null }
  return { approved: false, reason: reason as TextRejectReason }
}

type AiReview = TextVerdict & { promptTokens: number | null; completionTokens: number | null }

/** One DeepSeek call. Throws on network/API/parse failure or timeout. */
export async function askDeepSeekText(field: TextField, text: string): Promise<AiReview> {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set')

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
        { role: 'system', content: TEXT_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ field, text }) },
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
    ...parseTextVerdict(content, field),
    promptTokens: body.usage?.prompt_tokens ?? null,
    completionTokens: body.usage?.completion_tokens ?? null,
  }
}

function aiEnabled(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY) && process.env.TEXT_AI_CHECK !== 'off'
}

async function logVerdict(row: {
  user_id: string
  field: TextField
  text: string
  approved: boolean
  reason: string | null
  source: 'regex' | 'ai'
  prompt_tokens?: number | null
  completion_tokens?: number | null
}): Promise<void> {
  try {
    await sql`insert into profile_text_checks ${sql(row)}`
  } catch (error) {
    console.error('[moderation] profile_text_checks insert failed:', (error as Error).message)
  }
}

type Logger = { warn: (obj: object, msg: string) => void }

/**
 * Reviews one profile text value. Returns the verdict (approved when the check
 * was skipped or failed open). Throws ProfileTextLimitError when the user is out
 * of AI checks for today. Seed users are never checked.
 */
export async function checkProfileText(
  userId: string,
  field: TextField,
  rawText: string,
  log?: Logger,
): Promise<TextVerdict> {
  const text = rawText.trim()
  if (!text) return { approved: true, reason: null }

  const [user] = await sql<{ is_seed: boolean }[]>`select is_seed from users where id = ${userId}`.catch(() => [])
  if (user?.is_seed) return { approved: true, reason: null }

  if (regexFindsContactInfo(text)) {
    await logVerdict({ user_id: userId, field, text, approved: false, reason: 'contact_info', source: 'regex' })
    return { approved: false, reason: 'contact_info' }
  }

  if (!aiEnabled()) return { approved: true, reason: null }

  // Cache: this exact text was already reviewed by the model for this user+field.
  const [cached] = await sql<{ approved: boolean; reason: TextRejectReason | null }[]>`
    select approved, reason from profile_text_checks
    where user_id = ${userId} and field = ${field} and text = ${text} and source = 'ai'
    order by created_at desc limit 1`.catch(() => [])
  if (cached) return { approved: cached.approved, reason: cached.approved ? null : cached.reason }

  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from profile_text_checks
    where user_id = ${userId} and source = 'ai'
      and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'`.catch(() => [{ count: 0 }])
  if (count >= USER_DAILY_AI_LIMIT) throw new ProfileTextLimitError()

  if (!takeGlobalSlot()) {
    log?.warn({ userId, field }, 'profile text AI check skipped: global daily limit')
    return { approved: true, reason: null }
  }

  let review: AiReview
  try {
    review = await askDeepSeekText(field, text)
  } catch (err) {
    log?.warn({ err, userId, field }, 'profile text AI check failed (fail-open)')
    return { approved: true, reason: null }
  }

  await logVerdict({
    user_id: userId, field, text, approved: review.approved, reason: review.reason, source: 'ai',
    prompt_tokens: review.promptTokens, completion_tokens: review.completionTokens,
  })
  return { approved: review.approved, reason: review.reason }
}

export type TextCheckOutcome =
  | { ok: true }
  | { ok: false; status: 422; body: { error: 'profile_text_rejected'; field: TextField; reason: TextRejectReason } }
  | { ok: false; status: 429; body: { error: 'profile_text_check_limit' } }

/**
 * Checks several fields in parallel. A rejection (first in field order) wins
 * over the per-user limit; any other failure fails open.
 */
export async function checkProfileTexts(
  userId: string,
  values: Partial<Record<TextField, string>>,
  log?: Logger,
): Promise<TextCheckOutcome> {
  const fields = TEXT_FIELDS.filter((f) => typeof values[f] === 'string' && values[f]!.trim())
  const results = await Promise.allSettled(fields.map((f) => checkProfileText(userId, f, values[f]!, log)))

  for (let i = 0; i < fields.length; i++) {
    const r = results[i]
    if (r.status === 'fulfilled' && !r.value.approved && r.value.reason) {
      return { ok: false, status: 422, body: { error: 'profile_text_rejected', field: fields[i], reason: r.value.reason } }
    }
  }
  for (let i = 0; i < fields.length; i++) {
    const r = results[i]
    if (r.status === 'rejected') {
      if (r.reason instanceof ProfileTextLimitError) {
        return { ok: false, status: 429, body: { error: 'profile_text_check_limit' } }
      }
      log?.warn({ err: r.reason, userId, field: fields[i] }, 'profile text check errored (fail-open)')
    }
  }
  return { ok: true }
}
