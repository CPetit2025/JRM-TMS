'use client'
import { useMemo, useState } from 'react'
import { Eye } from 'lucide-react'
import { DataTable } from '@/components/ui/data-table'
import { Modal } from '@/components/ui/modal'
import { limaDay, monthDays, portalTime, portalAllowedTime, requestAnticipation, type PortalRequest } from '@/lib/tracking-calendar'
import { PORTAL_ORIGINS, originStyle, portalExtraRefs, portalOrigin, portalReference, portalStatus, type PortalOrigin, type PortalRow } from '@/lib/tracking-portal'
import { OriginBadge, PortalDocButtons, StatusPill } from '@/components/tracking/PortalBits'

// Calendario del portal público: cada servicio se marca por su origen (OT, subcontrato, error, OS, OC, RQ) en su
// fecha de salida programada o, si aún no tiene ruta, en la fecha de atención solicitada. Hoy (despacho actual) y
// mañana (despacho del día siguiente) se resaltan. Debajo, el registro de solicitudes desde la más reciente.

type Props = { month: string; onMonth: (month: string) => void; requests: PortalRequest[]; rows: PortalRow[]; access: { token: string; pin: string } }
type CalEvent = { id: string; day: string; origin: PortalOrigin; ref: string; code: string; label: string; bg: string; text: string }

const attentionDay = (r: PortalRequest) => r.required_at ? limaDay(r.required_at) : r.required_date?.slice(0, 10)
const addDays = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const serviceLabel = (r: PortalRequest) => r.request_type === 'RECOJO' ? 'Recojo' : r.request_type === 'TRASLADO' ? 'Punto a punto' : 'Entrega'
const district = (r: PortalRequest) => (r.request_type === 'RECOJO' ? r.pickup_district : r.delivery_district) || r.delivery_zone || '—'
const routeTime = (value: string) => new Date(value).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

export { OriginBadge }

export function TrackingCalendar({ month, onMonth, requests, rows, access }: Props) {
  const [detail, setDetail] = useState<PortalRequest | null>(null)
  const [selected, setSelected] = useState('')
  const [basis, setBasis] = useState<'registered' | 'attention'>('registered')
  const [view, setView] = useState<'month' | 'week' | 'day'>('month')
  const [search, setSearch] = useState('')
  const [hidden, setHidden] = useState<PortalOrigin[]>([])
  const days = useMemo(() => monthDays(month), [month])
  const today = limaDay(new Date().toISOString()), tomorrow = addDays(today, 1)

  // Última parada de cada solicitud (las filas vienen de la salida más reciente a la más antigua).
  const stopOf = useMemo(() => {
    const m = new Map<string, PortalRow>()
    rows.forEach(r => { if (!m.has(r.request_id)) m.set(r.request_id, r) })
    return m
  }, [rows])
  const events = useMemo<CalEvent[]>(() => [
    ...rows.map(r => ({ id: `${r.dispatch_id}-${r.request_id}`, day: limaDay(r.scheduled_departure), origin: portalOrigin(r), ref: portalReference(r), code: r.request_number, ...portalStatus(r) })),
    ...requests.filter(r => !stopOf.has(r.id)).map(r => ({ id: r.id, day: attentionDay(r) || '', origin: portalOrigin(r), ref: portalReference(r), code: r.request_number, ...portalStatus(null, r.status) })),
  ], [requests, rows, stopOf])
  const counts = useMemo(() => {
    const c = new Map<PortalOrigin, number>()
    events.filter(e => e.day.startsWith(month)).forEach(e => c.set(e.origin, (c.get(e.origin) || 0) + 1))
    return c
  }, [events, month])
  const shown = events.filter(e => !hidden.includes(e.origin))
  const toggle = (key: PortalOrigin) => setHidden(h => h.includes(key) ? h.filter(k => k !== key) : [...h, key])

  const anchor = selected || (today.startsWith(month) ? today : `${month}-01`)
  const index = Math.max(0, days.indexOf(anchor))
  const visibleDays = view === 'day' ? [anchor] : view === 'week' ? days.slice(Math.floor(index / 7) * 7, Math.floor(index / 7) * 7 + 7) : days
  const activeDays = selected ? (view === 'week' ? visibleDays : [selected]) : view === 'month' ? null : visibleDays
  const filtered = requests.filter(r => !hidden.includes(portalOrigin(r))
    && (!activeDays || (basis === 'registered' ? activeDays.includes(limaDay(r.created_at))
      : activeDays.includes(attentionDay(r) || '') || rows.some(d => d.request_id === r.id && activeDays.includes(limaDay(d.scheduled_departure)))))
    && [r.request_number, r.ot_code, r.parent_ot, r.reference_number, r.purchase_order, r.client_name, r.delivery_address, district(r), stopOf.get(r.id)?.plate].join(' ').toLowerCase().includes(search.toLowerCase()))
  const navigate = (direction: number) => {
    const day = addDays(anchor, direction * (view === 'week' ? 7 : 1))
    if (!day.startsWith(month)) onMonth(day.slice(0, 7)); setSelected(day)
  }
  const dayEvents = (day: string) => shown.filter(e => e.day === day)
  const perCell = view === 'month' ? 2 : 12
  const dayMark = (day: string) => day === today ? { ring: 'border-blue-500 bg-blue-50 ring-1 ring-blue-500', tag: 'Hoy · despacho', tagCls: 'bg-blue-600 text-white' }
    : day === tomorrow ? { ring: 'border-amber-400 bg-amber-50 ring-1 ring-amber-400', tag: 'Mañana', tagCls: 'bg-amber-500 text-white' } : null
  const detailStop = detail ? stopOf.get(detail.id) : undefined

  return <div className="space-y-4">
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">{[
      { label: 'Solicitudes del período', count: requests.length },
      { label: 'Pendientes de programación', count: requests.filter(r => ['PENDIENTE', 'APROBADA', 'REPROGRAMADA', 'PENDIENTE DE APROBACIÓN'].includes(r.status)).length },
      { label: 'Despacho de hoy', count: events.filter(e => e.day === today).length },
      { label: 'Despacho de mañana', count: events.filter(e => e.day === tomorrow).length },
    ].map(k => <div key={k.label} className="flex items-center justify-between rounded-lg border bg-white px-3 py-2"><p className="text-xs text-slate-500">{k.label}</p><strong className="text-xl tabular-nums text-[#002855]">{k.count}</strong></div>)}</div>

    <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div><h2 className="font-bold text-[#002855]">Calendario de transporte</h2><p className="text-xs text-slate-500">Fecha de salida o de atención · horario de Lima</p></div>
        <div className="flex flex-wrap gap-1.5 text-sm">
          <input aria-label="Mes consultado" type="month" value={month} onChange={e => { if (e.target.value) { onMonth(e.target.value); setSelected('') } }} className="h-9 rounded-lg border px-2" />
          <select aria-label="Vista del calendario" value={view} onChange={e => setView(e.target.value as typeof view)} className="h-9 rounded-lg border px-2"><option value="month">Mes</option><option value="week">Semana</option><option value="day">Día</option></select>
          {view !== 'month' && <>
            <button aria-label="Período anterior" onClick={() => navigate(-1)} className="h-9 rounded-lg border px-3">‹</button>
            <input type="date" aria-label="Día de referencia" value={anchor} onChange={e => { if (e.target.value) { setSelected(e.target.value); if (!e.target.value.startsWith(month)) onMonth(e.target.value.slice(0, 7)) } }} className="h-9 rounded-lg border px-2" />
            <button aria-label="Período siguiente" onClick={() => navigate(1)} className="h-9 rounded-lg border px-3">›</button>
          </>}
          <button onClick={() => { onMonth(today.slice(0, 7)); setSelected(today) }} className="h-9 rounded-lg border px-3">Hoy</button>
        </div>
      </div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filtrar por origen">
        {PORTAL_ORIGINS.filter(o => counts.get(o.key) || hidden.includes(o.key)).map(o => {
          const off = hidden.includes(o.key)
          return <button key={o.key} type="button" aria-pressed={!off} onClick={() => toggle(o.key)}
            className={`inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs font-semibold transition ${off ? 'border-slate-200 bg-white text-slate-400 line-through' : o.chip}`}>
            {o.label}<span className="tabular-nums opacity-70">{counts.get(o.key) || 0}</span>
          </button>
        })}
        {hidden.length > 0 && <button type="button" onClick={() => setHidden([])} className="text-xs font-medium text-blue-700">Mostrar todo</button>}
        <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-blue-500" />Hoy · despacho actual</span>
          <span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-amber-400" />Mañana</span>
        </span>
      </div>
      <div className={`hidden gap-1 md:grid ${view === 'day' ? 'grid-cols-1' : 'grid-cols-7'}`}>
        {view !== 'day' && ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].map(day => <div key={day} className="pb-0.5 text-center text-[11px] font-semibold uppercase text-slate-500">{day}</div>)}
        {visibleDays.map(day => {
          const list = dayEvents(day), mark = dayMark(day)
          return <button key={day} onClick={() => setSelected(day === selected ? '' : day)}
            className={`flex min-h-[4.75rem] flex-col rounded-md border p-1 text-left ${day === selected ? 'border-[#002855] bg-slate-100' : mark ? mark.ring : 'border-slate-200'} ${day.startsWith(month) ? '' : 'opacity-45'}`}>
            <span className="flex items-center justify-between gap-1"><span className="text-xs font-semibold">{Number(day.slice(-2))}</span>{mark && <span className={`truncate rounded px-1 text-[9px] font-bold uppercase ${mark.tagCls}`}>{mark.tag}</span>}</span>
            <span className="mt-0.5 space-y-0.5">
              {list.slice(0, perCell).map(e => <span key={e.id} title={`${e.ref} · ${e.code} · ${e.label}`} className={`block truncate rounded border-l-[3px] px-1 py-px text-[10px] leading-4 ${originStyle(e.origin).bar} ${e.bg} ${e.text}`}>
                <b>{e.ref.replace(/^OT /, '')}</b> · {e.label}
              </span>)}
              {list.length > perCell && <span className="block text-[10px] font-semibold text-blue-700">+{list.length - perCell} más</span>}
            </span>
          </button>
        })}
      </div>
      <div className="space-y-2 md:hidden">
        {visibleDays.filter(day => day.startsWith(month) && dayEvents(day).length).map(day => {
          const mark = dayMark(day)
          return <div key={day} className={`rounded-lg border p-2 ${mark ? mark.ring : ''}`}>
            <button onClick={() => setSelected(day === selected ? '' : day)} className="mb-1 flex items-center gap-2 text-sm font-semibold text-[#002855]">{new Date(`${day}T12:00:00-05:00`).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })}{mark && <span className={`rounded px-1 text-[10px] uppercase ${mark.tagCls}`}>{mark.tag}</span>}</button>
            {dayEvents(day).map(e => <div key={e.id} className={`mb-1 rounded border-l-4 px-2 py-1 text-xs ${originStyle(e.origin).bar} ${e.bg} ${e.text}`}>{e.ref} · {e.code} · {e.label}</div>)}
          </div>
        })}
        {!visibleDays.some(day => dayEvents(day).length) && <p className="text-sm text-slate-500">No hay servicios en este período.</p>}
      </div>
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div><h2 className="font-bold text-[#002855]">Registro de solicitudes</h2><p className="text-xs text-slate-500">Desde la registrada más recientemente{selected ? ` · ${selected}` : ''}</p></div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Fecha para filtrar solicitudes" value={basis} onChange={e => setBasis(e.target.value as typeof basis)} className="h-9 rounded-lg border px-2 text-sm"><option value="registered">Fecha de registro</option><option value="attention">Fecha de atención</option></select>
          {selected && <button onClick={() => setSelected('')} className="text-xs text-blue-700">Ver todo</button>}
          <input aria-label="Buscar solicitud" value={search} onChange={e => setSearch(e.target.value)} placeholder="OT, OS/OC/RQ, distrito o placa" className="h-9 w-56 rounded-lg border px-2 text-sm" />
        </div>
      </div>
      <div className="overflow-x-auto"><DataTable className="w-full min-w-[820px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Registro', 'OT / Referencia', 'Servicio', 'Distrito', 'Placa', 'Estado', ''].map(h => <th key={h} className="px-3 py-2">{h}</th>)}</tr></thead>
        <tbody className="divide-y">
          {filtered.map(r => {
            const stop = stopOf.get(r.id)
            return <tr key={r.id} className="hover:bg-slate-50">
              <td className="whitespace-nowrap px-3 py-2">{portalTime(r.created_at)}</td>
              <td className="px-3 py-2"><span className="flex items-center gap-1.5"><OriginBadge origin={portalOrigin(r)} /><span className="font-semibold text-slate-800">{portalReference(r)}</span></span></td>
              <td className="px-3 py-2">{serviceLabel(r)}</td>
              <td className="px-3 py-2">{district(r)}</td>
              <td className="whitespace-nowrap px-3 py-2 font-medium">{stop?.plate && stop.plate !== 'EXTERNO' ? stop.plate : <span className="text-slate-400">—</span>}</td>
              <td className="px-3 py-2"><StatusPill tone={portalStatus(stop, r.status)} /></td>
              <td className="px-3 py-2 text-right"><button onClick={() => setDetail(r)} className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-xs font-semibold text-[#002855] hover:bg-white"><Eye className="h-3.5 w-3.5" />Ver detalle</button></td>
            </tr>
          })}
          {!filtered.length && <tr><td colSpan={7} className="p-8 text-center text-slate-500">No hay solicitudes para los filtros seleccionados.</td></tr>}
        </tbody>
      </DataTable></div>
    </section>

    <Modal isOpen={Boolean(detail)} onClose={() => setDetail(null)} title={`Detalle · ${detail?.request_number || ''}`} maxWidth="max-w-3xl">
      {detail && <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><OriginBadge origin={portalOrigin(detail)} /><strong className="text-base text-[#002855]">{portalReference(detail)}</strong><StatusPill tone={portalStatus(detailStop, detail.status)} /></div>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {[
            ['Solicitud', detail.request_number], ['Cliente', detail.client_name || '—'],
            ...(detail.parent_ot ? [['OT madre', detail.parent_ot]] : []),
            ...(portalExtraRefs(detail).length ? [['Otras referencias', portalExtraRefs(detail).join(' · ')]] : []),
            ['Servicio', `${serviceLabel(detail)} · ${detail.delivery_zone || 'Sin zona'}`], ['Registro', portalTime(detail.created_at)],
            ['Origen', [detail.pickup_address, detail.pickup_district].filter(Boolean).join(' · ')], ['Destino', [detail.delivery_address, detail.delivery_district].filter(Boolean).join(' · ')],
            ['Entrega solicitada', detail.required_at ? portalTime(detail.required_at) : `${detail.required_date?.slice(0, 10) || '—'} · sin hora`],
            ['Anticipación', `${requestAnticipation(detail).label}${requestAnticipation(detail).earliest ? ` · primera fecha ${portalAllowedTime(requestAnticipation(detail).earliest)}` : ''}`],
            ...(detailStop ? [['Ruta', `${detailStop.dispatch_number} · salida ${routeTime(detailStop.scheduled_departure)}`], ['Unidad', `${detailStop.plate || '—'} · ${detailStop.driver_name || 'Conductor por asignar'}`]] : []),
          ].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium text-slate-900">{v}</dd></div>)}
        </dl>
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Documentos</p>
          {detailStop ? <PortalDocButtons row={detailStop} access={access} /> : <p className="text-xs text-slate-500">Disponibles cuando el servicio tenga ruta programada.</p>}
        </div>
      </div>}
    </Modal>
  </div>
}
