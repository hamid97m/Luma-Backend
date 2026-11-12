const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹'
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩'

/** An Iranian mobile in the stored form '09xxxxxxxxx', or null. Accepts
 *  Persian/Arabic digits, spaces/dashes/parentheses, and the 9…, +98…, 98…,
 *  0098… prefixes. */
export function normalizeIranMobile(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null
  let s = raw.replace(/[۰-۹٠-٩]/g, (d) => {
    const p = PERSIAN_DIGITS.indexOf(d)
    return String(p >= 0 ? p : ARABIC_DIGITS.indexOf(d))
  })
  s = s.replace(/[\s\-()‌‎‏]/g, '')
  if (s.startsWith('+98')) s = '0' + s.slice(3)
  else if (s.startsWith('0098')) s = '0' + s.slice(4)
  else if (s.startsWith('98') && s.length === 12) s = '0' + s.slice(2)
  else if (s.startsWith('9') && s.length === 10) s = '0' + s
  return /^09\d{9}$/.test(s) ? s : null
}
