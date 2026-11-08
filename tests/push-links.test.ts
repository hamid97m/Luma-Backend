import { describe, it, expect, afterEach } from 'vitest'
import { appLink, linkFields, linkFromButton } from '../src/push/links.js'

const orig = process.env.WEB_URL
afterEach(() => { process.env.WEB_URL = orig })

describe('push links', () => {
  it('appLink matches the bot URLs with and without trailing slash', () => {
    process.env.WEB_URL = 'https://app.test/'
    expect(appLink({ screen: 'matches', chat: 'abc' })).toBe('https://app.test/?screen=matches&chat=abc')
    process.env.WEB_URL = 'https://app.test'
    expect(appLink({ screen: 'matches', chat: 'abc' })).toBe('https://app.test/?screen=matches&chat=abc')
  })

  it('no opts gives WEB_URL unchanged', () => {
    process.env.WEB_URL = 'https://app.test/'
    expect(appLink()).toBe('https://app.test/')
    expect(linkFields()).toEqual({ link: 'https://app.test/' })
  })

  it('linkFields carries screen and chatId', () => {
    process.env.WEB_URL = 'https://app.test/'
    expect(linkFields({ screen: 'matches', chat: 'c1' })).toEqual({
      link: 'https://app.test/?screen=matches&chat=c1', screen: 'matches', chatId: 'c1',
    })
  })

  it('linkFromButton', () => {
    process.env.WEB_URL = 'https://app.test/'
    expect(linkFromButton({ kind: 'url', title: 'x', url: 'https://e.com' })).toEqual({ link: 'https://app.test/', url: 'https://e.com' })
    expect(linkFromButton({ kind: 'screen', title: 'x', screen: 'likes' })).toEqual({ link: 'https://app.test/?screen=likes', screen: 'likes' })
    expect(linkFromButton()).toEqual({ link: 'https://app.test/' })
  })
})
