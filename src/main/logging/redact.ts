const REDACTED = '[REDACTED]'
const MAX_STRING_LENGTH = 2_048
const MAX_ARRAY_LENGTH = 100
const MAX_DEPTH = 6

const SENSITIVE_KEY_PARTS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'privatekey',
  'apikey',
  'credential',
  'cookie',
  'authorization',
  'terminalinput',
  'terminaloutput',
]

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key)
  if (normalized === 'auth' || normalized === 'input' || normalized === 'output') return true
  if (normalized.startsWith('key') && normalized.includes('private')) return true
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part))
}

const PEM_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi

/**
 * Applies conservative text redaction. This is a second line of defence: the
 * logger API accepts structured metadata and callers must never deliberately
 * pass terminal input, file contents or credentials.
 */
export function redactText(input: string): string {
  let text = input
    .replace(PEM_PRIVATE_KEY, '[REDACTED PRIVATE KEY]')
    .replace(
      /\b(password|passwd|passphrase|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
      '$1=[REDACTED]',
    )
    .replace(/\bAuthorization\s*:\s*[^\r\n]+/gi, 'Authorization: [REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')

  if (text.length > MAX_STRING_LENGTH) {
    text = `${text.slice(0, MAX_STRING_LENGTH)}…[truncated]`
  }
  return text
}

function sanitizeError(error: Error, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    name: redactText(error.name),
    message: redactText(error.message),
  }
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' || typeof code === 'number') result.code = code
  if (error.stack) result.stack = redactText(error.stack)
  seen.add(error)
  const cause = (error as { cause?: unknown }).cause
  if (cause !== undefined) result.cause = redactValue(cause, seen, 1)
  return result
}

function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'function' || typeof value === 'symbol') return '[unsupported]'
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Error) return sanitizeError(value, seen)
  if (depth >= MAX_DEPTH) return '[max-depth]'
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => redactValue(item, seen, depth + 1))
      .concat(value.length > MAX_ARRAY_LENGTH ? ['[truncated]'] : [])
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        output[key] = REDACTED
        continue
      }
      output[key] = redactValue(item, seen, depth + 1)
    }
    return output
  }
  return '[unsupported]'
}

/** Deep-clones a diagnostic value, redacting secret-bearing keys and text. */
export function redactForLog(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>(), 0)
}
