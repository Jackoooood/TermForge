/**
 * Windows-first local filename policy. It is also applied on other platforms so
 * downloads created on Windows remain portable and predictable.
 */
const INVALID_CHARACTERS = /[<>:"/\\|?*]/
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const MAX_LOCAL_NAME_LENGTH = 255

function hasControlCharacter(name: string): boolean {
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function getLocalFileNameError(name: string): string | null {
  if (name.length === 0) return '文件名不能为空'
  if (name.length > MAX_LOCAL_NAME_LENGTH) {
    return `文件名不能超过 ${MAX_LOCAL_NAME_LENGTH} 个字符`
  }
  if (name === '.' || name === '..') return '文件名不能是 . 或 ..'
  if (INVALID_CHARACTERS.test(name) || hasControlCharacter(name)) {
    return '文件名不能包含 < > : " / \\ | ? * 或控制字符'
  }
  if (/[. ]$/.test(name)) return '文件名不能以空格或句点结尾'
  if (RESERVED_NAMES.test(name)) return '该名称是 Windows 保留文件名'
  return null
}

export { MAX_LOCAL_NAME_LENGTH }
