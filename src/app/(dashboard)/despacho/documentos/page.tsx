'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, FileCheck2, FileSpreadsheet, FileText, ListTree, Loader2, RefreshCw, Search, Trash2, Truck, Upload } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Modal } from '@/components/ui/modal'
import { GuiaDetalleModal } from '@/components/guias/GuiaDetalleModal'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { DeliveryReview, type DeliveryReviewTarget } from '@/components/delivery/DeliveryReview'
import { conformityLabels, type DeliveryRow } from '@/lib/delivery'
import { PACKING_ACCEPT, packingMime } from '@/lib/packing-list'
import { DOCS_BUCKET, errorMessage, fmtDate, receiptUrl } from '@/lib/caja'

// Auditor: Packing List. Asistente: confirmación documentaria y Nota de Despacho en recojos.
// La guía de entrega obligatoria procede del app/proveedor; solo Transporte valida la conformidad.

type Stop = { request_id: string; request_number: string; ot_code: string | null; sequence: number | null; origin?: string | null; delivery: string; cargo: string | null; client: string | null }
type Doc = {
  id: string; request_id: string | null; doc_type: string; cargo_type: string | null; document_number: string | null
  signed?: boolean; auditor_name?: string | null; auditor_signed_date?: string | null
  file_path: string; file_name: string | null; mime_type: string | null; uploaded_at: string; uploaded_by: string | null
}
type QueueItem = {
  id: string; dispatch_number: string; status: string; vehicle_plate: string | null; driver_name: string | null
  scheduled_departure: string | null; docs_required: boolean; docs_ready_at: string | null; docs_ready_by_name: string | null
  docs_reissue: boolean; docs_reissue_reason: string | null; is_pickup: boolean; doc_status: 'PENDIENTE' | 'LISTO' | 'REEMISION' | 'SALIO'
  modalidad?: string; missing: string | null; stops: Stop[]; documents: Doc[]
}

const DOC_LABEL: Record<string, string> = {
  GUIA_REMISION: 'Guía de remisión', PACKING_LIST: 'Packing List firmado', NOTA_DESPACHO: 'Nota de Despacho', OTRO: 'Otro documento',
}
const CARGO_LABEL: Record<string, string> = { PT: 'Producto terminado', SUMINISTROS: 'Suministros', OTROS: 'Otros' }
const STATUS_BADGE: Record<QueueItem['doc_status'], { label: string; cls: string }> = {
  PENDIENTE: { label: 'Documentos pendientes', cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  REEMISION: { label: 'Requiere reemisión', cls: 'bg-red-100 text-red-700 border-red-200' },
  LISTO: { label: 'Documentos listos', cls: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
  SALIO: { label: 'Salió', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
}
const SHEET_TYPES = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv']
const isSheetName = (n: string) => /\.(xlsx|xls|csv)$/i.test(n)
const sheetMime = (n: string) => /\.csv$/i.test(n) ? 'text/csv' : /\.xls$/i.test(n) ? 'application/vnd.ms-excel' : SHEET_TYPES[0]

// Horas que faltan para la salida (negativo = atrasado)
const hoursLeft = (d: string | null) => (d ? (new Date(d).getTime() - Date.now()) / 36e5 : null)

export default function DocumentosDespachoPage() {
  return <Suspense fallback={<Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />}><DocumentaryQueue /></Suspense>
}

function DocumentaryQueue() {
  const supabase = useMemo(() => createClient(), [])
  const { canWrite, canRead, isLoaded } = usePermissions()
  const canEdit = canWrite('documentario')
  const canPacking = canWrite('packing-list')
  const packingOnly = !canRead('documentario') && canRead('packing-list')
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [filter, setFilter] = useState<'TODOS' | 'PENDIENTE' | 'REEMISION' | 'LISTO'>('TODOS')
  const [showDeparted, setShowDeparted] = useState(false)
  const [search, setSearch] = useState('')
  const dispatchParam = useSearchParams().get('despacho')
  const [selection, setSelection] = useState<{ query: string | null; id: string | null } | null>(null)
  const selectedId = selection?.query === dispatchParam ? selection.id : dispatchParam
  const setSelectedId = (id: string | null) => setSelection({ query: dispatchParam, id })
  const [queueError, setQueueError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const [reload, setReload] = useState(0)
  const [anulando, setAnulando] = useState<Doc | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [review, setReview] = useState<DeliveryReviewTarget | null>(null)
  const load = useCallback(async () => { setReload(n => n + 1) }, [])

  useEffect(() => {
    if (!isLoaded) return
    let cancel = false, fetching = false
    const run = async () => {
      if (fetching) return
      fetching = true
      try {
      const { data, error } = await supabase.rpc('get_documentary_queue', { p_include_departed: showDeparted })
      if (cancel) return
      if (error) { setQueueError(errorMessage(error)); return }
      setQueueError('')
      const list = (data || []) as QueueItem[]
      setItems(list)
      if (packingOnly) { setDeliveries([]); return }
      const rows: DeliveryRow[] = []
      for (let offset = 0; offset < list.length; offset += 100) {
        const { data: result, error } = await supabase.rpc('delivery_tracking_rows', { p_dispatches: list.slice(offset, offset + 100).map(i => i.id) })
        if (cancel) return
        if (error) { toast.error('No se pudo consultar la conformidad de guías: ' + errorMessage(error)); break }
        rows.push(...((result || []) as DeliveryRow[]))
      }
      if (!cancel) setDeliveries(rows)
      } catch (e) { if (!cancel) setQueueError(errorMessage(e)) }
      finally { fetching = false }
    }
    void run()
    const timer = window.setInterval(() => void run(), 30000)
    return () => { cancel = true; window.clearInterval(timer) }
  }, [supabase, showDeparted, reload, packingOnly, isLoaded])

  const counts = useMemo(() => {
    const c = { PENDIENTE: 0, REEMISION: 0, LISTO: 0 }
    ;(items || []).forEach(i => { if (i.doc_status in c) c[i.doc_status as keyof typeof c] += Math.max(1, i.stops.length) })
    return c
  }, [items])
  const needle = search.trim().toLocaleLowerCase('es-PE')
  const visible = (items || []).filter(i => filter === 'TODOS' || i.doc_status === filter).flatMap(item =>
    (item.stops.length ? item.stops : [null]).filter(stop => !needle || [item.dispatch_number, item.vehicle_plate,
      item.driver_name, stop?.ot_code, stop?.request_number, stop?.client, stop?.delivery].join(' ').toLocaleLowerCase('es-PE').includes(needle))
      .map(stop => ({ item, stop })))
  const selected = items?.find(item => item.id === selectedId)

  const openDoc = async (path: string) => {
    const url = await receiptUrl(supabase, `${DOCS_BUCKET}/${path}`)
    if (url) window.open(url, '_blank', 'noopener')
    else toast.error('No se pudo abrir el documento')
  }

  const confirmDocs = async (item: QueueItem) => {
    setBusy(item.id)
    try {
      const { data, error } = await supabase.rpc('confirm_dispatch_documents', { p_dispatch_id: item.id })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error || 'No se pudo confirmar')
      toast.success(`Documentos de ${item.dispatch_number} confirmados: la unidad puede salir`)
      await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(null) }
  }

  // Anulación con causa de lista cerrada (KPI de documentos anulados por error, migración 20261005180000)
  const voidDoc = (doc: Doc) => setAnulando(doc)

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-[#002855] flex items-center gap-2"><FileText className="w-6 h-6" />Documentos de Despacho</h1>
          <p className="mt-1 text-sm text-slate-500">Control por solicitud y OT · desde el Packing List hasta la conformidad de entrega.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600 flex items-center gap-1.5">
            <input type="checkbox" checked={showDeparted} onChange={e => setShowDeparted(e.target.checked)} />Ver los que ya salieron (7 días)
          </label>
          <button onClick={() => void load()} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>
        </div>
      </div>

      <ol aria-label="Secuencia documentaria" className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm md:grid-cols-3">
        {[['Packing List firmado', 'Auditor de Despacho', 'Carga el Packing List en PDF, foto o Excel con su firma. El asistente confirma los documentos y, en recojos, registra la Nota de Despacho.'], ['Guía de entrega', 'Conductor / proveedor JRM', 'Adjunta la guía firmada desde el app o el portal del proveedor al realizar la entrega.'], ['Conformidad', 'Supervisor de Transporte', 'Aprueba, observa o rechaza el sustento. Sin aprobación, el servicio no puede avanzar.']].map(([title, role, detail], index) => <li key={title} className="flex items-start gap-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#002855] font-bold text-white">{index + 1}</span><div><p className="font-semibold text-[#002855]">{title}</p><p className="mt-1 text-xs font-medium text-slate-700">{role}</p><p className="mt-1 text-xs leading-5 text-slate-500">{detail}</p></div></li>)}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3">
        <label className="relative w-full sm:max-w-sm"><span className="sr-only">Buscar OT, solicitud, cliente o despacho</span><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="OT, solicitud, cliente o despacho" className="min-h-11 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-sm" /></label>
        <div className="flex flex-wrap gap-2">
        {([['TODOS', 'Todos'], ['PENDIENTE', `Pendientes (${counts.PENDIENTE})`], ['REEMISION', `Reemisión (${counts.REEMISION})`], ['LISTO', `Listos (${counts.LISTO})`]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`min-h-11 px-3 rounded-lg text-sm border ${filter === k ? 'bg-[#002855] text-white border-[#002855]' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{l}</button>
        ))}
        </div>
      </div>

      {isLoaded && !canEdit && !canPacking && (
        <p className="text-sm text-slate-500 bg-slate-50 border rounded-lg p-3">Vista de consulta: el Auditor de Despacho carga el Packing List; el Asistente Documentario confirma los documentos. La validación de guías corresponde al Supervisor de Transporte.</p>
      )}

      {queueError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">No se pudo actualizar la bandeja: {queueError}. {items ? 'Se conserva la última consulta.' : 'Pulsa Actualizar para reintentar.'}</p>}
      {items === null && !queueError ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        : !visible.length ? <p className="text-slate-500 text-sm p-6 text-center border border-slate-200 rounded-xl bg-white">{queueError && !items ? 'La bandeja no está disponible.' : 'No hay solicitudes para estos filtros.'}</p>
        : <section aria-label="Control documentario por OT" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3 text-sm text-slate-600">{visible.length} solicitud(es) · ordenadas por salida del despacho. Un despacho puede reunir varias OT.</div>
          <div className="overflow-x-auto"><table className="block w-full text-left text-sm lg:table"><caption className="sr-only">Solicitudes y OT asociadas, Packing List, guía de entrega y conformidad</caption><thead className="hidden bg-slate-50 text-xs text-slate-500 lg:table-header-group"><tr>{['OT / Solicitud', 'Cliente / Destino', 'Despacho / Salida', '1. Packing List', ...(packingOnly ? [] : ['2. Guía de entrega', '3. Conformidad']), 'Acciones'].map(label => <th key={label} scope="col" className="px-4 py-3 font-semibold">{label}</th>)}</tr></thead><tbody className="block divide-y divide-slate-200 lg:table-row-group">{visible.map(({ item, stop }) => <DocumentRow key={`${item.id}/${stop?.request_id || 'empty'}`} item={item} stop={stop} delivery={deliveries.find(row => row.dispatch_id === item.id && row.request_id === stop?.request_id)} canEdit={canEdit || canPacking} packingOnly={packingOnly} onManage={() => setSelectedId(item.id)} onEvidence={setReview} />)}</tbody></table></div>
        </section>}
      <Modal isOpen={!!selected} onClose={() => setSelectedId(null)} title={`Documentos · ${selected?.dispatch_number || ''}`} maxWidth="max-w-[1440px]"
        footer={<div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-slate-600">{selected?.missing ? 'Completa los documentos pendientes para autorizar la salida.' : selected?.docs_ready_at ? 'Documentos confirmados para salida.' : 'Documentos y archivos asociados al servicio.'}</p><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setSelectedId(null)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">Cerrar</button>{selected && canEdit && selected.status === 'PROGRAMADO' && ['PENDIENTE', 'REEMISION'].includes(selected.doc_status) && <button type="button" onClick={() => void confirmDocs(selected)} disabled={busy === selected.id || !!selected.missing} className="flex min-h-11 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500">{busy === selected.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Confirmar documentos para salida</button>}</div></div>}>
        {selected && <DispatchCard key={selected.id} item={selected} canEdit={canEdit && selected.status === 'PROGRAMADO'} canPacking={canPacking && selected.status === 'PROGRAMADO'} packingOnly={packingOnly}
          onVoid={voidDoc} onOpen={openDoc} onUploaded={load}
          deliveries={deliveries.filter(row => row.dispatch_id === selected.id)} onEvidence={row => { setSelectedId(null); setReview(row) }} />}
      </Modal>
      {!packingOnly && <DeliveryReview row={review} onClose={() => setReview(null)} onChanged={() => void load()} />}
      {anulando && <AnularModal doc={anulando} onClose={() => setAnulando(null)} onDone={() => { setAnulando(null); void load() }} />}
    </div>
  )
}

function DocumentRow({ item, stop, delivery, canEdit, packingOnly, onManage, onEvidence }: {
  item: QueueItem; stop: Stop | null; delivery?: DeliveryRow; canEdit: boolean; packingOnly: boolean; onManage: () => void; onEvidence: (row: DeliveryReviewTarget) => void
}) {
  const badge = STATUS_BADGE[item.doc_status]
  const docs = item.documents.filter(doc => !doc.request_id || doc.request_id === stop?.request_id)
  const packing = docs.find(doc => doc.doc_type === 'PACKING_LIST' && doc.signed && doc.auditor_name && doc.auditor_signed_date)
  const note = docs.find(doc => doc.doc_type === 'NOTA_DESPACHO' && doc.request_id === stop?.request_id)
  const urgent = !['LISTO', 'SALIO'].includes(item.doc_status) && (hoursLeft(item.scheduled_departure) ?? Infinity) < 2
  const tone = delivery?.conformity === 'VALIDADA' ? 'text-emerald-700' : ['OBSERVADA', 'RECHAZADA'].includes(delivery?.conformity || '') ? 'text-red-700' : 'text-slate-600'
  const cell = 'min-w-0 px-4 py-3 align-top lg:max-w-64'
  const label = (text: string) => <p className="mb-1 text-xs font-semibold text-slate-500 lg:hidden">{text}</p>
  return <tr className={`grid grid-cols-1 sm:grid-cols-2 lg:table-row ${urgent ? 'bg-amber-50/40' : ''}`}>
    <td className={cell}>{label('OT / Solicitud')}<p className="break-words text-base font-bold text-[#002855]">{stop?.ot_code ? `OT ${stop.ot_code}` : 'Sin OT vinculada'}</p><p className="mt-1 text-xs text-slate-600">{stop?.request_number || 'Sin solicitud asociada'}{stop && ` · Parada ${stop.sequence || item.stops.indexOf(stop) + 1}`}</p></td>
    <td className={cell}>{label('Cliente / Destino')}<p className="break-words font-medium text-slate-800">{stop?.client || 'Sin cliente registrado'}</p><p className="mt-1 break-words text-xs leading-5 text-slate-500">{stop?.delivery || 'Sin destino registrado'}</p></td>
    <td className={cell}>{label('Despacho / Salida')}<p className="break-words text-xs font-semibold text-slate-700">{item.dispatch_number}</p><p className={`mt-1 text-xs ${urgent ? 'font-semibold text-amber-800' : 'text-slate-500'}`}>{fmtDate(item.scheduled_departure, true)}</p><p className="mt-1 text-xs text-slate-500">{item.is_pickup ? 'Recojo del cliente' : `${item.vehicle_plate || 'Sin placa'} · ${item.driver_name || (item.modalidad === 'TERCERO' ? 'Proveedor JRM' : 'Sin conductor')}`}</p></td>
    <td className={cell}>{label('1. Packing List')}<span className={`inline-flex rounded-lg border px-2 py-1 text-xs font-semibold ${badge.cls}`}>{badge.label}</span><p className="mt-2 text-xs text-slate-600">{packing ? `Firmado adjunto${packing.request_id ? '' : ' · consolidado'}` : 'Firma pendiente de adjuntar'}</p>{item.is_pickup && <p className="mt-1 text-xs text-slate-500">Nota de Despacho: {note ? 'adjunta' : 'pendiente'}</p>}{item.docs_reissue && <p className="mt-1 text-xs text-red-700">{item.docs_reissue_reason || 'Actualizar y confirmar documentos'}</p>}</td>
    {!packingOnly && <td className={cell}>{label('2. Guía de entrega')}<p className="text-xs font-medium text-slate-700">{item.is_pickup ? 'Nota de Despacho' : delivery ? delivery.guide_number || 'Guía aún no recibida' : 'Consulta de guía pendiente'}</p><p className="mt-1 text-xs text-slate-500">{item.is_pickup ? 'Circuito de recojo del cliente' : item.modalidad === 'TERCERO' ? 'Responsable: proveedor JRM' : 'Responsable: conductor · app'}</p>{delivery && delivery.photos_count > 0 && <p className="mt-1 text-xs text-slate-500">{delivery.photos_count} foto(s) recibida(s)</p>}</td>}
    {!packingOnly && <td className={cell}>{label('3. Conformidad')}<p className={`text-xs font-semibold ${tone}`}>{item.is_pickup ? 'No aplica guía de entrega' : delivery ? conformityLabels[delivery.conformity] : 'Conformidad no disponible'}</p>{!item.is_pickup && <p className="mt-1 text-xs text-slate-500">Supervisor de Transporte</p>}</td>}
    <td className={cell}>{label('Acciones')}<div className="flex flex-wrap gap-2"><button type="button" onClick={onManage} className="min-h-11 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white">{canEdit && item.status === 'PROGRAMADO' ? packingOnly ? 'Cargar Packing List' : 'Gestionar documentos' : 'Ver documentos'}</button>{delivery && !item.is_pickup && <button type="button" onClick={() => onEvidence(delivery)} className="min-h-11 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-[#002855]">Ver guía y conformidad</button>}</div></td>
  </tr>
}

function DispatchCard({ item, canEdit, canPacking, packingOnly, onVoid, onOpen, onUploaded, deliveries, onEvidence }: {
  item: QueueItem; canEdit: boolean; canPacking: boolean; packingOnly: boolean; onVoid: (d: Doc) => void
  onOpen: (p: string) => void; onUploaded: () => Promise<void>; deliveries: DeliveryRow[]; onEvidence: (row: DeliveryReviewTarget) => void
}) {
  const [upload, setUpload] = useState<{ requestId: string | null; type: string; label: string } | null>(null)
  const uploadPanel = useRef<HTMLDivElement>(null)
  useEffect(() => { if (upload) uploadPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [upload])
  const badge = STATUS_BADGE[item.doc_status]
  const generalDocs = item.documents.filter(d => !d.request_id)
  const consolidated = generalDocs.find(d => d.doc_type === 'PACKING_LIST' && d.signed && d.auditor_name && d.auditor_signed_date)
  const h = hoursLeft(item.scheduled_departure)
  const urgent = !['LISTO', 'SALIO'].includes(item.doc_status) && h !== null && h < 2
  const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold'
  const cell = 'min-w-0 px-4 py-4 align-top'
  const label = (text: string) => <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 lg:hidden">{text}</p>
  const status = (title: string, ready: boolean, detail: string) => <div className="space-y-1"><p className="flex items-center gap-2 text-sm font-semibold text-slate-800">{ready ? <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /> : <Clock className="h-4 w-4 shrink-0 text-amber-600" />}{title}</p><p className={`text-xs leading-5 ${ready ? 'text-emerald-700' : 'text-amber-800'}`}>{detail}</p></div>
  const beginUpload = (requestId: string | null, type: string, title: string) => setUpload({ requestId, type, label: title })

  return <div className="min-w-0 space-y-4">
    <div className="grid gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Unidad</p><p className="mt-2 flex items-center gap-2 text-lg font-bold text-[#002855]"><Truck className="h-5 w-5" />{item.is_pickup ? 'Unidad del cliente' : item.vehicle_plate || 'Sin unidad'}</p><p className="mt-1 text-xs text-slate-600">{item.is_pickup ? 'Recojo por el cliente' : item.modalidad === 'TERCERO' ? 'Transporte contratado por JRM' : 'Transporte JRM'}</p></div>
      <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Conductor</p><p className="mt-2 break-words text-sm font-semibold text-slate-800">{item.is_pickup ? 'No aplica' : item.driver_name || 'Sin conductor registrado'}</p></div>
      <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Salida programada</p><p className={`mt-2 text-sm font-semibold ${urgent ? 'text-red-700' : 'text-slate-800'}`}>{fmtDate(item.scheduled_departure, true)}</p>{urgent && <p className="mt-1 text-xs text-red-700">{h !== null && h < 0 ? 'Salida atrasada' : 'Salida próxima'}</p>}</div>
      <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Estado documentario</p><span className={`mt-2 inline-flex rounded-lg border px-2 py-1 text-xs font-semibold ${badge.cls}`}>{badge.label}</span>{item.docs_ready_at && !item.docs_reissue && <p className="mt-1 text-xs text-emerald-700">Confirmado · {fmtDate(item.docs_ready_at, true)}</p>}</div>
    </div>
    {item.docs_reissue && <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Reemisión: {item.docs_reissue_reason || 'Actualizar los documentos del servicio.'}</p>}
    <section className="overflow-hidden rounded-xl border border-slate-200" aria-label="Documentos por servicio">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white p-4"><div><h3 className="font-bold text-[#002855]">Servicios y documentos</h3><p className="mt-1 text-xs text-slate-500">{item.stops.length} servicio(s) asociados{item.is_pickup ? ' · Recojo por el cliente' : ''}</p></div>{canPacking && <button type="button" onClick={() => beginUpload(null, 'PACKING_LIST', 'Todas las solicitudes del despacho')} className={`${action} border border-[#002855] bg-white text-[#002855] hover:bg-blue-50`}><Upload className="h-4 w-4" />{consolidated ? 'Reemplazar Packing List consolidado' : 'Cargar Packing List consolidado'}</button>}</div>
      <table className="block w-full table-fixed text-left lg:table"><caption className="sr-only">OT, detalles del servicio, documentos requeridos y botones para cargar o consultar</caption><thead className="hidden bg-slate-50 text-xs font-semibold text-slate-500 lg:table-header-group"><tr><th scope="col" className="w-[16%] px-4 py-3">OT / Solicitud</th><th scope="col" className="w-[32%] px-4 py-3">Detalle del servicio</th><th scope="col" className="w-[27%] px-4 py-3">Documentos requeridos</th><th scope="col" className="w-[25%] px-4 py-3">Archivos y acciones</th></tr></thead>
        <tbody className="block divide-y divide-slate-200 lg:table-row-group">{item.stops.map((s, i) => {
          const docs = item.documents.filter(d => d.request_id === s.request_id)
          const packing = docs.find(d => d.doc_type === 'PACKING_LIST' && d.signed && d.auditor_name && d.auditor_signed_date) || consolidated
          const note = docs.find(d => d.doc_type === 'NOTA_DESPACHO')
          const delivery = deliveries.find(d => d.request_id === s.request_id)
          const title = `${s.ot_code ? `OT ${s.ot_code}` : 'Sin OT vinculada'} · ${s.request_number}`
          return <tr key={s.request_id} className="grid grid-cols-1 bg-white sm:grid-cols-2 lg:table-row">
            <td className={cell}>{label('OT / Solicitud')}<p className="break-words text-base font-bold text-[#002855]">{s.ot_code ? `OT ${s.ot_code}` : 'Sin OT vinculada'}</p><p className="mt-2 text-sm font-semibold text-slate-700">{s.request_number}</p><p className="mt-1 text-xs text-slate-500">Parada {s.sequence || i + 1}</p></td>
            <td className={cell}>{label('Detalle del servicio')}<p className="break-words text-sm font-semibold text-slate-800">{s.client || 'Sin cliente registrado'}</p><dl className="mt-2 space-y-2 text-xs leading-5"><div><dt className="font-semibold text-slate-500">Origen</dt><dd className="break-words text-slate-700">{s.origin || 'Sin origen registrado'}</dd></div><div><dt className="font-semibold text-slate-500">Destino</dt><dd className="break-words text-slate-700">{s.delivery || 'Sin destino registrado'}</dd></div><div><dt className="font-semibold text-slate-500">Carga / Servicio</dt><dd className="break-words text-slate-700">{s.cargo || 'Sin detalle registrado'}</dd></div></dl></td>
            <td className={cell}>{label('Documentos requeridos')}<div className="space-y-3">{status('Packing List firmado', !!packing, packing ? `${packing.request_id ? 'Cargado' : 'Consolidado'} · ${packing.auditor_name}` : 'Pendiente · Auditor de Despacho')}{item.is_pickup && status('Nota de Despacho', !!note, note ? 'Cargada' : 'Pendiente · Asistente Documentario')}{!packingOnly && !item.is_pickup && <div className="space-y-1"><p className="text-sm font-semibold text-slate-800">Guía firmada en destino</p><p className="text-xs leading-5 text-slate-600">{delivery ? conformityLabels[delivery.conformity] : 'Aún no disponible'}{delivery?.guide_number ? ` · ${delivery.guide_number}` : ''}</p><p className="text-xs text-slate-500">{item.modalidad === 'TERCERO' ? 'Proveedor JRM · enlace de entrega' : 'Conductor · app'}</p></div>}</div></td>
            <td className={cell}>{label('Archivos y acciones')}<div className="flex flex-col items-start gap-2">{canPacking && <button type="button" onClick={() => beginUpload(s.request_id, 'PACKING_LIST', title)} className={`${action} bg-[#002855] text-white hover:bg-[#003b7a]`}><Upload className="h-4 w-4" />{packing ? 'Actualizar Packing List' : 'Cargar Packing List'}</button>}{canEdit && item.is_pickup && <button type="button" onClick={() => beginUpload(s.request_id, 'NOTA_DESPACHO', title)} className={`${action} border border-slate-300 text-[#002855] hover:bg-slate-50`}><Upload className="h-4 w-4" />{note ? 'Cargar nueva Nota de Despacho' : 'Cargar Nota de Despacho'}</button>}{canEdit && <button type="button" onClick={() => beginUpload(s.request_id, 'OTRO', title)} className={`${action} border border-slate-300 text-[#002855] hover:bg-slate-50`}><Upload className="h-4 w-4" />Cargar otro documento</button>}{consolidated && <button type="button" onClick={() => onOpen(consolidated.file_path)} className={`${action} border border-blue-200 bg-blue-50 text-blue-800`}><FileText className="h-4 w-4" />Ver Packing List consolidado</button>}</div><DocList docs={docs} canEdit={canEdit} onVoid={onVoid} onOpen={onOpen} />{!packingOnly && !item.is_pickup && delivery && <button type="button" onClick={() => onEvidence(delivery)} className={`${action} mt-2 border border-slate-300 text-[#002855] hover:bg-slate-50`}><FileCheck2 className="h-4 w-4" />Ver guía y conformidad</button>}</td>
          </tr>
        })}{!item.stops.length && <tr className="block lg:table-row"><td colSpan={4} className="p-4 text-sm text-slate-500">Este despacho no tiene solicitudes asociadas.</td></tr>}</tbody>
      </table>
    </section>
    {(!!generalDocs.length || canEdit) && <section className="rounded-xl border border-slate-200 bg-slate-50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-[#002855]">Archivos consolidados · todas las OT del despacho</h3>{canEdit && <button type="button" onClick={() => beginUpload(null, 'OTRO', 'Todas las solicitudes del despacho')} className={`${action} border border-slate-300 bg-white text-[#002855] hover:bg-slate-50`}><Upload className="h-4 w-4" />Cargar otro archivo consolidado</button>}</div><DocList docs={generalDocs} canEdit={canEdit} onVoid={onVoid} onOpen={onOpen} /></section>}
    {upload && (canPacking || canEdit) && <div ref={uploadPanel} className="scroll-m-4 rounded-xl border-2 border-blue-200 bg-blue-50/40 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-bold text-[#002855]">{DOC_LABEL[upload.type]}</h3><p className="mt-1 text-sm font-semibold text-slate-700">{upload.label}</p><p className="mt-1 text-xs text-slate-500">{upload.requestId ? 'El archivo se vincula únicamente a esta solicitud.' : 'Este archivo cubre todas las solicitudes y OT del despacho.'}</p></div><button type="button" onClick={() => setUpload(null)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700">Cerrar formulario</button></div><UploadForm key={`${upload.requestId}/${upload.type}`} dispatchId={item.id} requestId={upload.requestId} isPickup={item.is_pickup} canPacking={canPacking} canDocuments={canEdit} documentType={upload.type} onUploaded={async () => { await onUploaded(); setUpload(null) }} /></div>}
  </div>
}

const CAUSAS_ANULACION: Array<[string, string]> = [
  ['ERROR_DATOS', 'Error en datos (RUC, dirección, cliente)'], ['ERROR_CANTIDAD', 'Error en cantidades o productos'], ['ERROR_DESTINO', 'Error en destino o punto de llegada'],
  ['CAMBIO_UNIDAD', 'Cambió la unidad'], ['CAMBIO_CONDUCTOR', 'Cambió el conductor'], ['SOLICITUD_CLIENTE', 'Pedido del cliente'], ['OTRO', 'Otro (detallar)'],
]

function AnularModal({ doc, onClose, onDone }: { doc: Doc; onClose: () => void; onDone: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [causa, setCausa] = useState('')
  const [detalle, setDetalle] = useState('')
  const [saving, setSaving] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const { data, error } = await supabase.rpc('anular_documento', { p_document_id: doc.id, p_causa: causa, p_detalle: detalle || null })
    setSaving(false)
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); return }
    toast.success('Documento anulado'); onDone()
  }
  return (
    <Modal isOpen onClose={onClose} title={`Anular ${DOC_LABEL[doc.doc_type]} ${doc.document_number || ''}`} maxWidth="max-w-md">
      <form onSubmit={submit} className="space-y-3 text-sm">
        <label className="block">Causa<select required value={causa} onChange={e => setCausa(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2">
          <option value="">Seleccionar…</option>{CAUSAS_ANULACION.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <label className="block">Detalle {causa === 'OTRO' ? '(obligatorio)' : '(opcional)'}<input required={causa === 'OTRO'} value={detalle} onChange={e => setDetalle(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
        <p className="text-xs text-slate-500">Las causas «Error en…» cuentan en el indicador de documentos anulados por error del Asistente Documentario.</p>
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="rounded-lg border px-4 py-2">Cancelar</button>
          <button disabled={saving} className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 font-semibold text-white">{saving && <Loader2 className="h-4 w-4 animate-spin" />}Anular</button></div>
      </form>
    </Modal>
  )
}

function DocList({ docs, canEdit, onVoid, onOpen }: { docs: Doc[]; canEdit: boolean; onVoid: (d: Doc) => void; onOpen: (p: string) => void }) {
  const [guia, setGuia] = useState<string | null>(null)
  if (docs.length === 0) return null
  return (
    <>
    <GuiaDetalleModal key={guia || 'none'} guias={guia} onClose={() => setGuia(null)} />
    <ul className="mt-3 space-y-3">
      {docs.map(d => (
        <li key={d.id} className="min-w-0 space-y-1 text-xs">
          <button type="button" onClick={() => onOpen(d.file_path)} className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-left font-semibold text-blue-800 hover:bg-blue-100">
            {isSheetName(d.file_name || d.file_path) ? <FileSpreadsheet className="h-4 w-4 shrink-0" /> : <FileText className="h-4 w-4 shrink-0" />}
            <span className="break-words">Ver {DOC_LABEL[d.doc_type] || 'documento'}{d.document_number ? ` ${d.document_number}` : ''}</span>
          </button>
          {d.doc_type === 'GUIA_REMISION' && d.document_number && (
            <button type="button" onClick={() => setGuia(d.document_number)} title="Ver los SKUs de la guía (SALIDA del ERP)"
              className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100">
              <ListTree className="w-3 h-3" /> SKUs
            </button>
          )}
          <p className="break-all text-slate-500">{d.file_name || 'Archivo adjunto'}</p>
          {d.doc_type === 'PACKING_LIST' && <p className={`${d.signed ? 'text-emerald-700' : 'text-amber-700'}`}>{d.signed ? `Firmado por ${d.auditor_name} · ${fmtDate(d.auditor_signed_date || null)}` : 'Firma del auditor pendiente de registrar'}</p>}
          {d.cargo_type && <span className="text-xs text-slate-500">({CARGO_LABEL[d.cargo_type] || d.cargo_type})</span>}
          {canEdit && <button type="button" onClick={() => onVoid(d)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 font-semibold text-red-700 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" />Anular documento</button>}
        </li>
      ))}
    </ul>
    </>
  )
}

function UploadForm({ dispatchId, requestId, isPickup, canPacking, canDocuments, documentType, onUploaded }: {
  dispatchId: string; requestId: string | null; isPickup: boolean; canPacking: boolean; canDocuments: boolean; documentType: string; onUploaded: () => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const types = [...(canPacking ? ['PACKING_LIST'] : []), ...(canDocuments ? [...(requestId && isPickup ? ['NOTA_DESPACHO'] : []), 'OTRO'] : [])]
  const docType = types.includes(documentType) ? documentType : types[0]
  const [auditor, setAuditor] = useState('')
  const [today] = useState(() => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10))
  const [signedDate, setSignedDate] = useState(today)
  const [signature, setSignature] = useState(false)
  const [number, setNumber] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [saving, setSaving] = useState(false)
  const [inputKey, setInputKey] = useState(0)
  const needsNumber = docType === 'GUIA_REMISION' || docType === 'NOTA_DESPACHO'
  const allowSheet = docType === 'OTRO'
  const packing = docType === 'PACKING_LIST'

  const submit = async () => {
    if (saving) return
    if (!file || !file.size) { toast.error('Seleccione un archivo que no esté vacío'); return }
    if (file.size > 15 * 1024 * 1024) { toast.error('El archivo supera 15 MB'); return }
    if (packing && (!auditor.trim() || !signedDate || !signature)) { toast.error('Indique auditor, fecha y confirme que el Packing List contiene su firma'); return }
    if (needsNumber && !number.trim()) { toast.error('Indique la serie y número'); return }
    const sheet = isSheetName(file.name)
    if (!packing && !(file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) && !(allowSheet && sheet)) {
      toast.error(allowSheet ? 'Cargue un PDF o un Excel' : 'La Nota de Despacho se carga en PDF'); return
    }
    const mime = packing ? packingMime(file) : sheet ? sheetMime(file.name) : 'application/pdf'
    if (!mime) { toast.error('Seleccione PDF, foto JPG/PNG/WEBP o Excel XLS/XLSX'); return }
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Tu sesión venció. Ingresa nuevamente para cargar el documento.')
      const path = `${dispatchId}/${packing ? `packing/${user.id}/` : ''}${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`
      const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { contentType: mime })
      if (upErr) throw new Error('No se pudo subir el archivo: ' + errorMessage(upErr))
      const { data, error } = packing ? await supabase.rpc('register_signed_packing_list', {
        p_dispatch_id: dispatchId, p_request_id: requestId, p_file_path: path, p_file_name: file.name,
        p_mime_type: mime, p_size_bytes: file.size, p_auditor: auditor.trim(), p_signed_date: signedDate, p_signature_confirmed: signature,
      }) : await supabase.rpc('register_dispatch_document', {
        p_dispatch_id: dispatchId, p_request_id: requestId, p_doc_type: docType, p_cargo_type: null,
        p_document_number: number.trim() || null, p_file_path: path, p_file_name: file.name,
        p_mime_type: mime, p_size_bytes: file.size, p_notes: null,
      })
      if (error) throw new Error('No se pudo confirmar el registro: ' + errorMessage(error) + '. Actualiza la bandeja antes de reintentar.')
      if (!data?.success) {
        // El archivo sin registro no sirve: se retira para no dejar huérfanos
        await supabase.storage.from(DOCS_BUCKET).remove([path])
        throw new Error(data?.error || 'No se pudo registrar el documento')
      }
      toast.success(`${DOC_LABEL[docType]} cargado`)
      setNumber(''); setFile(null); setSignature(false); setInputKey(k => k + 1)
      await onUploaded()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(false) }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
      {packing && <div className="grid w-full gap-3 sm:grid-cols-2"><label className="text-xs text-slate-600">Auditor firmante *<input value={auditor} maxLength={120} onChange={e => setAuditor(e.target.value)} placeholder="Nombre y apellido del Auditor de Despacho" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="text-xs text-slate-600">Fecha de firma *<input type="date" value={signedDate} max={today} onChange={e => setSignedDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="flex items-start gap-2 text-xs leading-5 text-slate-600 sm:col-span-2"><input type="checkbox" checked={signature} onChange={e => setSignature(e.target.checked)} className="mt-1" />Confirmo que el archivo adjunto es legible y contiene la firma del auditor de despacho. Se acepta PDF, foto o Excel (XLS/XLSX) del Packing List firmado.</label></div>}
      {!packing && <label className="text-xs text-slate-600">Número {needsNumber ? '*' : '(opcional)'}<input value={number} onChange={e => setNumber(e.target.value)} placeholder={needsNumber ? 'T001-000123' : 'Número del documento'}
        className="mt-1 min-h-11 w-full max-w-48 border border-slate-300 rounded-lg px-3 text-sm" /></label>}
      <label className="block w-full min-w-0 text-xs text-slate-600 sm:flex-1">Archivo · máximo 15 MB<input disabled={saving} key={inputKey} type="file" accept={packing ? PACKING_ACCEPT : allowSheet ? '.pdf,.xlsx,.xls,.csv' : '.pdf'} onChange={e => setFile(e.target.files?.[0] || null)}
        className="mt-2 block min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-slate-50 text-xs file:mr-3 file:min-h-11 file:border-0 file:bg-slate-200 file:px-3 file:font-semibold file:text-[#002855]" /></label>
      <button onClick={submit} disabled={saving}
        className="min-h-11 px-3 rounded-lg bg-[#002855] text-white font-semibold disabled:opacity-50 flex items-center gap-1.5">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}{saving ? 'Cargando…' : 'Subir archivo'}
      </button>
    </div>
  )
}
