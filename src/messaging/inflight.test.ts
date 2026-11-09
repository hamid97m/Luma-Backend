import { describe, it, expect } from 'vitest'
import { trackMessageWork, settleMessageWork } from './inflight.js'

describe('in-flight message notification work', () => {
  it('settleMessageWork waits for tracked work, including work started while waiting, and swallows errors', async () => {
    const done: string[] = []
    trackMessageWork(new Promise<void>((r) => setTimeout(() => {
      done.push('a')
      trackMessageWork(new Promise<void>((r2) => setTimeout(() => { done.push('b'); r2() }, 10)))
      r()
    }, 10)))
    trackMessageWork(Promise.reject(new Error('x')))
    await settleMessageWork()
    expect(done).toEqual(['a', 'b'])
  })

  it('returns the promise it was given', () => {
    const p = Promise.resolve(1)
    expect(trackMessageWork(p)).toBe(p)
  })
})
