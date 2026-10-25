/**
 * Remote text files are edited in-memory by the renderer. The main process
 * enforces this hard byte cap so a single editor load cannot exhaust memory.
 */
export const MAX_REMOTE_TEXT_FILE_BYTES = 2 * 1024 * 1024

export type RemoteTextEncoding = 'utf-8' | 'utf-8-bom'
export type RemoteTextEol = 'lf' | 'crlf'
export type RemoteTextDecodeFailure = 'binary' | 'unsupported-encoding' | 'invalid-utf8'

export interface DecodedRemoteText {
  content: string
  encoding: RemoteTextEncoding
  eol: RemoteTextEol
}

export type RemoteTextDecodeResult =
  { ok: true; value: DecodedRemoteText } | { ok: false; reason: RemoteTextDecodeFailure }

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const

function hasUtf16Bom(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false
  const first = bytes[0]
  const second = bytes[1]
  return (first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  )
}

function detectEol(content: string): RemoteTextEol {
  const newlineIndex = content.indexOf('\n')
  return newlineIndex > 0 && content.charCodeAt(newlineIndex - 1) === 13 ? 'crlf' : 'lf'
}

export function decodeRemoteText(bytes: Uint8Array): RemoteTextDecodeResult {
  if (hasUtf16Bom(bytes)) return { ok: false, reason: 'unsupported-encoding' }
  if (bytes.includes(0)) return { ok: false, reason: 'binary' }

  const encoding: RemoteTextEncoding = hasUtf8Bom(bytes) ? 'utf-8-bom' : 'utf-8'
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return { ok: false, reason: 'invalid-utf8' }
  }
  // TextDecoder strips a leading BOM, but be explicit for runtimes that keep it.
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1)

  return { ok: true, value: { content, encoding, eol: detectEol(content) } }
}

export function normalizeRemoteTextEol(content: string, eol: RemoteTextEol): string {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  return eol === 'crlf' ? normalized.replace(/\n/g, '\r\n') : normalized
}

export function encodeRemoteText(
  content: string,
  encoding: RemoteTextEncoding,
  eol: RemoteTextEol,
): Uint8Array {
  const normalized = normalizeRemoteTextEol(content, eol)
  const text = encoding === 'utf-8-bom' ? `\uFEFF${normalized}` : normalized
  return new TextEncoder().encode(text)
}
