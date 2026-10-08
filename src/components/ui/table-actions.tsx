'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MoreHorizontal } from 'lucide-react'

export type TableAction = {
  id: string
  label: string
  icon?: ReactNode
  onSelect: () => void | Promise<unknown>
  tone?: 'danger'
  disabled?: boolean
}

/** A fixed portal keeps row actions accessible inside scrolling / sticky tables. */
export function TableActions({ label, actions, compact = false }: { label: string; actions: TableAction[]; compact?: boolean }) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const initialFocus = useRef<'first' | 'last'>('first')
  const [position, setPosition] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  const close = useCallback((restoreFocus = false) => {
    setPosition(null)
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }, [])

  const open = (focus: 'first' | 'last' = 'first') => {
    const rect = trigger.current?.getBoundingClientRect()
    if (!rect) return
    initialFocus.current = focus
    const gap = 8, width = Math.min(240, window.innerWidth - gap * 2)
    const estimatedHeight = actions.length * 44 + 10
    const below = window.innerHeight - rect.bottom - gap * 2
    const above = rect.top - gap * 2
    const fitsBelow = below >= Math.min(estimatedHeight, 320) || below >= above
    const maxHeight = Math.max(44, fitsBelow ? below : above)
    setPosition({
      left: Math.max(gap, Math.min(rect.right - width, window.innerWidth - width - gap)),
      top: fitsBelow ? rect.bottom + gap : Math.max(gap, rect.top - gap - Math.min(estimatedHeight, maxHeight)),
      maxHeight,
    })
  }

  useEffect(() => {
    if (!position) return
    const items = menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
    if (items?.length) items[initialFocus.current === 'last' ? items.length - 1 : 0].focus({ preventScroll: true })
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close()
    }
    const scroll = (event: Event) => { if (!menu.current?.contains(event.target as Node)) close(true) }
    const resize = () => close(true)
    document.addEventListener('pointerdown', outside)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', resize)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', resize)
    }
  }, [position, close])

  if (!actions.length) return null
  return <>
    <button ref={trigger} type="button" title={label} aria-label={label} aria-haspopup="menu"
      aria-expanded={!!position} aria-controls={position ? id : undefined}
      className={`grid ${compact ? 'h-11 w-11 lg:h-8 lg:w-8' : 'h-11 w-11'} shrink-0 place-items-center rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-50 hover:text-[#002855] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#002855]`}
      onClick={event => { event.stopPropagation(); if (position) close(true); else open() }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault(); event.stopPropagation(); open(event.key === 'ArrowUp' ? 'last' : 'first')
        }
      }}><MoreHorizontal className="h-4 w-4" aria-hidden="true" /></button>
    {position && createPortal(<div ref={menu} id={id} role="menu" aria-label={label}
      style={{ ...position, width: 'min(240px, calc(100vw - 16px))' }}
      className="fixed z-[10001] overflow-y-auto rounded-xl border border-slate-200 bg-white p-1 shadow-xl"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
        if (event.key === 'Tab') { close(true); return }
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') || [])
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null
        if (next !== null && items.length) { event.preventDefault(); items[next].focus() }
      }}>
      {actions.map(action => <button key={action.id} role="menuitem" type="button" tabIndex={-1} disabled={action.disabled}
        className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm disabled:opacity-40 ${action.tone === 'danger' ? 'text-red-700 hover:bg-red-50 focus:bg-red-50' : 'text-slate-700 hover:bg-slate-50 focus:bg-slate-50'} focus:outline-none`}
        onClick={() => { close(true); void action.onSelect() }}>{action.icon}{action.label}</button>)}
    </div>, document.body)}
  </>
}
