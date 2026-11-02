import { OAuth2Client } from 'google-auth-library'

const client = new OAuth2Client()

/** The Google identity inside a valid "Sign in with Google" ID token; null if
 *  the token is invalid, meant for another app, or the email is unverified. */
export async function verifyGoogleIdToken(
  idToken: string,
): Promise<{ sub: string; email: string; givenName: string } | null> {
  const audience = (process.env.GOOGLE_CLIENT_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  // Without an audience the library would accept tokens issued to any app.
  if (audience.length === 0) return null

  let payload
  try {
    payload = (await client.verifyIdToken({ idToken, audience })).getPayload()
  } catch {
    return null
  }
  if (!payload?.sub || !payload.email || payload.email_verified !== true) return null

  const givenName = payload.given_name || payload.name || payload.email.split('@')[0]
  return { sub: payload.sub, email: payload.email, givenName }
}
