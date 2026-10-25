import { describe, expect, it } from 'vitest'
import {
  decodeRemoteText,
  encodeRemoteText,
  normalizeRemoteTextEol,
} from '../../src/shared/sftp/remoteText'

const encoder = new TextEncoder()

describe('decodeRemoteText', () => {
  it('decodes UTF-8 text and detects LF line endings', () => {
    expect(decodeRemoteText(encoder.encode('alpha\nbeta\n'))).toEqual({
      ok: true,
      value: { content: 'alpha\nbeta\n', encoding: 'utf-8', eol: 'lf' },
    })
  })

  it('strips a UTF-8 BOM and keeps the encoding flag', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('echo hi\r\n')])
    expect(decodeRemoteText(bytes)).toEqual({
      ok: true,
      value: { content: 'echo hi\r\n', encoding: 'utf-8-bom', eol: 'crlf' },
    })
  })

  it('detects CRLF line endings', () => {
    expect(decodeRemoteText(encoder.encode('one\r\ntwo\r\n'))).toMatchObject({
      ok: true,
      value: { eol: 'crlf' },
    })
  })

  it('rejects UTF-16 byte order marks', () => {
    expect(decodeRemoteText(new Uint8Array([0xff, 0xfe, 0x41, 0x00]))).toEqual({
      ok: false,
      reason: 'unsupported-encoding',
    })
    expect(decodeRemoteText(new Uint8Array([0xfe, 0xff, 0x00, 0x41]))).toEqual({
      ok: false,
      reason: 'unsupported-encoding',
    })
  })

  it('rejects NUL bytes as binary content', () => {
    expect(decodeRemoteText(new Uint8Array([0x61, 0x00, 0x62]))).toEqual({
      ok: false,
      reason: 'binary',
    })
  })

  it('rejects invalid UTF-8 sequences', () => {
    expect(decodeRemoteText(new Uint8Array([0x61, 0x80, 0x62]))).toEqual({
      ok: false,
      reason: 'invalid-utf8',
    })
  })
})

describe('encodeRemoteText', () => {
  it('normalizes mixed line endings to the stored EOL', () => {
    expect(normalizeRemoteTextEol('a\r\nb\rc\nd', 'lf')).toBe('a\nb\nc\nd')
    expect(normalizeRemoteTextEol('a\r\nb\rc\nd', 'crlf')).toBe('a\r\nb\r\nc\r\nd')
  })

  it('adds a UTF-8 BOM when the file used one', () => {
    const bytes = encodeRemoteText('one\ntwo\n', 'utf-8-bom', 'crlf')
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder('utf-8').decode(bytes)).toBe('one\r\ntwo\r\n')
  })

  it('round-trips through decodeRemoteText', () => {
    const bytes = encodeRemoteText('first\r\nsecond\r\n', 'utf-8', 'crlf')
    expect(decodeRemoteText(bytes)).toEqual({
      ok: true,
      value: { content: 'first\r\nsecond\r\n', encoding: 'utf-8', eol: 'crlf' },
    })
  })
})
