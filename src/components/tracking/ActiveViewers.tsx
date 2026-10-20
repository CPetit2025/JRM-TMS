'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Users, ShieldCheck, KeyRound, X } from 'lucide-react'

export type Viewer = { id: string; name: string; me: boolean; since: string; access_type: 'TMS' | 'PUBLICO'; identity_verified: boolean }
export type PresenceEvent = { id: string; name: string; me: boolean; entered_at: string; access_type: Viewer['access_type']; identity_verified: boolean }
export const viewerOrigin = (type: Viewer['access_type']) => type === 'TMS' ? 'Usuario TMS' : 'Acceso con código'
const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
const colors = ['bg-blue-600', 'bg-emerald-600', 'bg-violet-600', 'bg-amber-600', 'bg-rose-600', 'bg-cyan-700']
const avatarColor = (id: string) => colors[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length]
const entryTime = (value: string) => Number.isNaN(Date.parse(value)) ? '' : new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' }).format(new Date(value))

/** Identidades distintas aunque compartan nombre; la marca «tú» viene del servidor. */
export function ActiveViewers({ viewers, total }: { viewers: Viewer[]; total: number }) {
  const [position, setPosition] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), id = useId()
  const open = position !== null
  useEffect(() => {
    if (!open) return
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const dismiss = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setPosition(null) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPosition(null); button.current?.focus() } }
    const close = () => setPosition(null)
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) setPosition(null) }
    document.addEventListener('pointerdown', dismiss); document.addEventListener('keydown', key); window.addEventListener('resize', close); window.addEventListener('scroll', scroll, true)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', key); window.removeEventListener('resize', close); window.removeEventListener('scroll', scroll, true) }
  }, [open])
  if (!viewers.length) return null
  const shown = viewers.slice(0, 5)
  const toggle = () => {
    if (open) { setPosition(null); return }
    const box = button.current?.getBoundingClientRect(); if (!box) return
    const width = Math.min(360, window.innerWidth - 24), top = Math.min(box.bottom + 8, window.innerHeight - 150)
    setPosition({ left: Math.max(12, Math.min(box.right - width, window.innerWidth - width - 12)), top: Math.max(12, top), width, maxHeight: Math.max(120, Math.min(420, window.innerHeight - top - 16)) })
  }
  return <div className="relative shrink-0">
    <button ref={button} type="button" onClick={toggle} aria-expanded={open} aria-controls={id} aria-label={`${total} persona(s) viendo el portal; consultar nombres y tipo de acceso`}
      className="flex min-h-10 items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3 hover:bg-slate-50">
      <span className="flex -space-x-2" aria-hidden="true">
        {shown.map((v, index) => <span key={v.id || `${v.access_type}:${v.since}:${index}`} title={v.me ? `${v.name} (tú)` : v.name}
          className={`flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white ring-2 ${v.me ? 'ring-blue-300' : 'ring-white'} ${avatarColor(v.id || v.name)}`}>{initials(v.name)}</span>)}
        {viewers.length > shown.length && <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold text-slate-700 ring-2 ring-white">+{viewers.length - shown.length}</span>}
      </span>
      <span className="flex items-center gap-1 whitespace-nowrap text-xs font-semibold text-slate-700"><span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />{total} activo{total === 1 ? '' : 's'}</span>
    </button>
    {position && createPortal(<div ref={panel} id={id} role="region" aria-label="Personas conectadas" style={position} className="fixed z-[100] overflow-y-auto rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
      <div className="mb-3 flex items-center justify-between gap-2"><p className="flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-600"><Users className="h-4 w-4" />Viendo ahora ({total})</p><button type="button" onClick={() => { setPosition(null); button.current?.focus() }} aria-label="Cerrar personas conectadas" className="rounded p-1 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
      <ul className="space-y-3">{viewers.map((v, index) => <li key={v.id || `${v.access_type}:${v.since}:${index}`} className="flex items-start gap-2 text-sm text-slate-800">
        <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white ${avatarColor(v.id || v.name)}`}>{initials(v.name)}</span>
        <div className="min-w-0 flex-1"><p className="break-words font-medium">{v.name}{v.me && <span className="font-normal text-slate-500"> (tú)</span>}</p><div className="mt-1 flex flex-wrap items-center gap-1.5"><span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${v.access_type === 'TMS' ? 'bg-blue-50 text-blue-800' : 'bg-amber-50 text-amber-900'}`}>{v.access_type === 'TMS' ? <ShieldCheck className="h-3 w-3" /> : <KeyRound className="h-3 w-3" />}{viewerOrigin(v.access_type)}</span>{entryTime(v.since) && <span className="text-[10px] text-slate-500">Desde {entryTime(v.since)} · Lima</span>}</div></div>
      </li>)}</ul><p className="mt-3 border-t border-slate-100 pt-2 text-[10px] text-slate-500">Los nombres de quienes ingresan con código son declarados por el visitante. La presencia se actualiza periódicamente.</p>
    </div>, document.body)}
  </div>
}
