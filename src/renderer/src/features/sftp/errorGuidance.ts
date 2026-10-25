import type { OperationErrorCode } from '@shared/types'

export function sftpErrorGuidance(code: OperationErrorCode | null): string | null {
  switch (code) {
    case 'permission-denied':
      return '请检查当前 SSH 用户对目标路径的权限。'
    case 'not-a-directory':
      return '该路径不是目录，或服务器拒绝读取；可返回上一级重新选择。'
    case 'not-found':
      return '该路径可能已被其他操作移动或删除，请刷新目录。'
    case 'timeout':
      return '服务器响应超时；请确认网络后重试。'
    case 'outcome-unknown':
      return '无法确认操作是否已在服务器上生效；请刷新目录核实，不要直接重复删除。'
    case 'unavailable':
      return 'SSH 连接不可用；请在会话重新连接后再试。'
    default:
      return null
  }
}
