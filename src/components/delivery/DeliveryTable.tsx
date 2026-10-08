'use client'
import { DataTable } from '@/components/ui/data-table'

import { useMemo, useState } from 'react'
import { ChevronRight, Download, Eye, FileCheck2, RefreshCw, Search, Truck } from 'lucide-react'
import { districtOf } from '@/lib/address'
import { cellDateTime } from '@/lib/table-format'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { partyName, referenceLabel, requiresSupplier } from '@/lib/suppliers'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { conformityLabels, deliveryServiceKind, deliveryStatus, deliveryTime, filterDeliveries, type DeliveryRow } from '@/lib/delivery'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { SERVICE_KINDS, type ServiceKind } from '@/lib/request-service'

export function DeliverySignal({ state, onClick, compact = false }: { state: string; onClick?: () => void; compact?: boolean }) {
  const style = deliveryStatus(state)
  return <button type="button" onClick={onClick} title={onClick ? 'Ver historial de avance' : style.label}
    className={`inline-flex items-center gap-2 rounded-lg font-bold ${compact ? 'min-h-7 max-w-28 px-2 py-0.5 text-left text-[11px] leading-4' : 'min-h-10 px-2.5 py-1.5 text-xs'} ${style.color}`}>
    <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'motion-safe:animate-pulse' : ''}`} />
    {style.label}
  </button>
}

/** Guía y conformidad en un solo estado (el detalle se abre al hacer clic). */
function guideStatus(row: DeliveryRow): { label: string; tone: StatusTone; title: string } {
  const guide = row.guide_number ? `Guía ${row.guide_number}` : 'Sin guía'
  const photos = row.photos_count ? ` · ${row.photos_count} foto(s)` : ''
  if (row.state === 'PROGRAMADO' && row.documents_state && row.documents_state !== 'NO_REQUERIDO' && row.documents_state !== 'LISTO')
    return { label: row.documents_state === 'REEMISION' ? 'Por reemitir' : 'Salida pendiente', tone: row.documents_state === 'REEMISION' ? 'danger' : 'warning', title: 'Documentos de salida pendientes' }
  const map: Record<DeliveryRow['conformity'], [string, StatusTone]> = {
    PENDIENTE: ['Guía pendiente', 'warning'], RECIBIDA: ['Por validar', 'info'], VALIDADA: ['Conforme', 'success'],
    OBSERVADA: ['Observada', 'danger'], RECHAZADA: ['Rechazada', 'danger'], HISTORICA: ['Histórica', 'neutral'], NO_APLICA: ['No aplica', 'neutral'],
  }
  const [label, tone] = map[row.conformity]
  return { label, tone, title: `${guide}${photos} · ${conformityLabels[row.conformity]}` }
}
const hasOt = (row: DeliveryRow) => !!row.ot_code && row.ot_code !== 'Sin OT vinculada'
const conformityTone = (c: DeliveryRow['conformity']) => c === 'VALIDADA' ? 'text-emerald-700' : c === 'OBSERVADA' || c === 'RECHAZADA' ? 'text-red-700' : c === 'NO_APLICA' || c === 'HISTORICA' ? 'text-slate-600' : 'text-amber-800'

export function DeliveryTable({ rows, loading, error, refreshedAt, onRefresh, onEvidence, onDispatch, onProvider }: {
  rows: DeliveryRow[]; loading?: boolean; error?: string | null; refreshedAt?: string | null
  onRefresh: () => void; onEvidence?: (row: DeliveryRow) => void; onDispatch?: (row: DeliveryRow) => void; onProvider?: (row: DeliveryRow) => void
}) {
  const [search, setSearch] = useState(''), [state, setState] = useState(''), [conformity, setConformity] = useState(''), [service, setService] = useState('')
  const [page, setPage] = useState(0), [history, setHistory] = useState<DeliveryRow | null>(null)
  const [exporting, setExporting] = useState(false)
  const filtered = useMemo(() => filterDeliveries(rows, search, state, conformity).filter(row => !service || deliveryServiceKind(row) === service), [rows, search, state, conformity, service])
  const services = (Object.keys(SERVICE_KINDS) as ServiceKind[]).filter(kind => kind === service || rows.some(row => deliveryServiceKind(row) === kind))
  const pages = Math.max(1, Math.ceil(filtered.length / 25)), current = Math.min(page, pages - 1)
  const visible = filtered.slice(current * 25, (current + 1) * 25)
  const states = Array.from(new Set(rows.map(row => row.state)))
  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const book = XLSX.utils.book_new()
      const sheet = XLSX.utils.json_to_sheet(filtered.map(r => ({ Servicio: (k => k ? SERVICE_KINDS[k].label : '')(deliveryServiceKind(r)), OT: r.ot_code, Solicitud: r.request_number, Despacho: r.dispatch_number,
        Guía: r.guide_number || '', Cliente: r.client_name || '', Origen: r.pickup_address, Destino: r.delivery_address,
        Placa: r.plate, Conductor: r.driver_name || '', Transportista: r.carrier_name || '',
        Programado: deliveryTime(r.scheduled_departure), Estado: deliveryStatus(r.state).label,
        Conformidad: conformityLabels[r.conformity], Fotos: r.photos_count, Actualización: deliveryTime(r.last_event_at) })))
      XLSX.utils.book_append_sheet(book, sheet, 'Entregas')
      XLSX.writeFile(book, 'seguimiento-entregas.xlsx')
    } catch { toast.error('No se pudo exportar el seguimiento. Intente nuevamente.') } finally { setExporting(false) }
  }
  return <section className="min-w-0 max-w-full space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="text-lg font-bold text-[#002855]">OT y entregas <span className="text-sm font-normal text-slate-500">({filtered.length})</span></h2>
        <p className="text-xs text-slate-500">Una fila por entrega (OT). Última actualización: {deliveryTime(refreshedAt || null)}</p></div>
      <div className="flex gap-2">
        <button type="button" onClick={onRefresh} disabled={loading} className="flex min-h-10 items-center gap-1.5 rounded-lg border bg-white px-3 text-xs font-semibold disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        <button type="button" onClick={() => void exportRows()} disabled={exporting || !filtered.length || !!error} className="flex min-h-10 items-center gap-1.5 rounded-lg border bg-white px-3 text-xs font-semibold disabled:opacity-50"><Download className="h-4 w-4" />Excel</button>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      <label className="relative flex-1 min-w-48"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input aria-label="Buscar OT, guía, cliente, placa o proveedor" placeholder="OT, guía, cliente, placa o proveedor…" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} className="h-10 w-full rounded-lg border bg-white pl-9 pr-3 text-sm" /></label>
      {(services.length > 1 || !!service) && <select aria-label="Filtrar tipo de servicio" value={service} onChange={e => { setService(e.target.value); setPage(0) }} className="h-10 max-w-full rounded-lg border bg-white px-2 text-sm"><option value="">Todos los servicios</option>{services.map(kind => <option key={kind} value={kind}>{SERVICE_KINDS[kind].short}</option>)}</select>}
      <select aria-label="Filtrar estado operativo" value={state} onChange={e => { setState(e.target.value); setPage(0) }} className="h-10 max-w-full rounded-lg border bg-white px-2 text-sm"><option value="">Todos los estados</option>{states.map(s => <option key={s} value={s}>{deliveryStatus(s).label}</option>)}</select>
      <select aria-label="Filtrar conformidad" value={conformity} onChange={e => { setConformity(e.target.value); setPage(0) }} className="h-10 max-w-full rounded-lg border bg-white px-2 text-sm"><option value="">Todas las conformidades</option>{Object.entries(conformityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    </div>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} La información anterior puede estar desactualizada.</p>}
    <div className="overflow-x-auto rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
      <DataTable dense className="w-full min-w-[900px] text-left text-xs">
        <thead className="bg-slate-50 text-slate-600"><tr>{['Fecha', 'Servicio', 'OT', 'Unidad', 'Empresa', 'Destino', 'Guía y conformidad', 'Último evento', 'Acciones'].map((label, i) => <th key={label} className={`whitespace-nowrap font-semibold ${i === 8 ? 'text-right' : ''}`}>{label}</th>)}</tr></thead>
        <tbody className="divide-y">
          {!visible.length && <tr><td colSpan={9} className="p-8 text-center text-slate-500">{loading ? 'Cargando entregas…' : 'No hay entregas con los filtros seleccionados.'}</td></tr>}
          {visible.map(row => { const pickup = deliveryServiceKind(row) === 'RECOJO', point = pickup ? row.pickup_address : row.delivery_address, doc = guideStatus(row); return <tr key={`${row.dispatch_id}/${row.request_id}`} className="align-middle hover:bg-slate-50">
            <td className="whitespace-nowrap text-slate-700" title={deliveryTime(row.scheduled_departure)}>{cellDateTime(row.scheduled_departure)}</td>
            <td><ServiceTypeBadge kind={deliveryServiceKind(row)} /></td>
            <td className="whitespace-nowrap font-bold text-jrm-navy" title={`Solicitud ${row.request_number} · Despacho ${row.dispatch_number}`}>{hasOt(row) ? `OT ${row.ot_code}` : referenceLabel(row) || 'Sin OT'}</td>
            <td className="whitespace-nowrap font-bold" title={`${row.driver_name || (row.modalidad === 'RECOJO_CLIENTE' ? 'Unidad del cliente' : 'Sin conductor')}${row.modalidad === 'TERCERO' ? ` · Tercero${row.carrier_name ? ` (${row.carrier_name})` : ''}` : ''}`}>{row.plate || 'Sin placa'}{row.modalidad === 'TERCERO' && <span className="ml-1 text-[11px] font-semibold text-violet-700">T</span>}</td>
            <td className="max-w-36">{(() => { const party = partyName(row, row.client_name, row.supplier_name); return <p className="truncate font-semibold text-slate-800" title={party ? `${requiresSupplier(row) ? 'Proveedor' : 'Cliente'}: ${party}` : undefined}>{party || (requiresSupplier(row) ? 'Proveedor sin vincular' : 'Cliente sin vincular')}</p> })()}</td>
            <td className="max-w-32"><p className="truncate text-slate-700" title={`${pickup ? 'Origen' : 'Destino'}: ${point}`}>{districtOf(point)}</p></td>
            <td><button type="button" onClick={() => onEvidence ? onEvidence(row) : setHistory(row)} title={doc.title} className="inline-flex items-center gap-0.5 rounded-full focus-visible:outline-2 focus-visible:outline-jrm-navy"><StatusBadge tone={doc.tone}>{doc.label}</StatusBadge><ChevronRight aria-hidden className="h-3.5 w-3.5 text-slate-400" /></button></td>
            <td className="whitespace-nowrap" title={`Actualizado ${deliveryTime(row.last_event_at)}`}><DeliverySignal compact state={row.state} onClick={() => setHistory(row)} /></td>
            <td><div className="flex justify-end gap-1.5">
              <button type="button" onClick={() => setHistory(row)} title="Ver detalle" aria-label="Ver detalle" className="flex min-h-9 items-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 font-semibold text-jrm-navy hover:bg-slate-50"><Eye className="h-4 w-4" /><span className="hidden 2xl:inline">Ver detalle</span></button>
            </div></td>
          </tr> })}
        </tbody>
      </DataTable>
    </div>
    <div className="flex items-center justify-between gap-2 text-xs text-slate-500"><span>{filtered.length} entregas · Página {current + 1} de {pages}</span><div className="flex gap-2"><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">Anterior</button><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">Siguiente</button></div></div>
    <Modal isOpen={!!history} onClose={() => setHistory(null)} title={history ? `Detalle · ${history.ot_code ? `OT ${history.ot_code}` : 'Sin OT'} · ${history.request_number}` : 'Detalle'} maxWidth="max-w-3xl"
      footer={history && <div className="flex flex-wrap justify-end gap-2">
        {onProvider && history.modalidad === 'TERCERO' && <button type="button" onClick={() => { const r = history; setHistory(null); onProvider(r) }} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-blue-700">Acceso tercero</button>}
        {onDispatch && <button type="button" onClick={() => { const r = history; setHistory(null); onDispatch(r) }} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy"><Truck className="h-4 w-4" />Ver despacho {history.dispatch_number}</button>}
        {onEvidence && <button type="button" onClick={() => { const r = history; setHistory(null); onEvidence(r) }} className="flex min-h-10 items-center gap-1.5 rounded-lg bg-jrm-navy px-3 text-sm font-semibold text-white"><FileCheck2 className="h-4 w-4" />Guía y conformidad</button>}
      </div>}>
      {history && <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><DeliverySignal state={history.state} /><span className={`font-semibold ${conformityTone(history.conformity)}`}>Conformidad: {conformityLabels[history.conformity]}</span></div>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {([
            ['Tipo de servicio', (k => k ? SERVICE_KINDS[k].label : 'Sin identificar')(deliveryServiceKind(history))],
            ['OT', hasOt(history) ? history.ot_code : 'Sin OT'], ['Documento', referenceLabel(history) || 'Sin documento'], ['Solicitud', history.request_number], ['Despacho', history.dispatch_number],
            ['Cliente', history.client_name || 'Cliente sin vincular'], ['Proveedor', history.supplier_name || (requiresSupplier(history) ? 'Proveedor sin vincular' : 'No aplica')], ['Programación', deliveryTime(history.scheduled_departure)],
            ['Llegada a destino', history.arrived_at ? deliveryTime(history.arrived_at) : 'Sin registrar'],
            ['Origen', history.pickup_address || '—'], ['Destino', history.delivery_address || '—'],
            ['Unidad', history.plate || 'Sin placa'], ['Conductor', history.driver_name || 'Sin conductor'],
            ['Proveedor / modalidad', history.carrier_name || (history.modalidad === 'RECOJO_CLIENTE' ? 'Recojo por cliente' : history.modalidad === 'TERCERO' ? 'Tercero' : 'Transporte propio')],
            ['Guía de entrega', history.guide_number || 'Pendiente'],
            ['Documentos de salida', !history.documents_state || history.documents_state === 'NO_REQUERIDO' ? 'No requeridos' : history.documents_state === 'LISTO' ? 'Listos' : history.documents_state === 'REEMISION' ? 'Por reemitir' : 'Pendientes'],
            ['Fotos de entrega', `${history.photos_count}`],
            ['Último evento', deliveryTime(history.last_event_at)],
            ...(history.modalidad !== 'TERCERO' && history.modalidad !== 'RECOJO_CLIENTE' ? [['GPS', history.gps_at ? `${refreshedAt && Date.parse(refreshedAt) - Date.parse(history.gps_at) > 180000 ? 'Desactualizado · ' : ''}${deliveryTime(history.gps_at)}` : 'Sin señal registrada']] : []),
          ] as [string, string][]).map(([k, v]) => <div key={k} className="min-w-0"><dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{k}</dt><dd className="mt-0.5 break-words text-slate-800">{v}</dd></div>)}
        </dl>
        <div><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Historial de avance</h3>
          {history.events.length ? <ol className="space-y-3">{history.events.map((event, i) => <li key={`${event.at}/${i}`} className="border-l-2 border-blue-200 pl-3"><p className="text-xs text-slate-500">{deliveryTime(event.at)}</p><p className="font-semibold">{event.type.replaceAll('_', ' ')}</p>{event.description && <p>{event.description}</p>}</li>)}</ol> : <p className="text-slate-500">Sin eventos registrados.</p>}</div>
      </div>}
    </Modal>
  </section>
}
