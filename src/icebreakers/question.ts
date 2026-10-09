import type { Locale } from '../i18n/index.js'
import { icebreakerQuestion } from './catalog.js'

type IcebreakerOwner = { icebreaker_prompt?: string | null; icebreaker_answer?: string | null }

/** Same rule as the seeder: both a non-blank prompt and a non-blank answer. */
export function hasIcebreaker(owner: IcebreakerOwner | null | undefined): boolean {
  return !!owner?.icebreaker_prompt?.trim() && !!owner?.icebreaker_answer?.trim()
}

/** The owner's opening question in the viewer's locale, or null when nothing gets seeded for them. */
export function ownerQuestion(owner: IcebreakerOwner | null | undefined, locale: Locale | null | undefined): string | null {
  return hasIcebreaker(owner) ? icebreakerQuestion(owner!.icebreaker_prompt, locale) : null
}
