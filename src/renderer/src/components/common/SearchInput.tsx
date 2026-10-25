import { Search, X } from 'lucide-react'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  id?: string
  className?: string
  autoFocus?: boolean
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  id,
  className,
  autoFocus = false,
}: SearchInputProps) {
  return (
    <div className={className ? `search-input ${className}` : 'search-input'}>
      <Search className="search-input__icon" size={14} strokeWidth={1.8} aria-hidden="true" />
      <input
        id={id}
        type="text"
        role="searchbox"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => onChange(event.target.value)}
      />
      {value.length > 0 ? (
        <button
          type="button"
          className="search-input__clear"
          aria-label="清除搜索"
          title="清除搜索"
          onClick={() => onChange('')}
        >
          <X size={13} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
