'use client'
import { DataTable } from '@/components/ui/data-table'

import { useMemo, useState, type ReactNode } from 'react'
import { RouteCrewDetails } from '@/components/despacho/RouteCrewDetails'
import { ChevronRight, Download, Eye, FileCheck2, Link2, RefreshCw, Search, Truck } from 'lucide-react'
import { districtOf } from '@/lib/address'
import { cellDateTime } from '@/lib/table-format'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { partyName, referenceLabel, requiresSupplier } from '@/lib/suppliers'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { conformityLabels, deliveryServiceKind, deliveryStatus, deliveryTime, documentNumberLabel, filterDeliveries, type DeliveryRow } from '@/lib/delivery'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { SERVICE_KINDS, type ServiceKind } from '@/lib/request-service'
import { canAddRouteService } from '@/lib/route-assignment'
import { compareCells, type SortDirection } from '@/components/ui/table-sort'
import { routeIds } from '@/lib/route-share'

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
    RECHAZO_DESTINO: ['Rechazo en destino', 'danger'],
  }
  if (row.state === 'RECHAZADO_DESTINO') return { label: 'Rechazo en destino', tone: 'danger', title: 'El cliente rechazó la entrega: se liquida con la evidencia del rechazo' }
  const [label, tone] = map[row.conformity]
  return { label, tone, title: `${guide}${photos} · ${conformityLabels[row.conformity]}` }
}
const hasOt = (row: DeliveryRow) => !!row.ot_code && row.ot_code !== 'Sin OT vinculada'
const conformityTone = (c: DeliveryRow['conformity']) => c === 'VALIDADA' ? 'text-emerald-700' : c === 'OBSERVADA' || c === 'RECHAZADA' ? 'text-red-700' : c === 'NO_APLICA' || c === 'HISTORICA' ? 'text-slate-600' : 'text-amber-800'

export function DeliveryTable({ rows, loading, error, refreshedAt, onRefresh, onEvidence, onDispatch, onProvider, onAddService, onShareRoutes, onCancelRoute, cancelableRoutes = [], showCrewDetails = false, renderManualClose, renderDetail }: {
  rows: DeliveryRow[]; loading?: boolean; error?: string | null; refreshedAt?: string | null
  onRefresh: () => void; onEvidence?: (row: DeliveryRow) => void; onDispatch?: (row: DeliveryRow) => void; onProvider?: (row: DeliveryRow) => void; onAddService?: (row: DeliveryRow) => void
  showCrewDetails?: boolean; renderManualClose?: (row: DeliveryRow, closeDetail: () => void) => ReactNode
  /** Detalle propio de la pantalla (Torre de Control); sin él se usa el detalle simple (portal público). */
  renderDetail?: (row: DeliveryRow, controls: { close: () => void; select: (row: DeliveryRow) => void }) => ReactNode
  onShareRoutes?: (ids: string[]) => void; onCancelRoute?: (id: string) => void; cancelableRoutes?: string[]
}) {
  const [search, setSearch] = useState(''), [state, setState] = useState(''), [conformity, setConformity] = useState(''), [service, setService] = useState('')
  const [page, setPage] = useState(0), [history, setHistory] = useState<DeliveryRow | null>(null)
  const [exporting, setExporting] = useState(false)
  const [sort, setSort] = useState<{ column: number; direction: SortDirection } | null>(null)
  const [selectedRoutes, setSelectedRoutes] = useState<string[]>([])
  const selected = selectedRoutes.filter(id => rows.some(row => row.dispatch_id === id))
  const toggleRoute = (id: string, checked: boolean) => setSelectedRoutes(ids => checked ? [...new Set([...ids, id])] : ids.filter(x => x !== id))
  const filtered = useMemo(() => filterDeliveries(rows, search, state, conformity).filter(row => !service || deliveryServiceKind(row) === service), [rows, search, state, conformity, service])
  const services = (Object.keys(SERVICE_KINDS) as ServiceKind[]).filter(kind => kind === service || rows.some(row => deliveryServiceKind(row) === kind))
  const pages = Math.max(1, Math.ceil(filtered.length / 25)), current = Math.min(page, pages - 1)
  // Orden sobre todas las entregas filtradas (no solo la página visible); mismas columnas de la tabla
  const sortedRows = useMemo(() => {
    if (!sort) return filtered
    const value = (row: DeliveryRow): string => {
      switch (sort.column) {
        case 0: return row.scheduled_departure ? new Date(row.scheduled_departure).toISOString() : ''
        case 1: return (k => k ? SERVICE_KINDS[k].label : '')(deliveryServiceKind(row))
        case 2: return hasOt(row) ? row.ot_code : referenceLabel(row) || ''
        case 3: return row.dispatch_number || ''
        case 4: return row.plate || ''
        case 5: return partyName(row, row.client_name, row.supplier_name) || ''
        case 6: return districtOf(deliveryServiceKind(row) === 'RECOJO' ? row.pickup_address : row.delivery_address)
        case 7: return documentNumberLabel(row.guide_number, row.note_number).pending ? '' : documentNumberLabel(row.guide_number, row.note_number).text
        case 8: return guideStatus(row).label
        case 9: return row.last_event_at ? new Date(row.last_event_at).toISOString() : ''
        default: return ''
      }
    }
    return [...filtered].sort((a, b) => compareCells(value(a), value(b), sort.direction))
  }, [filtered, sort])
  const visible = sortedRows.slice(current * 25, (current + 1) * 25)
  const states = Array.from(new Set(rows.map(row => row.state)))
  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const book = XLSX.utils.book_new()
      const sheet = XLSX.utils.json_to_sheet(filtered.map(r => ({ Servicio: (k => k ? SERVICE_KINDS[k].label : '')(deliveryServiceKind(r)), OT: r.ot_code, Solicitud: r.request_number, Despacho: r.dispatch_number,
        Guía: r.guide_number || '', 'Nota de Despacho': r.note_number || '', Cliente: r.client_name || '', Origen: r.pickup_address, Destino: r.delivery_address,
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
        <p className="text-xs text-slate-500">Una fila por entrega (OT). Última actualización: {deliveryTime(refreshedAt || null)}</p>{onShareRoutes && <p className="mt-1 text-xs text-slate-500">Seleccione las rutas que desea compartir. Cada ruta incluye todas sus entregas.</p>}</div>
      <div className="flex gap-2">
        {onShareRoutes && <button type="button" disabled={!selected.length || !!error} onClick={() => onShareRoutes(selected)} className="min-h-10 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white disabled:opacity-50">Compartir {selected.length ? `${selected.length} ruta(s)` : 'rutas'}</button>}
        {onShareRoutes && selected.length > 0 && <button type="button" onClick={() => setSelectedRoutes([])} className="min-h-10 rounded-lg border px-3 text-xs">Limpiar selección</button>}
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
      <DataTable dense className="w-full min-w-[1060px] text-left text-xs" onSortChange={next => { setSort(next ? { ...next, column: next.column - (onShareRoutes ? 1 : 0) } : null); setPage(0) }}>
        <thead className="bg-slate-50 text-slate-600"><tr>{onShareRoutes && <th><input type="checkbox" aria-label="Seleccionar todas las rutas filtradas" checked={filtered.length > 0 && routeIds(filtered).every(id => selected.includes(id))} onChange={e => { const ids = routeIds(filtered); setSelectedRoutes(prev => e.target.checked ? [...new Set([...prev, ...ids])] : prev.filter(id => !ids.includes(id))) }} /></th>}{['Fecha', 'Servicio', 'OT', 'N.º despacho', 'Unidad', 'Empresa', 'Destino', 'GR / Nota', 'Conformidad', 'Último evento', 'Acciones'].map((label, i) => <th key={label} className={`whitespace-nowrap font-semibold ${i === 10 ? 'text-right' : ''}`}>{label}</th>)}</tr></thead>
        <tbody className="divide-y">
          {!visible.length && <tr><td colSpan={onShareRoutes ? 12 : 11} className="p-8 text-center text-slate-500">{loading ? 'Cargando entregas…' : 'No hay entregas con los filtros seleccionados.'}</td></tr>}
          {visible.map(row => { const pickup = deliveryServiceKind(row) === 'RECOJO', point = pickup ? row.pickup_address : row.delivery_address, doc = guideStatus(row); return <tr key={`${row.dispatch_id}/${row.request_id}`} className="align-middle hover:bg-slate-50">
            {onShareRoutes && <td><input type="checkbox" aria-label={`Seleccionar ruta ${row.dispatch_number} · ${row.request_number}`} checked={selected.includes(row.dispatch_id)} onChange={e => toggleRoute(row.dispatch_id, e.target.checked)} /></td>}
            <td className="whitespace-nowrap text-slate-700" title={deliveryTime(row.scheduled_departure)}>{cellDateTime(row.scheduled_departure)}</td>
            <td><ServiceTypeBadge kind={deliveryServiceKind(row)} /></td>
            <td className="whitespace-nowrap font-bold text-jrm-navy" title={`Solicitud ${row.request_number} · Despacho ${row.dispatch_number}`}>{hasOt(row) ? `OT ${row.ot_code}` : referenceLabel(row) || 'Sin OT'}</td>
            <td className="whitespace-nowrap font-semibold tabular-nums text-jrm-navy">{row.dispatch_number || 'Sin número'}</td>
            <td className="whitespace-nowrap font-bold" title={`${row.driver_name || (row.modalidad === 'RECOJO_CLIENTE' ? 'Unidad del cliente' : 'Sin conductor')}${row.modalidad === 'TERCERO' ? ` · Tercero${row.carrier_name ? ` (${row.carrier_name})` : ''}` : ''}`}>{row.plate || 'Sin placa'}{row.modalidad === 'TERCERO' && <span className="ml-1 text-[11px] font-semibold text-violet-700">T</span>}</td>
            <td className="max-w-36">{(() => { const party = partyName(row, row.client_name, row.supplier_name); return <p className="truncate font-semibold text-slate-800" title={party ? `${requiresSupplier(row) ? 'Proveedor' : 'Cliente'}: ${party}` : undefined}>{party || (requiresSupplier(row) ? 'Proveedor sin vincular' : 'Cliente sin vincular')}</p> })()}</td>
            <td className="max-w-32"><p className="truncate text-slate-700" title={`${pickup ? 'Origen' : 'Destino'}: ${point}`}>{districtOf(point)}</p></td>
            <td className="whitespace-nowrap">{(n => <span title={n.title} className={n.pending ? 'text-xs font-semibold text-amber-700' : 'font-semibold text-slate-800'}>{n.text}</span>)(documentNumberLabel(row.guide_number, row.note_number))}</td>
            <td><button type="button" onClick={() => onEvidence ? onEvidence(row) : setHistory(row)} title={doc.title} className="inline-flex items-center gap-0.5 rounded-full focus-visible:outline-2 focus-visible:outline-jrm-navy"><StatusBadge tone={doc.tone}>{doc.label}</StatusBadge><ChevronRight aria-hidden className="h-3.5 w-3.5 text-slate-400" /></button></td>
            <td className="whitespace-nowrap" title={`Actualizado ${deliveryTime(row.last_event_at)}`}><DeliverySignal compact state={row.state} onClick={() => setHistory(row)} /></td>
            <td><div className="flex justify-end gap-1.5">
              {onCancelRoute && cancelableRoutes.includes(row.dispatch_id) && <button type="button" onClick={() => onCancelRoute(row.dispatch_id)} className="min-h-9 rounded-lg border border-red-200 px-2.5 font-semibold text-red-700">Cancelar ruta</button>}
              {onAddService && canAddRouteService({ status: row.state, plate: row.plate, scheduled_departure: row.scheduled_departure }) && <button type="button" onClick={() => onAddService(row)} className="min-h-9 whitespace-nowrap rounded-lg border border-blue-200 bg-blue-50 px-2.5 font-semibold text-jrm-navy">Agregar servicio</button>}
              {onProvider && row.modalidad === 'TERCERO' && ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'EN_RUTA'].includes(row.state) && <button type="button" onClick={() => onProvider(row)} title="Ver portal, placa y código para compartir con el tercero" className="flex min-h-9 items-center gap-1 whitespace-nowrap rounded-lg border border-violet-200 bg-violet-50 px-2.5 font-semibold text-violet-800 hover:bg-violet-100"><Link2 className="h-4 w-4" />Compartir acceso GR</button>}
              <button type="button" onClick={() => setHistory(row)} title="Ver detalle" aria-label="Ver detalle" className="flex min-h-9 items-center gap-1 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-2.5 font-semibold text-jrm-navy hover:bg-slate-50"><Eye className="h-4 w-4" /><span className="hidden 2xl:inline">Ver detalle</span></button>
            </div></td>
          </tr> })}
        </tbody>
      </DataTable>
    </div>
    <div className="flex items-center justify-between gap-2 text-xs text-slate-500"><span>{filtered.length} entregas · Página {current + 1} de {pages}</span><div className="flex gap-2"><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">Anterior</button><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">Siguiente</button></div></div>
    {renderDetail && history && renderDetail(history, { close: () => setHistory(null), select: setHistory })}
    <Modal isOpen={!!history && !renderDetail} onClose={() => setHistory(null)} title={history ? `Detalle · Despacho ${history.dispatch_number} · ${history.request_number}` : 'Detalle'} maxWidth="max-w-7xl"
      footer={history && <div className="flex flex-wrap justify-end gap-2">
        {renderManualClose?.(history, () => setHistory(null))}
        {onAddService && canAddRouteService({ status: history.state, plate: history.plate, scheduled_departure: history.scheduled_departure }) && <button type="button" onClick={() => { const r = history; setHistory(null); onAddService(r) }} className="min-h-10 rounded-lg bg-jrm-navy px-3 text-sm font-semibold text-white">Agregar servicio a la ruta</button>}
        {onProvider && history.modalidad === 'TERCERO' && <button type="button" onClick={() => { const r = history; setHistory(null); onProvider(r) }} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-blue-700">Compartir acceso GR · tercero</button>}
        {onDispatch && <button type="button" onClick={() => { const r = history; setHistory(null); onDispatch(r) }} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy"><Truck className="h-4 w-4" />Ver despacho {history.dispatch_number}</button>}
        {onEvidence && <button type="button" onClick={() => { const r = history; setHistory(null); onEvidence(r) }} className="flex min-h-10 items-center gap-1.5 rounded-lg bg-jrm-navy px-3 text-sm font-semibold text-white"><FileCheck2 className="h-4 w-4" />Guía y conformidad</button>}
      </div>}>
      {history && <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2"><DeliverySignal state={history.state} /><span className={`font-semibold ${conformityTone(history.conformity)}`}>Conformidad: {conformityLabels[history.conformity]}</span></div>
        <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(18rem,1fr)]">
          <div className="min-w-0 space-y-5">
            {([
              ['Servicio y referencias', [
                ['Tipo de servicio', (k => k ? SERVICE_KINDS[k].label : 'Sin identificar')(deliveryServiceKind(history))],
                ['N.º despacho', history.dispatch_number], ['Solicitud', history.request_number],
                ['OT', hasOt(history) ? history.ot_code : 'Sin OT'], ['Documento de referencia', referenceLabel(history) || 'Sin documento'],
                ['Cliente', history.client_name || 'Cliente sin vincular'], ['Proveedor', history.supplier_name || (requiresSupplier(history) ? 'Proveedor sin vincular' : 'No aplica')],
              ]],
              ['Ruta y programación', [
                ['Programación', deliveryTime(history.scheduled_departure)], ['Llegada a destino', history.arrived_at ? deliveryTime(history.arrived_at) : 'Sin registrar'],
                ['Origen', history.pickup_address || '—'], ['Destino', history.delivery_address || '—'],
              ]],
              ['Unidad y conductor', [
                ['Unidad', history.plate || 'Sin placa'], ['Conductor', history.driver_name || 'Sin conductor'],
                ['Proveedor / modalidad', history.carrier_name || (history.modalidad === 'RECOJO_CLIENTE' ? 'Recojo por cliente' : history.modalidad === 'TERCERO' ? 'Tercero' : 'Transporte propio')],
                ...(history.modalidad !== 'TERCERO' && history.modalidad !== 'RECOJO_CLIENTE' ? [['GPS', history.gps_at ? `${refreshedAt && Date.parse(refreshedAt) - Date.parse(history.gps_at) > 180000 ? 'Desactualizado · ' : ''}${deliveryTime(history.gps_at)}` : 'Sin señal registrada']] : []),
              ]],
              ['Documentos y conformidad', [
                ['Guía de entrega', history.guide_number || 'Pendiente'],
                ['Documentos de salida', !history.documents_state || history.documents_state === 'NO_REQUERIDO' ? 'No requeridos' : history.documents_state === 'LISTO' ? 'Listos' : history.documents_state === 'REEMISION' ? 'Por reemitir' : 'Pendientes'],
                ['Conformidad', conformityLabels[history.conformity]], ['Fotos de entrega', `${history.photos_count}`],
              ]],
            ] as [string,[string,string][]][]).map(([title,fields]) => <section key={title} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <h3 className="mb-3 font-bold text-slate-800">{title}</h3><dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                {fields.map(([name,value]) => <div key={name} className="min-w-0"><dt className="text-xs font-medium text-slate-500">{name}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-slate-800">{value}</dd></div>)}
              </dl>
            </section>)}
            {showCrewDetails && <RouteCrewDetails key={history.dispatch_id} dispatchId={history.dispatch_id} />}
          </div>
          <section className="min-w-0 rounded-xl border border-slate-200 p-4">
            <h3 className="mb-1 font-bold text-slate-800">Bitácora e historial de avance</h3>
            <p className="mb-4 text-xs text-slate-500">Última actualización: {deliveryTime(history.last_event_at)}</p>
            {history.events.length ? <ol className="space-y-4">{history.events.map((event,index) => <li key={`${event.at}/${index}`} className="border-l-2 border-blue-200 pl-3"><p className="text-xs text-slate-500">{deliveryTime(event.at)}</p><p className="font-semibold">{event.type.replaceAll('_',' ')}</p>{event.description && <p className="mt-1 whitespace-pre-wrap break-words text-slate-700">{event.description}</p>}</li>)}</ol> : <p className="text-slate-500">Sin eventos registrados.</p>}
          </section>
        </div>
      </div>}
    </Modal>
  </section>
}
