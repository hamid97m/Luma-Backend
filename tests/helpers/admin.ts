import { signAdminToken, hashPassword } from '../../src/routes/admin/auth-utils.js'
import { insertRow } from './db.js'

/** Sets ADMIN_JWT_SECRET and inserts a real admin row (needed where an admin id
 *  lands in an FK column, e.g. reports.resolved_by). Returns the row + headers. */
export async function createAdmin(username = 'root', password = 'hunter2') {
  process.env.ADMIN_JWT_SECRET ??= 'test-secret'
  const admin = await insertRow<{ id: string; username: string }>('admins', {
    username, password_hash: await hashPassword(password),
  })
  return { admin, headers: adminHeaders(admin.id, admin.username) }
}

/** Bearer header for the admin guard; the admin row need not exist. */
export function adminHeaders(adminId = '00000000-0000-0000-0000-00000000a001', username = 'root') {
  process.env.ADMIN_JWT_SECRET ??= 'test-secret'
  return { authorization: `Bearer ${signAdminToken({ adminId, username })}` }
}
