import { describe, expect, it } from 'vitest'
import { utf8ByteLength } from './utf8'

describe('shared UTF-8 byte length', () => {
  it.each(['', 'plain ASCII', 'áñ', '😀', '\u0000\r\n', '\ud800', '\udc00', '😀'.repeat(50), '😀'.repeat(51), 'é'.repeat(16384)])(
    'matches native encoding for case %#', value => {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength)
    },
  )
  it('keeps measurements independent across repeated calls', () => {
    expect(utf8ByteLength('😀'.repeat(50))).toBe(200)
    expect(utf8ByteLength('plain')).toBe(5)
    expect(utf8ByteLength('😀'.repeat(50))).toBe(200)
  })
})
