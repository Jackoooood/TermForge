// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { QUICK_COMMAND_LIMITS } from '@shared/constants/quickCommands'
import { BUILT_IN_QUICK_COMMANDS } from '@shared/quickCommands/builtIns'
import {
  parseQuickCommandTemplate,
  renderQuickCommandTemplate,
} from '@shared/quickCommands/template'

describe('quick command template', () => {
  it('extracts unique parameters in first-seen order', () => {
    expect(parseQuickCommandTemplate('tail -n {{lines}} {{path}} | grep {{pattern}} {{path}}')).toEqual({
      ok: true,
      parameters: ['lines', 'path', 'pattern'],
    })
  })

  it('rejects malformed placeholders and control characters', () => {
    expect(parseQuickCommandTemplate('echo {{bad name}}').ok).toBe(false)
    expect(parseQuickCommandTemplate('echo {{name').ok).toBe(false)
    expect(parseQuickCommandTemplate('echo name}}').ok).toBe(false)
    expect(parseQuickCommandTemplate('echo ok\nrm -rf /').ok).toBe(false)
    expect(parseQuickCommandTemplate('   ').ok).toBe(false)
  })

  it('rejects more than the supported number of parameters', () => {
    const body = Array.from(
      { length: QUICK_COMMAND_LIMITS.maxParameters + 1 },
      (_, index) => `{{p${index}}}`,
    ).join(' ')
    expect(parseQuickCommandTemplate(body).ok).toBe(false)
  })

  it('substitutes values literally in a single pass', () => {
    const rendered = renderQuickCommandTemplate('printf %s {{value}} {{path}}', {
      value: '$&$`{{path}}',
      path: '/var/log/app.log',
    })
    expect(rendered).toEqual({
      ok: true,
      text: 'printf %s $&$`{{path}} /var/log/app.log',
    })
  })

  it('rejects missing, blank and malformed values', () => {
    expect(renderQuickCommandTemplate('echo {{value}}', {}).ok).toBe(false)
    expect(renderQuickCommandTemplate('echo {{value}}', { value: '   ' }).ok).toBe(false)
    expect(renderQuickCommandTemplate('echo {{value}}', { value: 'a\nb' }).ok).toBe(false)
    expect(
      renderQuickCommandTemplate('echo {{value}}', {
        value: 'x'.repeat(QUICK_COMMAND_LIMITS.maxParameterValueLength + 1),
      }).ok,
    ).toBe(false)
  })

  it('trims values and refuses rendered commands that exceed the limit', () => {
    expect(renderQuickCommandTemplate('echo {{value}}', { value: '  hello  ' })).toEqual({
      ok: true,
      text: 'echo hello',
    })

    const body = `${'a'.repeat(QUICK_COMMAND_LIMITS.maxBodyLength - 6)} {{value}}`
    const rendered = renderQuickCommandTemplate(body, {
      value: 'x'.repeat(QUICK_COMMAND_LIMITS.maxParameterValueLength),
    })
    expect(rendered.ok).toBe(false)
  })

  it('keeps every built-in command read-only and parseable', () => {
    const ids = new Set<string>()
    for (const command of BUILT_IN_QUICK_COMMANDS) {
      expect(command.id).toMatch(/^builtin-[a-z0-9-]+$/)
      expect(ids.has(command.id)).toBe(false)
      ids.add(command.id)
      expect(parseQuickCommandTemplate(command.body).ok).toBe(true)
      expect(command.body).not.toMatch(
        /\b(?:restart|stop|start|reload|reboot|shutdown|kill|pkill|killall|rm|rmdir|mv|chmod|chown|mkfs|dd|truncate|shutdown)\b/,
      )
      expect(command.body).not.toMatch(/systemctl\s+(?:restart|stop|start|reload)/)
    }
  })
})
