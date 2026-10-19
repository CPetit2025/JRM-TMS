'use client'

import { useState } from 'react'
import { Users } from 'lucide-react'

export type Viewer = { name: string; me: boolean; since: string }
const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase()
const AVATAR_COLORS = ['bg-blue-600', 'bg-emerald-600', 'bg-violet-600', 'bg-amber-600', 'bg-rose-600', 'bg-cyan-700']
const avatarColor = (name: string) => AVATAR_COLORS[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length]

/** Personas viendo el portal en este momento: círculos con iniciales, total y lista con los nombres. */
export function ActiveViewers({ viewers, total }: { viewers: Viewer[]; total: number }) {
  const [open, setOpen] = useState(false)
  if (!viewers.length) return null
  const shown = viewers.slice(0, 5)
  return <div className="relative">
    <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} aria-label={`${total} persona(s) viendo el portal`}
      className="flex items-center gap-2 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-3 hover:bg-slate-50">
      <span className="flex -space-x-2">
        {shown.map(v => <span key={v.name} title={v.me ? `${v.name} (tú)` : v.name}
          className={`flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold text-white ring-2 ${v.me ? 'ring-blue-300' : 'ring-white'} ${avatarColor(v.name)}`}>{initials(v.name)}</span>)}
        {viewers.length > shown.length && <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-200 text-[11px] font-bold text-slate-700 ring-2 ring-white">+{viewers.length - shown.length}</span>}
      </span>
      <span className="flex items-center gap-1 text-xs font-semibold text-slate-700"><span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />{total} activo{total === 1 ? '' : 's'}</span>
    </button>
    {open && <div className="absolute right-0 z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-lg">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-slate-500"><Users className="h-3.5 w-3.5" />Viendo ahora ({total})</p>
      <ul className="space-y-1.5">{viewers.map(v => <li key={v.name} className="flex items-center gap-2 text-sm text-slate-800">
        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white ${avatarColor(v.name)}`}>{initials(v.name)}</span>
        <span className="truncate">{v.name}{v.me && <span className="text-slate-500"> (tú)</span>}</span></li>)}</ul>
    </div>}
  </div>
}

