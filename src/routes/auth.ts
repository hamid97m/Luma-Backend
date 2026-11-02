import { FastifyInstance, FastifyReply } from 'fastify'
import { verifyInitData, verifyTelegramWidget } from '../auth.js'
import { signIn, loadAuthUser, type Identity } from '../accounts.js'
import { signSessionToken } from '../session.js'
import { verifyGoogleIdToken } from '../googleAuth.js'

/** Website sign-in: the same account lookup as the Mini App, answered with a
 *  session token since the browser has no initData to resend. */
async function webSignIn(identity: Identity, reply: FastifyReply) {
  const result = await signIn(identity)
  if (!result.ok) return reply.status(result.status).send(result.body)
  return { token: signSessionToken(result.userId), user: result.user }
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/verify', async (req, reply) => {
    const body = req.body as { initData?: string }
    const { initData } = body
    if (typeof initData !== 'string' || !initData) {
      return reply.status(400).send({ error: 'missing_init_data' })
    }

    const tgUser = verifyInitData(initData, process.env.BOT_TOKEN ?? '')
    if (!tgUser) return reply.status(401).send({ error: 'invalid_init_data' })

    const startParam = new URLSearchParams(initData).get('start_param')
    const result = await signIn({ kind: 'telegram', tgUser, startParam })
    return result.ok ? { user: result.user } : reply.status(result.status).send(result.body)
  })

  // Telegram Login Widget payload: id, first_name, last_name?, username?,
  // photo_url?, auth_date, hash.
  app.post('/auth/telegram-web', async (req, reply) => {
    const body = req.body as Record<string, string | number> | null | undefined
    if (!body || typeof body !== 'object' || Array.isArray(body) || !body.hash) {
      return reply.status(400).send({ error: 'missing_telegram_login' })
    }

    const tgUser = verifyTelegramWidget(body, process.env.BOT_TOKEN ?? '')
    if (!tgUser) return reply.status(401).send({ error: 'invalid_telegram_login' })

    return webSignIn({ kind: 'telegram', tgUser }, reply)
  })

  // "Sign in with Google": `credential` is the ID token from Google Identity Services.
  app.post('/auth/google', async (req, reply) => {
    const credential = (req.body as { credential?: unknown } | null | undefined)?.credential
    if (typeof credential !== 'string' || !credential) {
      return reply.status(400).send({ error: 'missing_credential' })
    }

    const google = await verifyGoogleIdToken(credential)
    if (!google) return reply.status(401).send({ error: 'invalid_google_login' })

    return webSignIn({ kind: 'google', ...google }, reply)
  })

  // Website counterpart of initData 'dev_mode': sign in as the dev user from a
  // plain browser. Never registered in production.
  if (process.env.NODE_ENV !== 'production') {
    app.post('/auth/dev', async (_req, reply) =>
      webSignIn({ kind: 'telegram', tgUser: { id: 999999, first_name: 'Dev', username: 'devuser' } }, reply))
  }

  // Behind the auth preHandler (Bearer or initData), which already rejects
  // unknown, deleted, banned and paused accounts.
  app.get('/auth/me', async (req, reply) => {
    if (!req.userId) return reply.status(401).send({ error: 'unauthorized' })
    const user = await loadAuthUser(req.userId)
    if (!user) return reply.status(500).send({ error: 'auth_me_failed' })
    return { user }
  })
}
