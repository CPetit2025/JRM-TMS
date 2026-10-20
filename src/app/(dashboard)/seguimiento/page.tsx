'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Loader2, Route, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { TrackingCalendar } from '@/components/tracking/TrackingCalendar'
import { RouteDay } from '@/components/tracking/RouteDay'
import { ActiveViewers, viewerOrigin, type Viewer, type PresenceEvent } from '@/components/tracking/ActiveViewers'
import type { PortalRow } from '@/lib/tracking-portal'
import { limaDay, monthDays, type PortalRequest } from '@/lib/tracking-calendar'

// Planificación y Seguimiento de Transporte para los usuarios del TMS: el mismo portal que se comparte con los
// clientes (calendario y ruta del día), de toda la sede, sin código: la sesión del TMS ya identifica a la persona.
type View = { rows: PortalRow[]; requests: PortalRequest[]; limited?: boolean; label?: string | null; viewer_id?: string; viewers?: Viewer[]; active_count?: number; presence_events?: PresenceEvent[] }
const SITE_KEY = 'jrm:seguimiento:sede'

export default function SeguimientoPage() {
  const db = useMemo(() => createClient(), [])
  const [sites, setSites] = useState<Array<{ id: string; name: string }> | null>(null)
  const [site, setSite] = useState('')
  const [data, setData] = useState<View | null>(null)
  const [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [tab, setTab] = useState<'calendar' | 'route'>('calendar')
  const [month, setMonth] = useState(() => limaDay(new Date().toISOString()).slice(0, 7))
  const [routeDay, setRouteDay] = useState(() => limaDay(new Date().toISOString()))
  const range = useMemo(() => { const days = monthDays(month); return { p_from: days[0], p_to: days[41] } }, [month])
  const observedPresence = useRef<{ scope: string; ids: Set<string> } | null>(null)
  const viewer = useRef<{ site: string; id: string } | null>(null)
  const changeRouteDay = (day: string) => { setRouteDay(day); if (day < range.p_from || day > range.p_to) setMonth(day.slice(0, 7)) }

  useEffect(() => {
    let alive = true
    db.rpc('tracking_internal_sites').then(({ data: r, error: e }) => {
      if (!alive) return
      if (e || r?.error) { setError(r?.error || 'No se pudo cargar las sedes'); setSites([]); return }
      const list = (r?.sites || []) as Array<{ id: string; name: string }>
      setSites(list)
      let saved = ''
      try { saved = window.localStorage.getItem(SITE_KEY) || '' } catch { /* Sin almacenamiento: primera sede */ }
      setSite(list.some(s => s.id === saved) ? saved : list[0]?.id || '')
    })
    return () => { alive = false }
  }, [db])

  // Primera carga y actualización cada 15 s, como el portal público
  useEffect(() => {
    if (!site) return
    let alive = true
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
      const current = viewer.current?.site === site ? viewer.current.id : null
      const { data: r, error: e } = await db.rpc('get_internal_tracking_view', { p_site: site, ...range, p_viewer: current })
      if (!alive) return
      if (e || r?.error) { setError(r?.error || e?.message || 'No se pudo actualizar el seguimiento'); return }
      if (r.viewer_id) viewer.current = { site, id: r.viewer_id }
      setData(r); setUpdatedAt(new Date().toISOString()); setError('')
      const events = (r.presence_events || []) as PresenceEvent[], scope = `${site}:${r.viewer_id || ''}`
      if (!r.viewer_id) return
      const previous = observedPresence.current
      if (!previous || previous.scope !== scope) {
        // La primera carga establece el corte: los ingresos anteriores quedan en la bandeja de notificaciones.
        observedPresence.current = { scope, ids: new Set(events.map(event => event.id)) }
        return
      }
      const fresh = events.filter(event => !previous.ids.has(event.id) && !event.me)
      observedPresence.current = { scope, ids: new Set([...previous.ids, ...events.map(event => event.id)].slice(-512)) }
      if (document.visibilityState !== 'visible') return
      const storageKey = `jrm:tracking-entry-notices:v1:${scope}`
      const announce = () => {
        if (!alive || document.visibilityState !== 'visible') return
        let seen: string[] = []
        try { const value = JSON.parse(window.localStorage.getItem(storageKey) || '[]'); if (Array.isArray(value)) seen = value.filter((value): value is string => typeof value === 'string') } catch { /* Sin almacenamiento: deduplicación de esta pestaña. */ }
        const announceEvents = fresh.filter(event => !seen.includes(event.id))
        if (!announceEvents.length) return
        try { window.localStorage.setItem(storageKey, JSON.stringify([...seen, ...announceEvents.map(event => event.id)].slice(-256))) } catch { /* Continúa con memoria local. */ }
        for (const event of announceEvents) {
          const at = new Date(event.entered_at)
          const time = Number.isNaN(at.getTime()) ? '' : new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' }).format(at)
          toast.info(`${event.name} ingresó al seguimiento`, { id: `tracking-entry:${event.id}`, description: `${viewerOrigin(event.access_type)}${time ? ` · ${time}, Lima` : ''}` })
        }
      }
      // Web Locks evita dos avisos para el mismo ingreso cuando hay varias pestañas del TMS.
      if (navigator.locks?.request) await navigator.locks.request(storageKey, announce)
      else announce()
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'No se pudo actualizar el seguimiento') }
      finally { inFlight = false }
    }
    void load()
    const timer = window.setInterval(load, 15000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [db, site, range, version])

  // No cerramos presencia durante cleanup: actualizar o duplicar una pestaña no representa un nuevo ingreso.
  // El servidor libera las presencias sin heartbeat al vencer el TTL.
  const chooseSite = (id: string) => {
    setSite(id); setData(null)
    try { window.localStorage.setItem(SITE_KEY, id) } catch { /* Sin almacenamiento */ }
  }

  return (
    <div className="space-y-4 pb-10">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-4">
          <div>
            <h1 className="text-lg font-black tracking-tight text-slate-900">Planificación y Seguimiento de Transporte</h1>
            <p className="flex items-center gap-1.5 text-xs text-slate-500"><ShieldCheck className="h-3.5 w-3.5 text-emerald-600" /> Vista de toda la sede con su sesión del TMS, sin código. Los clientes usan su enlace y código.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data && <ActiveViewers viewers={data.viewers || []} total={data.active_count || 0} />}
            {sites && sites.length > 1 && <select aria-label="Sede" value={site} onChange={e => chooseSite(e.target.value)} className="min-h-9 rounded-lg border border-slate-300 px-2 text-sm">
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>}
            {sites?.length === 1 && <span className="rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-sm font-medium text-blue-700">{sites[0].name}</span>}
          </div>
        </div>
        <nav aria-label="Vistas" className="mt-3 flex gap-1 overflow-x-auto border-t border-slate-100 px-2">
          {([['calendar', 'Calendario', CalendarDays], ['route', 'Ruta del día', Route]] as const).map(([key, label, Icon]) =>
            <button key={key} type="button" onClick={() => setTab(key)} aria-current={tab === key ? 'page' : undefined}
              className={`flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide ${tab === key ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              <Icon className="h-4 w-4" />{label}
            </button>)}
        </nav>
      </div>
      {sites && !sites.length ? <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">{error || 'Su usuario no tiene una sede asignada. Solicite el acceso al administrador.'}</p>
        : !data ? (error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</p>
          : <div className="flex h-64 items-center justify-center gap-2 text-sm text-slate-500" role="status"><Loader2 className="h-5 w-5 animate-spin" /> Cargando el seguimiento…</div>)
        : <>
          {data.limited && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">Hay más solicitudes. Consulta un período más específico.</p>}
          {tab === 'calendar'
            ? <TrackingCalendar month={month} onMonth={setMonth} requests={data.requests || []} rows={data.rows || []} access={{ site }} />
            : <RouteDay rows={data.rows || []} day={routeDay} onDay={changeRouteDay} access={{ site }} refreshedAt={updatedAt} error={error} onRefresh={() => setVersion(v => v + 1)} />}
        </>}
    </div>
  )
}
