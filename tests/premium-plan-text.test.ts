import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
vi.mock('../src/bot.js', () => ({}))
import { planText } from '../src/premium/service.js'

const plan = {
  title: 'یک ماهه', description: 'شروع خوب',
  translations: { en: { title: '1 Month', description: 'Good start' }, ar: { title: 'شهر واحد', description: '' } },
}

describe('planText', () => {
  it('returns the Persian base for fa and null', () => {
    expect(planText(plan, 'fa')).toEqual({ title: 'یک ماهه', description: 'شروع خوب' })
    expect(planText(plan, null)).toEqual({ title: 'یک ماهه', description: 'شروع خوب' })
  })
  it('returns the translation when present', () => {
    expect(planText(plan, 'en')).toEqual({ title: '1 Month', description: 'Good start' })
  })
  it('falls back field-by-field on blank or missing translation', () => {
    expect(planText(plan, 'ar')).toEqual({ title: 'شهر واحد', description: 'شروع خوب' })
    expect(planText({ ...plan, translations: { en: { title: '   ' } } }, 'en')).toEqual({ title: 'یک ماهه', description: 'شروع خوب' })
    expect(planText({ ...plan, translations: {} }, 'en')).toEqual({ title: 'یک ماهه', description: 'شروع خوب' })
    expect(planText({ ...plan, translations: null }, 'en')).toEqual({ title: 'یک ماهه', description: 'شروع خوب' })
    expect(planText({ title: 'یک ماهه', description: 'شروع خوب' }, 'ar')).toEqual({ title: 'یک ماهه', description: 'شروع خوب' })
  })
})
