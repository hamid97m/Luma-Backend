import { vi } from 'vitest'
import { verifyInitData } from '../../src/auth.js'

/** Header the auth preHandler accepts once `verifyInitData` is mocked.
 *  Test files must `vi.mock('../src/auth.js', () => ({ verifyInitData: vi.fn() }))`. */
export const AUTH = { authorization: 'valid_init_data' }

/** Make the next requests authenticate as `user` (a real row from createUser). */
export function authAs(user: { telegram_id: number; name?: string }): void {
  vi.mocked(verifyInitData).mockReturnValue({ id: user.telegram_id, first_name: user.name ?? 'Test' } as any)
}
