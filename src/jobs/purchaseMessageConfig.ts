import { sql } from '../db.js'
import type { MessageButton } from '../messaging/messageButton.js'
import type { Locale } from '../i18n/index.js'

/** Per-language copy for the text kind. Persian is the base `message`/`button.title`;
 * `fa` is never a key here. */
export type PurchaseMessageTranslations = Partial<Record<'en' | 'ar', { message?: string; buttonTitle?: string }>>

export interface PurchaseMessageConfig {
  enabled: boolean
  kind: 'text' | 'forward'
  message: string | null
  sourceChatId: string | null
  sourceMessageId: number | null
  button: MessageButton | null
  activeSince: string | null
  translations: PurchaseMessageTranslations
}

function serialize(row: any): PurchaseMessageConfig {
  return {
    enabled: !!row.enabled,
    kind: row.kind === 'forward' ? 'forward' : 'text',
    message: row.message ?? null,
    sourceChatId: row.source_chat_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
    button: (row.button as MessageButton | null) ?? null,
    activeSince: row.active_since ?? null,
    translations: (row.translations as PurchaseMessageTranslations | null) ?? {},
  }
}

/** Text + button for a recipient's locale (text kind only). Persian base is
 * the fallback; blank translations fall back field-by-field. */
export function resolvePurchaseMessage(
  cfg: PurchaseMessageConfig, locale: Locale | null,
): { text: string; button: MessageButton | null } {
  const tr = locale && locale !== 'fa' ? cfg.translations?.[locale] : undefined
  const text = tr?.message?.trim() || (cfg.message ?? '').trim()
  const title = tr?.buttonTitle?.trim()
  const button = cfg.button ? (title ? { ...cfg.button, title } : cfg.button) : null
  return { text, button }
}

/** Reads the purchase_message_config singleton. Never throws: a missing
 * table/row or any query error is treated as "not configured" (null), so the
 * job just no-ops rather than crashing the scheduler. `_dbClient` is a legacy
 * parameter (callers used to pass a DB client in) and is ignored. */
export async function getPurchaseMessageConfig(_dbClient?: unknown): Promise<PurchaseMessageConfig | null> {
  try {
    const [data] = await sql`
      select enabled, kind, message, source_chat_id, source_message_id, button, active_since, translations
      from purchase_message_config where id = true`
    if (!data) return null
    return serialize(data)
  } catch {
    return null
  }
}

export interface PurchaseMessageConfigPatch {
  enabled?: boolean
  kind?: 'text' | 'forward'
  message?: string | null
  sourceChatId?: string | null
  sourceMessageId?: number | null
  button?: MessageButton | null
  translations?: PurchaseMessageTranslations
}

/** Updates the singleton. When `enabled` transitions false→true, stamps
 * `active_since = now` so the job ignores attempts made before the feature was
 * switched on (no back-catalog blast). Returns the resulting config, or null on
 * failure. `nowIso` is injectable for tests; `_dbClient` is ignored (legacy). */
export async function updatePurchaseMessageConfig(
  patch: PurchaseMessageConfigPatch,
  _dbClient?: unknown,
  nowIso: string = new Date().toISOString(),
): Promise<PurchaseMessageConfig | null> {
  try {
    const current = await getPurchaseMessageConfig()
    const updates: Record<string, unknown> = { updated_at: nowIso }

    if (patch.enabled !== undefined) {
      updates.enabled = patch.enabled
      // Stamp the cutoff only on an off→on flip; leave it alone otherwise so
      // re-saving an already-enabled message doesn't move the window forward.
      if (patch.enabled && !current?.enabled) updates.active_since = nowIso
    }
    if (patch.kind !== undefined) updates.kind = patch.kind
    if (patch.message !== undefined) updates.message = patch.message
    if (patch.sourceChatId !== undefined) updates.source_chat_id = patch.sourceChatId
    if (patch.sourceMessageId !== undefined) updates.source_message_id = patch.sourceMessageId
    // jsonb columns: wrap objects with sql.json (postgres.js doesn't infer jsonb).
    if (patch.button !== undefined) updates.button = patch.button === null ? null : sql.json(patch.button as never)
    if (patch.translations !== undefined) updates.translations = sql.json(patch.translations as never)

    const [data] = await sql`
      update purchase_message_config set ${sql(updates)}
      where id = true
      returning enabled, kind, message, source_chat_id, source_message_id, button, active_since, translations`
    if (!data) return null
    return serialize(data)
  } catch {
    return null
  }
}
