export interface FakeChatUser {
  id: string
  name: string
  is_seed: boolean
  telegram_id: number | null
  last_active: string | null
  notified_offline_at: string | null
  allows_write_to_pm: boolean | null
}

/**
 * Decide which participant an admin acts *as*. The seed (fake) user is the
 * sender; the other participant is the recipient. Returns null when there is
 * no seed participant (admin can only send as a fake). When both are seeds
 * (never happens in practice), user1 is the sender.
 */
export function pickFakeSender(
  u1: FakeChatUser,
  u2: FakeChatUser,
): { fake: FakeChatUser; recipient: FakeChatUser } | null {
  if (u1.is_seed) return { fake: u1, recipient: u2 }
  if (u2.is_seed) return { fake: u2, recipient: u1 }
  return null
}
