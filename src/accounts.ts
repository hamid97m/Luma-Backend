import { sql } from './db.js'
import { getBotUsername } from './bot.js'
import { getProfileWithPhotos } from './routes/profile.js'
import { captureReferralAttribution } from './referrals/attribution.js'
import type { TelegramUser } from './types.js'

export type Identity =
  | { kind: 'telegram'; tgUser: TelegramUser; startParam?: string | null }
  | { kind: 'google'; sub: string; email: string; givenName: string }

type ProfileWithPhotos = NonNullable<Awaited<ReturnType<typeof getProfileWithPhotos>>>

export type AuthUser = { id: string; name: string; setupComplete: boolean; locale: string | null } | ProfileWithPhotos

export type SignInResult =
  | { ok: true; userId: string; user: AuthUser }
  | { ok: false; status: 401 | 500; body: { error: string; botUsername?: string | null } }

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

type AccountRow = {
  id: string; name: string; age: number; gender: string; looking_for: string
  bio: string | null; deleted_at: string | null; banned_at: string | null; locale: string | null
}

/** The sign-in response for a known user: the full profile once setup is done
 *  (so the splash screen skips a /profile/me round trip), else the short form. */
async function buildAuthUser(row: Pick<AccountRow, 'id' | 'name' | 'age' | 'locale'>): Promise<AuthUser> {
  const setupComplete = row.age > 0
  if (setupComplete) {
    const fullProfile = await getProfileWithPhotos(row.id)
    if (fullProfile) return fullProfile
  }
  // null = the user has never picked a language; the client shows the
  // first-open picker. Never default to 'fa' here.
  return { id: row.id, name: row.name, setupComplete, locale: row.locale ?? null }
}

/** The sign-in response shape for an existing user; null when not found. */
export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  let row: Pick<AccountRow, 'id' | 'name' | 'age' | 'locale'> | undefined
  try {
    ;[row] = await sql<Pick<AccountRow, 'id' | 'name' | 'age' | 'locale'>[]>`
      select id, name, age, locale from users where id = ${userId}`
  } catch {
    return null
  }
  return row ? buildAuthUser(row) : null
}

/** Find the account for an identity. A failed lookup is treated as "no such
 *  user" (the insert then fails on the unique identity and answers 500) — kept
 *  from the original /auth/verify. `attach` holds identity columns to write
 *  onto the matched row (a Google sub on an account found by email). */
async function findAccount(identity: Identity): Promise<{ row?: AccountRow; attach: Record<string, unknown> }> {
  try {
    if (identity.kind === 'telegram') {
      const [row] = await sql<AccountRow[]>`
        select id, name, age, gender, looking_for, bio, deleted_at, banned_at, locale
        from users where telegram_id = ${identity.tgUser.id}`
      return { row, attach: {} }
    }
    const [bySub] = await sql<AccountRow[]>`
      select id, name, age, gender, looking_for, bio, deleted_at, banned_at, locale
      from users where google_sub = ${identity.sub}`
    if (bySub) return { row: bySub, attach: {} }
    const [byEmail] = await sql<AccountRow[]>`
      select id, name, age, gender, looking_for, bio, deleted_at, banned_at, locale
      from users where email = ${normalizeEmail(identity.email)}`
    return { row: byEmail, attach: byEmail ? { google_sub: identity.sub } : {} }
  } catch {
    return { attach: {} }
  }
}

function newAccountColumns(identity: Identity): Record<string, unknown> {
  if (identity.kind === 'telegram') {
    return {
      telegram_id: identity.tgUser.id,
      username: identity.tgUser.username ?? null,
      name: identity.tgUser.first_name,
    }
  }
  return { email: normalizeEmail(identity.email), google_sub: identity.sub, name: identity.givenName }
}

/** Find-or-create the account behind a verified identity and build the
 *  sign-in response. Shared by every login method. */
export async function signIn(identity: Identity): Promise<SignInResult> {
  // Only write the flag when Telegram actually sent it — old clients omit
  // the field entirely, and that absence must not wipe a known value.
  const writeAccess =
    identity.kind === 'telegram' && typeof identity.tgUser.allows_write_to_pm === 'boolean'
      ? { allows_write_to_pm: identity.tgUser.allows_write_to_pm }
      : {}

  const { row: existing, attach } = await findAccount(identity)

  if (existing?.banned_at) {
    // botUsername lets the Blocked screen deep-link into the support bot chat.
    return { ok: false, status: 401, body: { error: 'account_banned', botUsername: getBotUsername() } }
  }

  if (existing) {
    const reactivating = Boolean(existing.deleted_at)
    try {
      await sql`
        update users set ${sql({
          last_active: new Date().toISOString(),
          ...writeAccess,
          ...attach,
          ...(reactivating ? { deleted_at: null, is_active: true } : {}),
        })}
        where id = ${existing.id}`
    } catch {
      return { ok: false, status: 500, body: { error: 'auth_update_failed' } }
    }
    return { ok: true, userId: existing.id, user: await buildAuthUser(existing) }
  }

  let created: { id: string; name: string } | undefined
  try {
    ;[created] = await sql<{ id: string; name: string }[]>`
      insert into users ${sql({
        ...newAccountColumns(identity),
        ...writeAccess,
        // age, gender, looking_for will be set during profile setup
        age: 0,
        gender: 'man',
        looking_for: 'women',
      })}
      returning id, name`
  } catch {
    created = undefined
  }

  if (!created) return { ok: false, status: 500, body: { error: 'user_creation_failed' } }

  if (identity.kind === 'telegram') {
    await captureReferralAttribution(created.id, identity.tgUser.id, identity.startParam ?? null)
  }

  return { ok: true, userId: created.id, user: await buildAuthUser({ ...created, age: 0, locale: null }) }
}
