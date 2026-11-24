import { sql } from '../db.js'

/**
 * "You have a new message request" signal. Published on `luma_request`; every
 * process LISTENs (listener.ts) and its hub writes `event: request` to the
 * recipient's local streams. Only an id — the client refetches GET /requests.
 */
export const REQUEST_CHANNEL = 'luma_request'

export interface RequestNotify {
  requestId: string
  /** The recipient — the only user told. */
  to: string
}

/** Parse a `luma_request` payload; null when malformed. */
export function parseRequestNotify(payload: string): RequestNotify | null {
  try {
    const p = JSON.parse(payload)
    if (!p || typeof p.requestId !== 'string' || typeof p.to !== 'string') return null
    return { requestId: p.requestId, to: p.to }
  } catch {
    return null
  }
}

export async function publishRequest(n: RequestNotify): Promise<void> {
  await sql`select pg_notify(${REQUEST_CHANNEL}, ${JSON.stringify(n)})`
}
