import { fa } from './fa.js'
import { en } from './en.js'
import { ar } from './ar.js'
import type { Locale } from './locale.js'

export type Messages = typeof fa

const messages: Record<Locale, Messages> = { fa, en, ar }

/** Messages for a user's locale. NULL/undefined (users backfilled by the
 * migration, or any row created before the picker shipped) → Persian. */
export function tFor(locale: Locale | null | undefined): Messages {
  return messages[locale ?? 'fa']
}
export { isLocale, mapTelegramLang, LOCALES, type Locale } from './locale.js'
