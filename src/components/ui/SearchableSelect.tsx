import React, { useState, useRef, useEffect } from 'react'
import { ChevronDown, Search, X } from 'lucide-react'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

interface SearchableSelectProps {
  options: SelectOption[]
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  disabled?: boolean
  ariaLabel?: string
  searchPlaceholder?: string
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = 'Seleccionar...',
  className = '',
  disabled = false,
  ariaLabel,
  searchPlaceholder = 'Buscar...'
}: SearchableSelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  const selectedOption = options.find(opt => opt.value === value)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const normalize = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  const query = normalize(searchTerm).trim()
  const filteredOptions = options.filter(opt => normalize(opt.label).includes(query))

  return (
    <div className={`relative ${className}`} ref={containerRef} onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setIsOpen(false) } }}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
        disabled={disabled}
        className={`w-full border border-slate-300 rounded-lg p-2.5 outline-none bg-white flex justify-between items-center ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer focus-within:ring-2 focus-within:ring-[#002855] focus-within:border-[#002855]'}`}
        onClick={() => { if (!disabled) { setSearchTerm(''); setIsOpen(!isOpen) } }}
      >
        <span className={`truncate text-sm ${!selectedOption ? 'text-slate-500' : 'text-slate-900'}`}>
          {selectedOption ? selectedOption.label : placeholder}
        </span>
        <ChevronDown className="w-4 h-4 text-slate-400 flex-shrink-0 ml-2" />
      </button>

      {isOpen && !disabled && (
        <div className="absolute z-50 w-full mt-1 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
          <div className="p-2 border-b border-slate-100 flex items-center gap-2 bg-slate-50">
            <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
            <input
              type="text"
              className="w-full bg-transparent text-sm outline-none text-slate-700"
              aria-label={ariaLabel ? `Buscar ${ariaLabel.toLowerCase()}` : 'Buscar opciones'}
              placeholder={searchPlaceholder}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
            {searchTerm && (
              <button 
                aria-label="Limpiar búsqueda"
                onClick={(e) => { e.stopPropagation(); setSearchTerm(''); }}
                className="p-1 hover:bg-slate-200 rounded-full"
                type="button"
              >
                <X className="w-3 h-3 text-slate-500" />
              </button>
            )}
          </div>
          <div className="max-h-60 overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="p-3 text-sm text-slate-500 text-center">No se encontraron resultados</div>
            ) : (
              <div className="p-1">
                {filteredOptions.map((opt) => (
                  <button
                    type="button"
                    disabled={opt.disabled}
                    key={opt.value}
                    className={`block w-full text-left px-3 py-2 text-sm cursor-pointer rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${value === opt.value ? 'bg-[#002855]/10 text-[#002855] font-medium' : 'text-slate-700 hover:bg-slate-100'}`}
                    onClick={() => {
                      if (opt.disabled) return
                      onChange(opt.value)
                      setIsOpen(false)
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
