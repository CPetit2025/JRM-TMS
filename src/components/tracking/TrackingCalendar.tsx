'use client'
import { useMemo, useState } from 'react'
import { DataTable } from '@/components/ui/data-table'
import { Modal } from '@/components/ui/modal'
import { deliveryStatus } from '@/lib/delivery'
import { limaDay, monthDays, portalTime, portalAllowedTime, requestAnticipation, type PortalRequest } from '@/lib/tracking-calendar'
import { PORTAL_ORIGINS, originStyle, portalExtraRefs, portalOrigin, portalReference, type PortalOrigin, type PortalRow } from '@/lib/tracking-portal'

// Calendario del portal público: cada servicio se marca por su origen (OT, subcontrato, error, OS, OC, RQ) en su
// fecha de salida programada o, si aún no tiene ruta, en la fecha de atención solicitada. Debajo, el registro de
// solicitudes ordenado desde la más reciente, con la hora exacta en que se registró.

type Props = { month: string; onMonth: (month: string) => void; requests: PortalRequest[]; rows: PortalRow[] }
type CalEvent = { id: string; day: string; origin: PortalOrigin; ref: string; code: string; label: string; color: string }

const requestLabel = (r: PortalRequest) => r.status === 'REPROGRAMADA' ? 'Reprogramado' : r.status === 'ENTREGADA' ? 'Realizado'
  : ['PENDIENTE', 'APROBADA', 'PENDIENTE DE APROBACIÓN'].includes(r.status) ? 'Solicitado' : r.status.replaceAll('_', ' ')
const attentionDay = (r: PortalRequest) => r.required_at ? limaDay(r.required_at) : r.required_date?.slice(0, 10)

export function OriginBadge({ origin }: { origin: PortalOrigin }) {
  const s = originStyle(origin)
  return <span className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${s.chip}`}>{s.label}</span>
}

export function TrackingCalendar({ month, onMonth, requests, rows }: Props) {
  const [detail, setDetail] = useState<PortalRequest | null>(null)
  const [selected, setSelected] = useState('')
  const [basis, setBasis] = useState<'registered' | 'attention'>('registered')
  const [view, setView] = useState<'month' | 'week' | 'day'>('month')
  const [search, setSearch] = useState('')
  const [hidden, setHidden] = useState<PortalOrigin[]>([])
  const days = useMemo(() => monthDays(month), [month])

  const events = useMemo<CalEvent[]>(() => {
    const routed = new Set(rows.map(r => r.request_id))
    return [
      ...rows.map(r => ({ id: `${r.dispatch_id}-${r.request_id}`, day: limaDay(r.scheduled_departure), origin: portalOrigin(r), ref: portalReference(r),
        code: r.request_number, label: deliveryStatus(r.state).label, color: deliveryStatus(r.state).color })),
      ...requests.filter(r => !routed.has(r.id)).map(r => ({ id: r.id, day: attentionDay(r) || '', origin: portalOrigin(r), ref: portalReference(r),
        code: r.request_number, label: requestLabel(r), color: 'bg-slate-100 text-slate-700' })),
    ]
  }, [requests, rows])
  const counts = useMemo(() => {
    const c = new Map<PortalOrigin, number>()
    events.filter(e => e.day.startsWith(month)).forEach(e => c.set(e.origin, (c.get(e.origin) || 0) + 1))
    return c
  }, [events, month])
  const shown = events.filter(e => !hidden.includes(e.origin))
  const toggle = (key: PortalOrigin) => setHidden(h => h.includes(key) ? h.filter(k => k !== key) : [...h, key])

  const anchor = selected || `${month}-01`
  const index = Math.max(0, days.indexOf(anchor))
  const visibleDays = view === 'day' ? [anchor] : view === 'week' ? days.slice(Math.floor(index / 7) * 7, Math.floor(index / 7) * 7 + 7) : days
  const activeDays = selected ? (view === 'week' ? visibleDays : [selected]) : view === 'month' ? null : visibleDays
  const filtered = requests.filter(r => !hidden.includes(portalOrigin(r))
    && (!activeDays || (basis === 'registered' ? activeDays.includes(limaDay(r.created_at))
      : activeDays.includes(attentionDay(r) || '') || rows.some(d => d.request_id === r.id && activeDays.includes(limaDay(d.scheduled_departure)))))
    && [r.request_number, r.ot_code, r.parent_ot, r.reference_number, r.purchase_order, r.client_name, r.delivery_address].join(' ').toLowerCase().includes(search.toLowerCase()))
  const navigate = (direction: number) => {
    const next = new Date(`${anchor}T12:00:00Z`); next.setUTCDate(next.getUTCDate() + direction * (view === 'week' ? 7 : 1))
    const day = next.toISOString().slice(0, 10); if (!day.startsWith(month)) onMonth(day.slice(0, 7)); setSelected(day)
  }
  const dayEvents = (day: string) => shown.filter(e => e.day === day)

  return <div className="space-y-5">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
      { label: 'Solicitudes del período', count: requests.length },
      { label: 'Pendientes de programación', count: requests.filter(r => ['PENDIENTE', 'APROBADA', 'REPROGRAMADA', 'PENDIENTE DE APROBACIÓN'].includes(r.status)).length },
      { label: 'Servicios programados', count: rows.filter(r => r.dispatch_status === 'PROGRAMADO' || (!r.dispatch_status && r.state === 'PROGRAMADO')).length },
      { label: 'Conformidad pendiente', count: rows.filter(r => !['VALIDADA', 'HISTORICA', 'NO_APLICA'].includes(r.conformity)).length },
    ].map(k => <div key={k.label} className="rounded-xl border bg-white p-4"><p className="text-xs text-slate-500">{k.label}</p><strong className="text-2xl text-[#002855]">{k.count}</strong></div>)}</div>

    <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-bold text-[#002855]">Calendario de transporte</h2><p className="text-xs text-slate-500">OT, subcontratos, errores y órdenes OS / OC / RQ · fecha de salida o de atención · horario de Lima</p></div>
        <div className="flex flex-wrap gap-2">
          <input aria-label="Mes consultado" type="month" value={month} onChange={e => { if (e.target.value) { onMonth(e.target.value); setSelected('') } }} className="rounded-lg border p-2" />
          <select aria-label="Vista del calendario" value={view} onChange={e => setView(e.target.value as typeof view)} className="rounded-lg border p-2"><option value="month">Mes</option><option value="week">Semana</option><option value="day">Día</option></select>
          {view !== 'month' && <>
            <button aria-label="Período anterior" onClick={() => navigate(-1)} className="rounded-lg border px-3">‹</button>
            <input type="date" aria-label="Día de referencia" value={anchor} onChange={e => { if (e.target.value) { setSelected(e.target.value); if (!e.target.value.startsWith(month)) onMonth(e.target.value.slice(0, 7)) } }} className="rounded-lg border p-2" />
            <button aria-label="Período siguiente" onClick={() => navigate(1)} className="rounded-lg border px-3">›</button>
          </>}
        </div>
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filtrar por origen">
        {PORTAL_ORIGINS.filter(o => counts.get(o.key) || hidden.includes(o.key)).map(o => {
          const off = hidden.includes(o.key)
          return <button key={o.key} type="button" aria-pressed={!off} onClick={() => toggle(o.key)}
            className={`inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition ${off ? 'border-slate-200 bg-white text-slate-400 line-through' : o.chip}`}>
            {o.label}<span className="tabular-nums opacity-70">{counts.get(o.key) || 0}</span>
          </button>
        })}
        {hidden.length > 0 && <button type="button" onClick={() => setHidden([])} className="text-xs font-medium text-blue-700">Mostrar todo</button>}
      </div>
      <div className={`hidden gap-1 md:grid ${view === 'day' ? 'grid-cols-1' : 'grid-cols-7'}`}>
        {view !== 'day' && ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'].map(day => <div key={day} className="py-2 text-center text-xs font-semibold text-slate-500">{day}</div>)}
        {visibleDays.map(day => {
          const list = dayEvents(day)
          return <button key={day} onClick={() => setSelected(day === selected ? '' : day)} className={`min-h-28 rounded-lg border p-2 text-left ${day === selected ? 'border-blue-600 bg-blue-50' : 'border-slate-200'} ${day.startsWith(month) ? '' : 'opacity-50'}`}>
            <span className="text-sm font-semibold">{Number(day.slice(-2))}</span>
            <div className="mt-1 space-y-1">
              {list.slice(0, view === 'month' ? 3 : 12).map(e => <div key={e.id} className={`rounded border-l-4 px-1 py-1 text-[10px] ${originStyle(e.origin).bar} ${e.color}`}>
                <strong>{e.ref}</strong> · {e.code}<span className="block">{e.label}</span>
              </div>)}
              {view === 'month' && list.length > 3 && <span className="text-xs text-blue-700">+{list.length - 3} servicios</span>}
            </div>
          </button>
        })}
      </div>
      <div className="space-y-3 md:hidden">
        {visibleDays.filter(day => day.startsWith(month) && dayEvents(day).length).map(day => <div key={day} className="rounded-lg border p-3">
          <button onClick={() => setSelected(day === selected ? '' : day)} className="mb-2 font-semibold text-[#002855]">{new Date(`${day}T12:00:00-05:00`).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long' })}</button>
          {dayEvents(day).map(e => <div key={e.id} className={`mb-1 rounded border-l-4 p-2 text-xs ${originStyle(e.origin).bar} ${e.color}`}>{e.ref} · {e.code} · {e.label}</div>)}
        </div>)}
        {!visibleDays.some(day => dayEvents(day).length) && <p className="text-sm text-slate-500">No hay servicios en este período.</p>}
      </div>
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div><h2 className="font-bold text-[#002855]">Registro de solicitudes</h2><p className="text-xs text-slate-500">Ordenadas desde la registrada más recientemente{selected ? ` · ${selected}` : ''}</p></div>
        <div className="flex flex-wrap gap-2">
          <select aria-label="Fecha para filtrar solicitudes" value={basis} onChange={e => setBasis(e.target.value as typeof basis)} className="rounded-lg border p-2 text-sm"><option value="registered">Fecha de registro</option><option value="attention">Fecha de atención</option></select>
          {selected && <button onClick={() => setSelected('')} className="text-xs text-blue-700">Ver todo</button>}
          <input aria-label="Buscar solicitud u OT" value={search} onChange={e => setSearch(e.target.value)} placeholder="Solicitud, OT, OS/OC/RQ o destino" className="rounded-lg border p-2 text-sm" />
        </div>
      </div>
      <div className="overflow-x-auto"><DataTable className="w-full min-w-[1100px] text-left text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{['Registro', 'Solicitud', 'OT / Referencia', 'Servicio / Destino', 'Entrega solicitada', 'Primera fecha permitida', 'Anticipación', 'Estado'].map(h => <th key={h} className="p-3">{h}</th>)}</tr></thead>
        <tbody className="divide-y">
          {filtered.map(r => {
            const assessment = requestAnticipation(r), origin = portalOrigin(r), extra = portalExtraRefs(r)
            return <tr key={r.id}>
              <td className="whitespace-nowrap p-3">{portalTime(r.created_at)}</td>
              <td className="p-3"><button onClick={() => setDetail(r)} className="block text-left font-bold text-blue-800 hover:underline">{r.request_number}</button>{r.client_name && <span className="text-xs text-slate-500">{r.client_name}</span>}</td>
              <td className="p-3"><span className="flex items-center gap-1.5"><OriginBadge origin={origin} /><span className="font-semibold text-slate-800">{portalReference(r)}</span></span>
                {(r.parent_ot && (origin === 'SUB' || origin === 'ERR')) && <span className="block text-xs text-slate-500">OT madre {r.parent_ot}</span>}
                {extra.length > 0 && <span className="block text-xs text-slate-500">{extra.join(' · ')}</span>}</td>
              <td className="max-w-64 p-3"><span className="block font-medium">{r.request_type === 'RECOJO' ? 'Recojo' : r.request_type === 'TRASLADO' ? 'Punto a punto' : 'Entrega'} · {r.delivery_zone || 'Sin zona'}</span><span className="text-xs text-slate-500">{r.request_type === 'RECOJO' ? r.pickup_address : r.delivery_address}</span></td>
              <td className="p-3">{r.required_at ? portalTime(r.required_at) : `${r.required_date?.slice(0, 10) || '—'} · sin hora`}</td>
              <td className="p-3">{assessment.earliest ? portalAllowedTime(assessment.earliest) : '—'}</td>
              <td className={`p-3 text-xs font-medium ${assessment.color}`}>{assessment.label}</td>
              <td className="p-3 text-xs">{r.status.replaceAll('_', ' ')}</td>
            </tr>
          })}
          {!filtered.length && <tr><td colSpan={8} className="p-8 text-center text-slate-500">No hay solicitudes para los filtros seleccionados.</td></tr>}
        </tbody>
      </DataTable></div>
    </section>

    <Modal isOpen={Boolean(detail)} onClose={() => setDetail(null)} title={`Servicio · ${detail?.request_number || ''}`}>
      <div className="space-y-4 p-4 text-sm">{detail && <>
        <div className="grid gap-4 sm:grid-cols-2">
          <div><p className="text-xs text-slate-500">OT / Referencia</p><span className="flex items-center gap-1.5"><OriginBadge origin={portalOrigin(detail)} /><strong>{portalReference(detail)}</strong></span>
            {detail.parent_ot && <span className="block text-xs text-slate-500">OT madre {detail.parent_ot}</span>}
            {portalExtraRefs(detail).length > 0 && <span className="block text-xs text-slate-500">{portalExtraRefs(detail).join(' · ')}</span>}</div>
          <div><p className="text-xs text-slate-500">Estado</p>{detail.status.replaceAll('_', ' ')}</div>
          <div><p className="text-xs text-slate-500">Registro</p>{portalTime(detail.created_at)}</div>
          <div><p className="text-xs text-slate-500">Entrega solicitada</p>{detail.required_at ? portalTime(detail.required_at) : `${detail.required_date?.slice(0, 10) || '—'} · sin hora`}</div>
          <div><p className="text-xs text-slate-500">Origen</p>{detail.pickup_address}</div>
          <div><p className="text-xs text-slate-500">Destino</p>{detail.delivery_address}</div>
        </div>
        <p className={`rounded-lg bg-slate-50 p-3 ${requestAnticipation(detail).color}`}>{requestAnticipation(detail).label}{requestAnticipation(detail).earliest && ` · Primera fecha permitida: ${portalAllowedTime(requestAnticipation(detail).earliest)}`}</p>
        <p className="text-xs text-slate-500">La ruta programada, las guías y el Packing List se consultan en la pestaña «Ruta del día».</p>
      </>}</div>
    </Modal>
  </div>
}
