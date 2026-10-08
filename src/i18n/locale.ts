export type Locale = 'fa' | 'en' | 'ar'

export const LOCALES: readonly Locale[] = ['fa', 'en', 'ar']

export function isLocale(x: unknown): x is Locale {
  return typeof x === 'string' && (LOCALES as readonly string[]).includes(x)
}

/** Stored locale, or Persian when none is set. Same rule as `tFor`. */
export function effectiveLocale(locale: string | null | undefined): Locale {
  return isLocale(locale) ? locale : 'fa'
}

/** Telegram `language_code` (e.g. "fa", "fa-IR", "ar-SA", "en", "de") → app locale.
 * Anything that isn't Persian or Arabic falls back to English. */
export function mapTelegramLang(code: string | null | undefined): Locale {
  const base = (code ?? '').toLowerCase().split(/[-_]/)[0]
  if (base === 'fa') return 'fa'
  if (base === 'ar') return 'ar'
  return 'en'
}
