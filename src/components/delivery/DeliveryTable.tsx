'use client'
import { DataTable } from '@/components/ui/data-table'

import { useMemo, useState } from 'react'
import { Download, FileCheck2, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { conformityLabels, deliveryStatus, deliveryTime, filterDeliveries, type DeliveryRow } from '@/lib/delivery'

export function DeliverySignal({ state, onClick }: { state: string; onClick?: () => void }) {
  const style = deliveryStatus(state)
  return <button type="button" onClick={onClick} title={onClick ? 'Ver historial de avance' : style.label}
    className={`inline-flex min-h-10 items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-bold ${style.color}`}>
    <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot} ${style.pulse ? 'motion-safe:animate-pulse' : ''}`} />
    {style.label}
  </button>
}

export function DeliveryTable({ rows, loading, error, refreshedAt, onRefresh, onEvidence, onDispatch, onProvider }: {
  rows: DeliveryRow[]; loading?: boolean; error?: string | null; refreshedAt?: string | null
  onRefresh: () => void; onEvidence?: (row: DeliveryRow) => void; onDispatch?: (row: DeliveryRow) => void; onProvider?: (row: DeliveryRow) => void
}) {
  const [search, setSearch] = useState(''), [state, setState] = useState(''), [conformity, setConformity] = useState('')
  const [page, setPage] = useState(0), [history, setHistory] = useState<DeliveryRow | null>(null)
  const [exporting, setExporting] = useState(false)
  const filtered = useMemo(() => filterDeliveries(rows, search, state, conformity), [rows, search, state, conformity])
  const pages = Math.max(1, Math.ceil(filtered.length / 25)), current = Math.min(page, pages - 1)
  const visible = filtered.slice(current * 25, (current + 1) * 25)
  const states = Array.from(new Set(rows.map(row => row.state)))
  const exportRows = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const book = XLSX.utils.book_new()
      const sheet = XLSX.utils.json_to_sheet(filtered.map(r => ({ OT: r.ot_code, Solicitud: r.request_number, Despacho: r.dispatch_number,
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
        <p className="text-xs text-slate-500">Una fila por entrega. Última actualización: {deliveryTime(refreshedAt || null)}</p></div>
      <div className="flex gap-2">
        <button type="button" onClick={onRefresh} disabled={loading} className="flex min-h-10 items-center gap-1.5 rounded-lg border bg-white px-3 text-xs font-semibold disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        <button type="button" onClick={() => void exportRows()} disabled={exporting || !filtered.length || !!error} className="flex min-h-10 items-center gap-1.5 rounded-lg border bg-white px-3 text-xs font-semibold disabled:opacity-50"><Download className="h-4 w-4" />Excel</button>
      </div>
    </div>
    <div className="flex flex-wrap gap-2">
      <label className="relative flex-1 min-w-48"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input aria-label="Buscar OT, guía, cliente, placa o proveedor" placeholder="OT, guía, cliente, placa o proveedor…" value={search} onChange={e => { setSearch(e.target.value); setPage(0) }} className="h-10 w-full rounded-lg border bg-white pl-9 pr-3 text-sm" /></label>
      <select aria-label="Filtrar estado operativo" value={state} onChange={e => { setState(e.target.value); setPage(0) }} className="h-10 max-w-full rounded-lg border bg-white px-2 text-sm"><option value="">Todos los estados</option>{states.map(s => <option key={s} value={s}>{deliveryStatus(s).label}</option>)}</select>
      <select aria-label="Filtrar conformidad" value={conformity} onChange={e => { setConformity(e.target.value); setPage(0) }} className="h-10 max-w-full rounded-lg border bg-white px-2 text-sm"><option value="">Todas las conformidades</option>{Object.entries(conformityLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    </div>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} La información anterior puede estar desactualizada.</p>}
    <div className="overflow-x-auto rounded-xl border bg-white shadow-sm">
      <DataTable className="w-full min-w-[1150px] text-left text-xs">
        <thead className="bg-slate-50 text-slate-600"><tr>{['OT · solicitud · guía','Cliente · recorrido','Unidad · proveedor','Programación','Avance','Conformidad','Último evento','Acciones'].map((label, i) => <th key={label} className={`px-3 py-3 font-semibold ${i === 0 ? 'sticky left-0 z-10 bg-slate-50' : ''}`}>{label}</th>)}</tr></thead>
        <tbody className="divide-y">
          {!visible.length && <tr><td colSpan={8} className="p-8 text-center text-slate-500">{loading ? 'Cargando entregas…' : 'No hay entregas con los filtros seleccionados.'}</td></tr>}
          {visible.map(row => <tr key={`${row.dispatch_id}/${row.request_id}`} className="align-top hover:bg-slate-50">
            <td className="sticky left-0 min-w-40 max-w-48 break-words bg-white px-3 py-3"><p className="font-bold text-[#002855]">{row.ot_code}</p><p className="mt-1">{row.request_number}</p><p className="mt-1 text-slate-500">Guía: {row.guide_number || 'Pendiente'}</p>{row.state === 'PROGRAMADO' && row.documents_state && row.documents_state !== 'NO_REQUERIDO' && <p className="mt-1 text-amber-800">{row.documents_state === 'LISTO' ? 'Guías de salida listas' : row.documents_state === 'REEMISION' ? 'Guías por reemitir' : 'Guías de salida pendientes'}</p>}<button type="button" onClick={() => onDispatch ? onDispatch(row) : setHistory(row)} className="mt-1 text-blue-700 underline">{row.dispatch_number}</button></td>
            <td className="max-w-64 px-3 py-3"><p className="font-semibold">{row.client_name || 'Cliente sin vincular'}</p><p className="mt-1 text-slate-500">{row.pickup_address}</p><p className="mt-1">→ {row.delivery_address}</p></td>
            <td className="px-3 py-3"><p className="font-bold">{row.plate || 'Sin placa'}</p><p className="mt-1">{row.driver_name || 'Sin conductor'}</p><p className="mt-1 text-slate-500">{row.carrier_name || (row.modalidad === 'RECOJO_CLIENTE' ? 'Recojo por cliente' : row.modalidad === 'TERCERO' ? 'Tercero' : 'Transporte propio')}</p></td>
            <td className="whitespace-nowrap px-3 py-3">{deliveryTime(row.scheduled_departure)}</td>
            <td className="px-3 py-3"><DeliverySignal state={row.state} onClick={() => setHistory(row)} />{row.arrived_at && <p className="mt-1 text-slate-500">Llegada {deliveryTime(row.arrived_at)}</p>}</td>
            <td className="px-3 py-3"><p className={`font-semibold ${row.conformity === 'VALIDADA' ? 'text-emerald-700' : row.conformity === 'OBSERVADA' || row.conformity === 'RECHAZADA' ? 'text-red-700' : 'text-amber-800'}`}>{conformityLabels[row.conformity]}</p><p className="mt-1 text-slate-500">{row.photos_count} foto(s)</p>{row.conformity !== 'VALIDADA' && row.conformity !== 'HISTORICA' && row.conformity !== 'NO_APLICA' && <p className="mt-1 text-slate-500">Avance bloqueado</p>}</td>
            <td className="whitespace-nowrap px-3 py-3"><p>{deliveryTime(row.last_event_at)}</p>{row.modalidad !== 'TERCERO' && row.modalidad !== 'RECOJO_CLIENTE' && <p className="mt-1 text-slate-500">{row.gps_at && refreshedAt && Date.parse(refreshedAt) - Date.parse(row.gps_at) > 180000 ? 'GPS desactualizado: ' : 'GPS: '}{row.gps_at ? deliveryTime(row.gps_at) : 'sin señal registrada'}</p>}</td>
            <td className="px-3 py-3">{onEvidence ? <button type="button" onClick={() => onEvidence(row)} className="flex min-h-10 items-center gap-1.5 rounded-lg border px-2 font-semibold text-[#002855]"><FileCheck2 className="h-4 w-4" />Conformidad</button> : <button type="button" onClick={() => setHistory(row)} className="min-h-10 rounded-lg border px-3">Historial</button>}{onProvider && row.modalidad === 'TERCERO' && <button type="button" onClick={() => onProvider(row)} className="mt-2 min-h-10 rounded-lg border px-2 text-blue-700">Acceso tercero</button>}</td>
          </tr>)}
        </tbody>
      </DataTable>
    </div>
    <div className="flex items-center justify-between gap-2 text-xs text-slate-500"><span>{filtered.length} entregas · Página {current + 1} de {pages}</span><div className="flex gap-2"><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">Anterior</button><button type="button" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)} className="min-h-10 rounded-lg border px-3 disabled:opacity-40">Siguiente</button></div></div>
    <Modal isOpen={!!history} onClose={() => setHistory(null)} title={`Historial · ${history?.ot_code || ''}`} maxWidth="max-w-xl">
      {history && <div className="space-y-3 text-sm"><p>{history.request_number} · {history.plate} · {history.delivery_address}</p><DeliverySignal state={history.state} /><p>Conformidad: <b>{conformityLabels[history.conformity]}</b></p>{history.events.length ? <ol className="space-y-3">{history.events.map((event, i) => <li key={`${event.at}/${i}`} className="border-l-2 border-blue-200 pl-3"><p className="text-xs text-slate-500">{deliveryTime(event.at)}</p><p className="font-semibold">{event.type.replaceAll('_', ' ')}</p>{event.description && <p>{event.description}</p>}</li>)}</ol> : <p>Sin eventos registrados.</p>}</div>}
    </Modal>
  </section>
}
