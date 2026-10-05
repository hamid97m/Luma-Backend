import { describe, it, expect, vi } from 'vitest'
vi.mock('../src/db.js', () => ({ db: { from: vi.fn() } }))
import { resolvePurchaseMessage, type PurchaseMessageConfig } from '../src/jobs/purchaseMessageConfig.js'

const cfg: PurchaseMessageConfig = {
  enabled: true, kind: 'text', message: 'پیام فارسی', sourceChatId: null, sourceMessageId: null,
  button: { kind: 'screen', screen: 'plans', title: 'طرح‌ها' } as any, activeSince: null,
  translations: { en: { message: 'English message', buttonTitle: 'Plans' }, ar: { message: '  ' } },
}

describe('resolvePurchaseMessage', () => {
  it('fa/null → base text and button', () => {
    expect(resolvePurchaseMessage(cfg, null)).toEqual({ text: 'پیام فارسی', button: cfg.button })
    expect(resolvePurchaseMessage(cfg, 'fa')).toEqual({ text: 'پیام فارسی', button: cfg.button })
  })
  it('en → translated text and button title', () => {
    expect(resolvePurchaseMessage(cfg, 'en')).toEqual({ text: 'English message', button: { ...cfg.button, title: 'Plans' } })
  })
  it('blank translation falls back to base', () => {
    expect(resolvePurchaseMessage(cfg, 'ar')).toEqual({ text: 'پیام فارسی', button: cfg.button })
  })
  it('no button stays null', () => {
    expect(resolvePurchaseMessage({ ...cfg, button: null }, 'en').button).toBeNull()
  })
})
