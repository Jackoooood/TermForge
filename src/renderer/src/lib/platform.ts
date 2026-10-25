export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)
}

export function formatShortcut(key: string, options: { shift?: boolean } = {}): string {
  if (isMacPlatform()) {
    return `⌘${options.shift ? '⇧' : ''}${key.toUpperCase()}`
  }
  return `Ctrl+${options.shift ? 'Shift+' : ''}${key.toUpperCase()}`
}

export function isPrimaryModifierPressed(event: KeyboardEvent): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey
}
