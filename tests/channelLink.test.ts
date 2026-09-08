import { describe, it, expect } from 'vitest'
import { parseChannelMessageLink } from '../src/messaging/channelLink.js'

describe('parseChannelMessageLink', () => {
  it('parses a public channel message link', () => {
    expect(parseChannelMessageLink('https://t.me/mychannel/123')).toEqual({
      chatId: '@mychannel', messageId: 123,
    })
  })

  it('parses a public link without a scheme', () => {
    expect(parseChannelMessageLink('t.me/mychannel/123')).toEqual({
      chatId: '@mychannel', messageId: 123,
    })
  })

  it('parses a private channel link to a -100 id', () => {
    expect(parseChannelMessageLink('https://t.me/c/1500000000/45')).toEqual({
      chatId: '-1001500000000', messageId: 45,
    })
  })

  it('uses the last path segment as the message id for threaded links', () => {
    expect(parseChannelMessageLink('https://t.me/mychannel/45/678')).toEqual({
      chatId: '@mychannel', messageId: 678,
    })
    expect(parseChannelMessageLink('https://t.me/c/1500000000/45/678')).toEqual({
      chatId: '-1001500000000', messageId: 678,
    })
  })

  it('trims surrounding whitespace', () => {
    expect(parseChannelMessageLink('  https://t.me/mychannel/9  ')).toEqual({
      chatId: '@mychannel', messageId: 9,
    })
  })

  it('rejects non-telegram hosts', () => {
    expect(parseChannelMessageLink('https://example.com/mychannel/1')).toBeNull()
  })

  it('rejects invite / join links (no message id)', () => {
    expect(parseChannelMessageLink('https://t.me/+AbCdEf')).toBeNull()
    expect(parseChannelMessageLink('https://t.me/joinchat/AbCdEf')).toBeNull()
  })

  it('rejects a channel link with no message id', () => {
    expect(parseChannelMessageLink('https://t.me/mychannel')).toBeNull()
  })

  it('rejects a non-numeric message id', () => {
    expect(parseChannelMessageLink('https://t.me/mychannel/abc')).toBeNull()
  })

  it('rejects a private link missing the message id', () => {
    expect(parseChannelMessageLink('https://t.me/c/1500000000')).toBeNull()
  })

  it('rejects empty / junk input', () => {
    expect(parseChannelMessageLink('')).toBeNull()
    expect(parseChannelMessageLink('   ')).toBeNull()
    expect(parseChannelMessageLink('not a url')).toBeNull()
  })
})
