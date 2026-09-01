// Optional inline button attached to an admin-sent bot message (broadcast or
// single-user DM). Either a plain URL link, or a webApp button that opens the
// mini app on a specific tab.

export const BUTTON_SCREENS = ['discovery', 'likes', 'matches', 'profile'] as const
export type ButtonScreen = (typeof BUTTON_SCREENS)[number]

export type MessageButton =
  | { title: string; kind: 'url'; url: string }
  | { title: string; kind: 'screen'; screen: ButtonScreen }

const MAX_TITLE_LEN = 64

export type ValidateButtonResult =
  | { ok: true; button?: MessageButton }
  | { ok: false; error: string }

/**
 * Validate a raw `button` value from a request body.
 * - Absent / all-empty → ok with no button (caller sends no keyboard).
 * - Partially filled or malformed → { ok: false, error }.
 */
export function validateButton(raw: unknown): ValidateButtonResult {
  if (raw == null) return { ok: true }
  if (typeof raw !== 'object') return { ok: false, error: 'invalid_button' }

  const r = raw as Record<string, unknown>
  const title = typeof r.title === 'string' ? r.title.trim() : ''
  const kind = r.kind
  const url = typeof r.url === 'string' ? r.url.trim() : ''
  const screen = typeof r.screen === 'string' ? r.screen.trim() : ''

  // "If it was empty, don't show a button."
  if (!title && !url && !screen && kind == null) return { ok: true }

  if (!title) return { ok: false, error: 'button_title_required' }
  if (title.length > MAX_TITLE_LEN) return { ok: false, error: 'button_title_too_long' }

  if (kind === 'url') {
    if (!/^https?:\/\/.+/i.test(url)) return { ok: false, error: 'button_url_invalid' }
    return { ok: true, button: { title, kind: 'url', url } }
  }
  if (kind === 'screen') {
    if (!(BUTTON_SCREENS as readonly string[]).includes(screen)) {
      return { ok: false, error: 'button_screen_invalid' }
    }
    return { ok: true, button: { title, kind: 'screen', screen: screen as ButtonScreen } }
  }
  return { ok: false, error: 'button_kind_invalid' }
}
