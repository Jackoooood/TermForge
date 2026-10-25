import { QUICK_COMMAND_LIMITS } from '../constants/quickCommands'

const TEMPLATE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/

export type QuickCommandTemplateParseResult =
  | { ok: true; parameters: string[] }
  | { ok: false; message: string }

export type QuickCommandRenderResult =
  | { ok: true; text: string }
  | { ok: false; message: string }

export function hasDisallowedControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f
  })
}

/**
 * Templates are single-line commands with `{{identifier}}` placeholders. A
 * stray `{{` or `}}` is rejected instead of being sent as literal shell text,
 * so the rendered preview and the written command cannot silently diverge.
 */
export function parseQuickCommandTemplate(body: string): QuickCommandTemplateParseResult {
  if (body.trim().length === 0) {
    return { ok: false, message: '命令内容不能为空。' }
  }
  if (body.length > QUICK_COMMAND_LIMITS.maxBodyLength) {
    return {
      ok: false,
      message: `命令内容最多 ${QUICK_COMMAND_LIMITS.maxBodyLength} 个字符。`,
    }
  }
  if (hasDisallowedControlCharacters(body)) {
    return { ok: false, message: '命令内容必须为单行，且不能包含控制字符。' }
  }

  const parameters: string[] = []
  const seen = new Set<string>()
  let cursor = 0
  while (cursor < body.length) {
    const open = body.indexOf('{{', cursor)
    const strayClose = body.indexOf('}}', cursor)
    if (strayClose !== -1 && (open === -1 || strayClose < open)) {
      return { ok: false, message: '模板包含不配对的 "}}"，请改用 {{identifier}} 占位符。' }
    }
    if (open === -1) break

    const close = body.indexOf('}}', open + 2)
    if (close === -1) {
      return { ok: false, message: '模板包含未闭合的 "{{"，请改用 {{identifier}} 占位符。' }
    }
    const name = body.slice(open + 2, close)
    if (!TEMPLATE_IDENTIFIER.test(name)) {
      return {
        ok: false,
        message: '参数占位符必须使用 {{identifier}} 格式（字母或下划线开头，最多 32 位）。',
      }
    }
    if (!seen.has(name)) {
      if (parameters.length >= QUICK_COMMAND_LIMITS.maxParameters) {
        return {
          ok: false,
          message: `一条命令最多包含 ${QUICK_COMMAND_LIMITS.maxParameters} 个参数。`,
        }
      }
      seen.add(name)
      parameters.push(name)
    }
    cursor = close + 2
  }

  return { ok: true, parameters }
}

/**
 * Substitution is literal and single-pass: parameter values are never re-parsed
 * as templates, and there is no eval or local shell involved.
 */
export function renderQuickCommandTemplate(
  body: string,
  values: Record<string, string>,
): QuickCommandRenderResult {
  const parsed = parseQuickCommandTemplate(body)
  if (!parsed.ok) return parsed

  const resolved = new Map<string, string>()
  for (const name of parsed.parameters) {
    const raw = values[name]
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      return { ok: false, message: `请填写参数 ${name} 的值。` }
    }
    const value = raw.trim()
    if (value.length > QUICK_COMMAND_LIMITS.maxParameterValueLength) {
      return {
        ok: false,
        message: `参数 ${name} 最多 ${QUICK_COMMAND_LIMITS.maxParameterValueLength} 个字符。`,
      }
    }
    if (hasDisallowedControlCharacters(value)) {
      return { ok: false, message: `参数 ${name} 不能包含换行或控制字符。` }
    }
    resolved.set(name, value)
  }

  const text = body.replace(/\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/g, (_match, name: string) =>
    resolved.get(name) ?? '',
  )
  if (text.trim().length === 0) {
    return { ok: false, message: '替换参数后的命令为空。' }
  }
  if (text.length > QUICK_COMMAND_LIMITS.maxBodyLength) {
    return {
      ok: false,
      message: `替换参数后的命令最多 ${QUICK_COMMAND_LIMITS.maxBodyLength} 个字符。`,
    }
  }
  return { ok: true, text }
}
