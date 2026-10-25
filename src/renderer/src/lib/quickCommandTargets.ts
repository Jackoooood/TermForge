import type { SessionInfo, TerminalShellSnapshot } from '@shared/types'

export interface QuickCommandTarget {
  tabId: string
  sessionId: string
  label: string
  detail: string
}

export function targetKey(target: Pick<QuickCommandTarget, 'tabId' | 'sessionId'>): string {
  return `${target.tabId}|${target.sessionId}`
}

export function isQuickCommandTargetSendable(
  session: SessionInfo | undefined,
  shell: TerminalShellSnapshot | undefined,
): boolean {
  return Boolean(
    session &&
    session.status === 'connected' &&
    session.sessionId &&
    shell &&
    shell.status === 'open' &&
    shell.sessionId === session.sessionId,
  )
}

export function toQuickCommandTarget(
  session: SessionInfo | undefined,
  shell: TerminalShellSnapshot | undefined,
): QuickCommandTarget | null {
  if (!session || !isQuickCommandTargetSendable(session, shell)) return null
  const sessionId = session.sessionId
  if (!sessionId) return null
  return {
    tabId: session.id,
    sessionId,
    label: session.title || session.connectionName,
    detail: `${session.username}@${session.host}:${session.port}`,
  }
}

export function listQuickCommandTargets(
  sessions: Record<string, SessionInfo>,
  shells: Record<string, TerminalShellSnapshot>,
): QuickCommandTarget[] {
  const targets: QuickCommandTarget[] = []
  for (const session of Object.values(sessions)) {
    const target = toQuickCommandTarget(session, shells[session.id])
    if (target) targets.push(target)
  }
  return targets.sort((left, right) => left.label.localeCompare(right.label, 'zh-Hans-CN'))
}
