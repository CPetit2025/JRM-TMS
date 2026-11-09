'use client'

import { useEffect, useLayoutEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'

type Option = { value: string; label: string }

/** Lista HTML: evita el recorte del menú nativo del navegador y permite envolver textos largos. */
export function PaperFormatSelect({ label, value, options, disabled, onChange }: {
  label: string; value: string; options: Option[]; disabled?: boolean; onChange: (value: string) => void
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [bounds, setBounds] = useState({ left: 0, top: 0, width: 0, maxHeight: 300 })
  const selected = options.findIndex(o => o.value === value)
  const close = () => { setOpen(false); trigger.current?.focus() }
  const choose = (index: number) => { if (options[index]) onChange(options[index].value); close() }
  const show = () => { setActive(Math.max(0, selected)); setOpen(true) }

  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (!rect) return
      const below = innerHeight - rect.bottom - 12
      const above = rect.top - 12
      const height = Math.min(300, Math.max(below, above))
      const down = below >= Math.min(300, above)
      setBounds({ left: Math.max(8, Math.min(rect.left, innerWidth - rect.width - 8)), width: Math.min(rect.width, innerWidth - 16), top: down ? rect.bottom + 4 : Math.max(8, rect.top - height - 4), maxHeight: height })
    }
    position()
    list.current?.focus()
    const outside = (e: PointerEvent) => {
      if (!trigger.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false)
    }
    const scroll = (e: Event) => { if (!list.current?.contains(e.target as Node)) position() }
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', scroll, true)
    }
  }, [open])
  useEffect(() => {
    if (open) document.getElementById(`${id}-option-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, id, open])

  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); close(); return }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); return }
    const index = e.key === 'ArrowDown' ? (active + 1) % options.length : e.key === 'ArrowUp' ? (active - 1 + options.length) % options.length : e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : null
    if (index !== null) { e.preventDefault(); setActive(index) }
  }
  return <div className="min-w-0">
    <span id={`${id}-label`} className="block text-sm font-bold text-[#002855]">{label}</span>
    <button ref={trigger} type="button" disabled={disabled} aria-label={label} aria-describedby={`${id}-value`} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined}
      className="mt-2 flex w-full min-w-0 items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-4 py-2 text-left text-sm font-normal text-[#002855] disabled:opacity-50"
      onClick={() => open ? close() : show()} onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); show() } }}>
      <span id={`${id}-value`} className="min-w-0 break-words">{options[selected]?.label || 'Usar configuración del almacén'}</span><ChevronDown size={16} className="shrink-0" aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={list} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} aria-activedescendant={`${id}-option-${active}`} tabIndex={-1}
      className="fixed z-[200] overflow-y-auto rounded-lg border border-slate-300 bg-white p-1 shadow-xl outline-none" style={bounds} onKeyDown={keys}>
      {options.map((o, i) => <div key={o.value} id={`${id}-option-${i}`} role="option" aria-selected={o.value === value}
        className={`flex cursor-pointer items-start gap-3 rounded-md px-4 py-3 text-left text-sm text-[#002855] ${active === i ? 'bg-blue-100' : 'bg-white'}`}
        onPointerMove={() => setActive(i)} onClick={() => choose(i)}>
        <Check size={16} aria-hidden="true" className={`mt-0.5 shrink-0 ${o.value === value ? 'visible' : 'invisible'}`} /><span className="min-w-0 break-words whitespace-normal">{o.label}</span>
      </div>)}
    </div>, document.body)}
  </div>
}
