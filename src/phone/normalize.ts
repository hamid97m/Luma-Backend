const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'

// Allocated Iranian mobile prefixes: 0901-0905 (Irancell), 091x / 0990-0994 (MCI),
// 0920-0923 (Rightel), 093x (Irancell, Taliya, Kish MCI), 0941 (Irancell TD-LTE),
// 0995-0999 (Shatel, Samantel, MVNOs). Anything else isn't a mobile: no SMS spent.
const IRAN_MOBILE = /^09(?:0[1-5]|1\d|2[0-3]|3\d|41|9\d)\d{7}$/

// Spaces, dashes, parentheses, ZWNJ and LTR/RTL marks (pasted from Persian text).
const SEPARATORS = /[\s\-()‌‎‏]/g

/** An Iranian mobile in the stored form '09xxxxxxxxx', or null. Accepts
 *  Persian/Arabic digits, spaces/dashes/parentheses, and the 9…, +98…, 98…,
 *  0098… prefixes; only allocated mobile operator prefixes pass. */
export function normalizeIranMobile(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null
  let s = raw.replace(/[۰-۹٠-٩]/g, (d) => {
    const p = PERSIAN_DIGITS.indexOf(d)
    return String(p >= 0 ? p : ARABIC_DIGITS.indexOf(d))
  })
  s = s.replace(SEPARATORS, '')
  if (s.startsWith('+98')) s = '0' + s.slice(3)
  else if (s.startsWith('0098')) s = '0' + s.slice(4)
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2)
  else if (s.startsWith('9') && s.length === 10) s = '0' + s
  return IRAN_MOBILE.test(s) ? s : null
}
