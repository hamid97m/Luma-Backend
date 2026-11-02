import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { sql } from '../src/db.js'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('usage: pnpm -C backend seed:admin <username> <password>')
  process.exit(1)
}

const password_hash = await bcrypt.hash(password, 10)

try {
  await sql`
    insert into admins (username, password_hash)
    values (${username}, ${password_hash})
    on conflict (username) do update set password_hash = excluded.password_hash`
} catch (err) {
  console.error('seed failed:', (err as Error).message)
  await sql.end()
  process.exit(1)
}
await sql.end()
console.log(`admin '${username}' is ready`)
