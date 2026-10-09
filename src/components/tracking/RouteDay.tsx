'use client'
import { useMemo } from 'react'
import { ChevronLeft, ChevronRight, RefreshCw, Truck } from 'lucide-react'
import { limaDay } from '@/lib/tracking-calendar'
import { portalExtraRefs, portalOrigin, portalReference, portalStatus, type PortalRow } from '@/lib/tracking-portal'
import { OriginBadge, PortalDocButtons, StatusPill } from '@/components/tracking/PortalBits'

// Ruta establecida del día en el portal público: cada ruta con su unidad, conductor y paradas autorizadas, y por
// parada la guía de remisión, el Packing List y (una vez validada) la guía firmada en destino.

type Props = {
  rows: PortalRow[]; day: string; onDay: (day: string) => void
  access: { token: string; pin: string }; refreshedAt: string | null; error?: string; onRefresh: () => void
}
const DISPATCH_LABEL: Record<string, string> = { PROGRAMADO: 'Programada', EN_CURSO: 'En ruta', 'EN RUTA': 'En ruta', ENTREGADO: 'Entregada', LIQUIDADO: 'Cerrada', CERRADO: 'Cerrada', CANCELADO: 'Cancelada' }
const time = (value: string) => new Date(value).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false })
const shift = (day: string, n: number) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }

export function RouteDay({ rows, day, onDay, access, refreshedAt, error, onRefresh }: Props) {
  const routes = useMemo(() => {
    const map = new Map<string, PortalRow[]>()
    rows.filter(r => limaDay(r.scheduled_departure) === day).forEach(r => map.set(r.dispatch_id, [...(map.get(r.dispatch_id) || []), r]))
    return [...map.values()].map(stops => stops.sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0)))
      .sort((a, b) => new Date(a[0].scheduled_departure).getTime() - new Date(b[0].scheduled_departure).getTime())
  }, [rows, day])
  const stops = routes.flat()
  const docs = stops.reduce((n, s) => n + (s.documents || []).filter(d => d.type === 'PACKING_LIST').length + Math.min(s.packing_photos || 0, 5) + Math.min(s.signed_photos || 0, 5), 0)
  const delivered = stops.filter(s => ['ENTREGADO', 'LIQUIDADO', 'CERRADO'].includes(s.state)).length

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <div>
        <h2 className="text-lg font-bold text-[#002855]">Ruta establecida del día</h2>
        <p className="text-xs text-slate-500">{new Date(`${day}T12:00:00-05:00`).toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}{refreshedAt ? ` · actualizado ${time(refreshedAt)}` : ''}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button aria-label="Día anterior" onClick={() => onDay(shift(day, -1))} className="grid min-h-10 w-10 place-items-center rounded-lg border"><ChevronLeft className="h-4 w-4" /></button>
        <input type="date" aria-label="Día de la ruta" value={day} onChange={e => e.target.value && onDay(e.target.value)} className="min-h-10 rounded-lg border px-2" />
        <button aria-label="Día siguiente" onClick={() => onDay(shift(day, 1))} className="grid min-h-10 w-10 place-items-center rounded-lg border"><ChevronRight className="h-4 w-4" /></button>
        <button onClick={() => onDay(limaDay(new Date().toISOString()))} className="min-h-10 rounded-lg border px-3 text-sm">Hoy</button>
        <button onClick={onRefresh} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button>
      </div>
    </div>
    {error && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{error}</p>}

    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[
      { label: 'Rutas del día', value: routes.length }, { label: 'Paradas', value: stops.length },
      { label: 'Entregadas', value: delivered }, { label: 'Documentos disponibles', value: docs },
    ].map(k => <div key={k.label} className="rounded-xl border bg-white p-4"><p className="text-xs text-slate-500">{k.label}</p><strong className="text-2xl tabular-nums text-[#002855]">{k.value}</strong></div>)}</div>

    {routes.length === 0 && <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center text-sm text-slate-500">No hay rutas programadas para este día.</div>}

    {routes.map(route => {
      const head = route[0]
      return <section key={head.dispatch_id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-slate-50 px-4 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-[#002855] text-white"><Truck className="h-5 w-5" /></span>
            <div className="min-w-0">
              <p className="font-bold text-[#002855]">Ruta {head.dispatch_number} · salida {time(head.scheduled_departure)}</p>
              <p className="truncate text-xs text-slate-600">{head.modalidad === 'RECOJO_CLIENTE' ? 'Recojo por el cliente' : <>Placa <b>{head.plate || 'por asignar'}</b> · {head.driver_name || 'Conductor por asignar'}{head.modalidad === 'TERCERO' && head.carrier_name ? ` · ${head.carrier_name}` : ''}</>}</p>
            </div>
          </div>
          <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-semibold text-slate-700">{DISPATCH_LABEL[head.dispatch_status || ''] || (head.dispatch_status || '').replaceAll('_', ' ')} · {route.length} parada(s)</span>
        </header>
        <ol className="divide-y">
          {route.map((s, i) => {
            const origin = portalOrigin(s), extra = portalExtraRefs(s)
            return <li key={s.request_id} className="grid gap-3 px-4 py-3 lg:grid-cols-[2rem_minmax(0,1.3fr)_minmax(0,1.6fr)_10rem_minmax(0,1.4fr)] lg:items-center">
              <span className="grid h-7 w-7 place-items-center rounded-full bg-slate-100 text-xs font-bold text-slate-700">{s.sequence_order ?? i + 1}</span>
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1.5"><OriginBadge origin={origin} /><span className="font-semibold text-slate-900">{portalReference(s)}</span></p>
                <p className="text-xs text-slate-500">{s.request_number}{extra.length ? ` · ${extra.join(' · ')}` : ''}{s.client_name ? ` · ${s.client_name}` : ''}</p>
              </div>
              <p className="min-w-0 text-sm text-slate-700"><span className="block truncate" title={s.delivery_address}>{s.delivery_address}</span>{s.guide_number && <span className="text-xs text-slate-500">Guía {s.guide_number}</span>}</p>
              <span className="w-fit"><StatusPill tone={portalStatus(s)} /></span>
              <PortalDocButtons row={s} access={access} emptyText="El conductor sube la guía y el Packing List al entregar." />
            </li>
          })}
        </ol>
      </section>
    })}
    <p className="text-xs text-slate-500">Los documentos se abren en una pestaña nueva con un enlace temporal. La guía de remisión y el Packing List aparecen cuando el conductor los sube desde el app o el enlace.</p>
  </div>
}
