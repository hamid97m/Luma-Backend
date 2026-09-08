import { db } from '../db.js'
import type { MessageButton } from '../messaging/messageButton.js'

export interface PurchaseMessageConfig {
  enabled: boolean
  kind: 'text' | 'forward'
  message: string | null
  sourceChatId: string | null
  sourceMessageId: number | null
  button: MessageButton | null
  activeSince: string | null
}

const COLS = 'enabled, kind, message, source_chat_id, source_message_id, button, active_since'

function serialize(row: any): PurchaseMessageConfig {
  return {
    enabled: !!row.enabled,
    kind: row.kind === 'forward' ? 'forward' : 'text',
    message: row.message ?? null,
    sourceChatId: row.source_chat_id ?? null,
    sourceMessageId: row.source_message_id ?? null,
    button: (row.button as MessageButton | null) ?? null,
    activeSince: row.active_since ?? null,
  }
}

/** Reads the purchase_message_config singleton. Never throws: a missing
 * table/row or any query error is treated as "not configured" (null), so the
 * job just no-ops rather than crashing the scheduler. */
export async function getPurchaseMessageConfig(dbClient: any = db): Promise<PurchaseMessageConfig | null> {
  try {
    const { data, error } = await dbClient
      .from('purchase_message_config')
      .select(COLS)
      .eq('id', true)
      .single()
    if (error || !data) return null
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
}

/** Updates the singleton. When `enabled` transitions false→true, stamps
 * `active_since = now` so the job ignores attempts made before the feature was
 * switched on (no back-catalog blast). Returns the resulting config, or null on
 * failure. `nowIso` is injectable for tests. */
export async function updatePurchaseMessageConfig(
  patch: PurchaseMessageConfigPatch,
  dbClient: any = db,
  nowIso: string = new Date().toISOString(),
): Promise<PurchaseMessageConfig | null> {
  try {
    const current = await getPurchaseMessageConfig(dbClient)
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
    if (patch.button !== undefined) updates.button = patch.button

    const { data, error } = await dbClient
      .from('purchase_message_config')
      .update(updates)
      .eq('id', true)
      .select(COLS)
      .single()
    if (error || !data) return null
    return serialize(data)
  } catch {
    return null
  }
}
