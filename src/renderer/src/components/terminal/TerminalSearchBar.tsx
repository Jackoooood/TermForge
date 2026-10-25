import type { KeyboardEvent, RefObject } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

interface TerminalSearchBarProps {
  query: string
  caseSensitive: boolean
  resultIndex: number
  resultCount: number
  inputRef: RefObject<HTMLInputElement | null>
  onQueryChange: (query: string) => void
  onNext: () => void
  onPrevious: () => void
  onToggleCase: () => void
  onClose: () => void
}

function resultLabel(query: string, resultIndex: number, resultCount: number): string {
  if (!query) return ''
  if (resultCount === 0) return '0/0'
  return `${Math.max(resultIndex + 1, 1)}/${resultCount}`
}

export function TerminalSearchBar({
  query,
  caseSensitive,
  resultIndex,
  resultCount,
  inputRef,
  onQueryChange,
  onNext,
  onPrevious,
  onToggleCase,
  onClose,
}: TerminalSearchBarProps) {
  const empty = query.length === 0 || resultCount === 0

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (event.shiftKey) onPrevious()
      else onNext()
    }
  }

  return (
    <div className="terminal-search" role="search" aria-label="在终端中查找">
      <Search className="terminal-search__icon" size={13} strokeWidth={1.9} aria-hidden="true" />
      <input
        ref={inputRef}
        className="terminal-search__input"
        type="text"
        role="searchbox"
        aria-label="查找内容"
        value={query}
        placeholder="在终端中查找…"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <span className="terminal-search__count" aria-live="polite">
        {resultLabel(query, resultIndex, resultCount)}
      </span>
      <button
        type="button"
        className="terminal-search__button terminal-search__case"
        aria-label="区分大小写"
        aria-pressed={caseSensitive}
        title="区分大小写"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onToggleCase}
      >
        Aa
      </button>
      <button
        type="button"
        className="terminal-search__button"
        aria-label="上一个匹配"
        title="上一个匹配（Shift+Enter）"
        disabled={empty}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onPrevious}
      >
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="terminal-search__button"
        aria-label="下一个匹配"
        title="下一个匹配（Enter）"
        disabled={empty}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onNext}
      >
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="terminal-search__button"
        aria-label="关闭查找"
        title="关闭查找（Esc）"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClose}
      >
        <X size={13} aria-hidden="true" />
      </button>
    </div>
  )
}
