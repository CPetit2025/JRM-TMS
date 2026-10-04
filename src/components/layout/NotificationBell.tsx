"use client"
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Bell, Check, Settings2, ArrowRight } from 'lucide-react'
import { useNotifications, NOTIF_CATEGORIAS, type NotifCategoria, type NotifItem } from '@/components/NotificationProvider'

// Campana del panel web: avisos dirigidos por permiso (notif_list), con pestañas por categoría, enlace a la pantalla y
// preferencias para silenciar una categoría. Las reglas (qué evento va a qué permiso) están en la tabla notif_reglas.

const SEV_DOT: Record<NotifItem['severidad'], string> = { crit: 'bg-[#cf152d]', warn: 'bg-amber-500', info: 'bg-sky-500' }
const SEV_LABEL: Record<NotifItem['severidad'], string> = { crit: 'Crítico', warn: 'Atención', info: 'Aviso' }

function hace(fecha: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(fecha).getTime()) / 60000))
  if (min < 1) return 'ahora'
  if (min < 60) return `hace ${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `hace ${h} h`
  const d = Math.round(h / 24)
  return d === 1 ? 'ayer' : `hace ${d} días`
}

export function NotificationBell() {
  const { feed, markRead, setMuted, reload } = useNotifications()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<NotifCategoria | 'TODAS'>('TODAS')
  const [prefs, setPrefs] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const items = useMemo(() => (feed?.items ?? []).filter(n => tab === 'TODAS' || n.categoria === tab), [feed, tab])
  const unread = feed?.no_leidas ?? 0
  const silenciadas = feed?.silenciadas ?? []

  const ir = async (n: NotifItem) => {
    setOpen(false)
    if (!n.leida) void markRead([n.id])
    if (n.link) router.push(n.link)
  }
  const marcarTodas = () => {
    const ids = items.filter(n => !n.leida).map(n => n.id)
    if (ids.length) void markRead(ids)
  }

  return (
    <div className="relative" ref={ref}>
      <button type="button" onClick={() => { setOpen(o => !o); if (!open) reload() }} aria-label={`Notificaciones${unread ? ` (${unread} sin leer)` : ''}`}
        className="relative rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-[#002855]">
        <Bell className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-white bg-[#cf152d] px-1 text-[10px] font-bold leading-none text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 flex max-h-[520px] w-[380px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 bg-[#002855] px-3 py-2.5 text-white">
            <h3 className="text-sm font-bold">Notificaciones</h3>
            <div className="flex items-center gap-1">
              <button type="button" onClick={marcarTodas} className="flex items-center gap-1 rounded px-2 py-1 text-xs text-sky-100 hover:bg-white/10">
                <Check className="h-3 w-3" /> Marcar leídas
              </button>
              <button type="button" onClick={() => setPrefs(p => !p)} title="Preferencias" aria-label="Preferencias"
                className={`rounded p-1 hover:bg-white/10 ${prefs ? 'bg-white/15' : ''}`}>
                <Settings2 className="h-4 w-4" />
              </button>
            </div>
          </div>

          {prefs ? (
            <div className="space-y-1 overflow-y-auto p-3">
              <p className="mb-2 text-xs text-slate-500">Recibes los avisos de los módulos a los que tienes acceso. Puedes silenciar una categoría:</p>
              {NOTIF_CATEGORIAS.map(c => {
                const muted = silenciadas.includes(c.id)
                return (
                  <label key={c.id} className="flex cursor-pointer items-center justify-between rounded-lg px-2 py-2 text-sm hover:bg-slate-50">
                    <span className="font-medium text-slate-700">{c.label}</span>
                    <input type="checkbox" className="h-4 w-4 accent-[#002855]" checked={!muted} onChange={() => void setMuted(c.id, !muted)} />
                  </label>
                )
              })}
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-1 border-b border-slate-100 px-2 py-2">
                {[{ id: 'TODAS' as const, label: 'Todas' }, ...NOTIF_CATEGORIAS].map(c => {
                  const n = c.id === 'TODAS' ? unread : (feed?.por_categoria?.[c.id] ?? 0)
                  const act = tab === c.id
                  return (
                    <button key={c.id} type="button" onClick={() => setTab(c.id)}
                      className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${act ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-100'}`}>
                      {c.label}
                      {n > 0 && <span className={`rounded-full px-1.5 text-[10px] ${act ? 'bg-white/20' : 'bg-[#cf152d] text-white'}`}>{n}</span>}
                    </button>
                  )
                })}
              </div>
              <div className="flex-1 overflow-y-auto">
                {items.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">
                    {feed ? 'Sin notificaciones' : 'Cargando…'}
                  </div>
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {items.map(n => (
                      <li key={n.id} className={`flex gap-2.5 px-3 py-2.5 ${n.leida ? '' : 'bg-sky-50/60'}`}>
                        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${SEV_DOT[n.severidad]}`} title={SEV_LABEL[n.severidad]} />
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm text-slate-800 ${n.leida ? 'font-medium' : 'font-bold'}`}>{n.titulo}</p>
                          {n.cuerpo && <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">{n.cuerpo}</p>}
                          <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                            <span>{NOTIF_CATEGORIAS.find(c => c.id === n.categoria)?.label} · {hace(n.created_at)}{n.para_mi ? ' · para ti' : ''}</span>
                            {n.link ? (
                              <button type="button" onClick={() => void ir(n)} className="flex items-center gap-0.5 font-semibold text-[#002855] hover:text-[#cf152d]">
                                Ver <ArrowRight className="h-3 w-3" />
                              </button>
                            ) : !n.leida && (
                              <button type="button" onClick={() => void markRead([n.id])} className="font-semibold text-slate-500 hover:text-[#002855]">Leída</button>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
