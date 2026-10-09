import { tFor, type Locale } from '../i18n/index.js'

// The 12 profile icebreaker prompts, index-aligned across locales. Must match
// the frontend's `icebreakers[i].prompt` (frontend/src/locales/*.ts)
// byte-for-byte — users.icebreaker_prompt stores whichever one was picked.
export const ICEBREAKER_PROMPTS: Record<Locale, readonly string[]> = {
  fa: [
    'جمعه ایده‌آل من…',
    'دو حقیقت و یک دروغ…',
    'راه به‌دست‌آوردن دل من…',
    'چیزی که دیوانه‌وارش دوست دارم…',
    'قرار اول بی‌نقص…',
    'جنجالی‌ترین نظرم…',
    'با هم می‌سازیم اگر…',
    'صبح آرام یا برنامه فشرده؟',
    'مهارت عجیب‌وغریبم…',
    'سفری که می‌برمت…',
    'آخرین چیزی که به خنده‌ام انداخت…',
    'نشانه‌های مثبتی که دنبالشان هستم…',
  ],
  en: [
    'My ideal Friday…',
    'Two truths and a lie…',
    'The way to my heart…',
    "Something I'm crazy about…",
    'The perfect first date…',
    'My most controversial opinion…',
    "We'll get along if…",
    'Slow morning or packed schedule?',
    'My weirdest skill…',
    "The trip I'd take you on…",
    'The last thing that made me laugh…',
    "Green flags I'm looking for…",
  ],
  ar: [
    'يوم الجمعة المثالي بالنسبة لي…',
    'حقيقتان وكذبة…',
    'الطريق إلى قلبي…',
    'شيء أعشقه بجنون…',
    'الموعد الأول المثالي…',
    'أكثر آرائي إثارةً للجدل…',
    'سننسجم معًا إذا…',
    'صباح هادئ أم جدول مزدحم؟',
    'مهارتي الغريبة…',
    'الرحلة التي سآخذك إليها…',
    'آخر شيء أضحكني…',
    'العلامات الإيجابية التي أبحث عنها…',
  ],
}

const LISTS = Object.values(ICEBREAKER_PROMPTS)

/** Index of a stored prompt in any locale's list, or null for unknown/custom/blank. */
export function icebreakerIndex(prompt: string | null | undefined): number | null {
  const p = (prompt ?? '').trim()
  if (!p) return null
  for (const list of LISTS) {
    const idx = list.indexOf(p)
    if (idx !== -1) return idx
  }
  return null
}

/** The opening question for a prompt, in the viewer's locale (NULL → Persian). */
export function icebreakerQuestion(prompt: string | null | undefined, locale: Locale | null | undefined): string {
  const t = tFor(locale).icebreaker
  const idx = icebreakerIndex(prompt)
  return idx === null ? t.fallbackQuestion : t.questions[idx]
}
