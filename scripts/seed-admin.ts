import 'dotenv/config'
import { createClient } from '@supabase/supabase-js'
import bcrypt from 'bcryptjs'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('usage: pnpm -C backend seed:admin <username> <password>')
  process.exit(1)
}

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
const password_hash = await bcrypt.hash(password, 10)

const { error } = await db
  .from('admins')
  .upsert({ username, password_hash }, { onConflict: 'username' })

if (error) {
  console.error('seed failed:', error.message)
  process.exit(1)
}
console.log(`admin '${username}' is ready`)
