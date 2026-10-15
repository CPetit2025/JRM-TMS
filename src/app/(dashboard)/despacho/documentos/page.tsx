'use client'
import { TransportWorkflow, TorreControlButton } from '@/components/transport/TransportWorkflow'
import { DataTable } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { InlineStatusBar } from '@/components/ui/inline-status-bar'
import { FilterToolbar, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronRight, Clock, Info, Layers, FileCheck2, FileImage, FileSpreadsheet, FileText, ListTree, Loader2, RefreshCw, Search, Trash2, Truck, Upload } from 'lucide-react'
import { useSearchParams } from 'next/navigation'
import { Modal } from '@/components/ui/modal'
import { GuiaDetalleModal } from '@/components/guias/GuiaDetalleModal'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { DeliveryReview, type DeliveryReviewTarget } from '@/components/delivery/DeliveryReview'
import { documentPhaseMatches, type DocumentPhase } from '@/lib/document-flow'
import { conformityLabels, documentNumberLabel, type DeliveryRow } from '@/lib/delivery'
import { PACKING_ACCEPT, packingMime } from '@/lib/packing-list'
import { DOCS_BUCKET, errorMessage, fmtDate, receiptUrl } from '@/lib/caja'
import { districtOf } from '@/lib/address'
import { DocumentNumberLinks, type KnownNumber } from '@/components/despacho/DocumentNumberLinks'
import { referenceLabel } from '@/lib/suppliers'
import { cellDateTime, fullDateTime } from '@/lib/table-format'
import { fetchServiceTypes, serviceKind, type ServiceKind } from '@/lib/request-service'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'

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
  number_references?: { request_id: string; doc_type: string; document_number: string }[]
  modalidad?: string; missing: string | null; stops: Stop[]; documents: Doc[]
}

const DOC_LABEL: Record<string, string> = {
  GUIA_REMISION: 'Guía de remisión', PACKING_LIST: 'Packing List firmado', NOTA_DESPACHO: 'Nota de Despacho', OTRO: 'Otro documento',
}
const CARGO_LABEL: Record<string, string> = { PT: 'Producto terminado', SUMINISTROS: 'Suministros', OTROS: 'Otros' }
const STATUS_BADGE: Record<QueueItem['doc_status'], { label: string; tone: StatusTone }> = {
  PENDIENTE: { label: 'Documentos pendientes', tone: 'warning' },
  REEMISION: { label: 'Requiere reemisión', tone: 'danger' },
  LISTO: { label: 'Documentos listos', tone: 'success' },
  SALIO: { label: 'Salió', tone: 'neutral' },
}
const SHEET_TYPES = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', 'text/csv']
const isSheetName = (n: string) => /\.(xlsx|xls|csv)$/i.test(n)
const sheetMime = (n: string) => /\.csv$/i.test(n) ? 'text/csv' : /\.xls$/i.test(n) ? 'application/vnd.ms-excel' : SHEET_TYPES[0]
// Otro documento: PDF, imágenes y Excel, varios a la vez; cada archivo se identifica por su tipo.
const OTHER_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx,.csv'
type FileKind = 'pdf' | 'excel' | 'imagen'
const fileKind = (name: string, mime?: string | null): FileKind =>
  isSheetName(name) || /sheet|excel|csv/i.test(mime || '') ? 'excel' : /\.(jpe?g|png|webp)$/i.test(name) || (mime || '').startsWith('image/') ? 'imagen' : 'pdf'
const KIND_ICON = { pdf: FileText, excel: FileSpreadsheet, imagen: FileImage } as const
const KIND_LABEL: Record<FileKind, string> = { pdf: 'PDF', excel: 'Excel', imagen: 'Imagen' }
const KIND_STYLE: Record<FileKind, string> = { pdf: 'bg-red-50 text-red-700', excel: 'bg-emerald-50 text-emerald-700', imagen: 'bg-violet-50 text-violet-700' }
function KindTag({ kind }: { kind: FileKind }) {
  const Icon = KIND_ICON[kind]
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-bold ${KIND_STYLE[kind]}`}><Icon className="h-3 w-3" />{KIND_LABEL[kind]}</span>
}

// Horas que faltan para la salida (negativo = atrasado)
const limaDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
const thirtyDaysAgo = () => limaDay(new Date(Date.now() - 30 * 864e5))
// La liquidación pendiente no depende del período elegido: revisa el último año
const yearAgo = () => limaDay(new Date(Date.now() - 365 * 864e5))

const hoursLeft = (d: string | null) => (d ? (new Date(d).getTime() - Date.now()) / 36e5 : null)

export default function DocumentosDespachoPage() {
  return <Suspense fallback={<Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />}><DocumentaryQueue /></Suspense>
}

function DocumentaryQueue() {
  const supabase = useMemo(() => createClient(), [])
  const { canWrite, canRead, isLoaded, role } = usePermissions()
  const canNumbers = canWrite('documentario')
  const assistantOnly = role === 'asistente documentario'
  const canEdit = canNumbers && !assistantOnly
  const canPacking = canWrite('packing-list') && !assistantOnly
  const packingOnly = !canRead('documentario') && (canRead('packing-list') || canRead('planificacion'))
  // «Dar por liquidado» manual: Administrador, Jefe de Distribución, Supervisor de Transporte y Despacho (la BD lo vuelve a validar)
  const canManual = ['admin', 'jefe de distribución', 'supervisor de transporte'].includes(role) || (role.includes('despach') && role !== 'auditor de despacho')
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [filter, setFilter] = useState<'TODOS' | 'PENDIENTE' | 'REEMISION' | 'LISTO'>('TODOS')
  const params = useSearchParams()
  const requestedPhase = params.get('vista')
  const [phaseChoice, setPhaseChoice] = useState<DocumentPhase | null>(null)
  const chosenPhase = phaseChoice || (['salida', 'liquidacion', 'conformidad', 'observados', 'historial'].includes(requestedPhase || '') ? requestedPhase as DocumentPhase : 'salida')
  const phase: DocumentPhase = packingOnly && !['salida', 'historial'].includes(chosenPhase) ? 'salida' : chosenPhase
  const showDeparted = phase !== 'salida'
  const [dateFrom, setDateFrom] = useState(() => /^\d{4}-\d{2}-\d{2}$/.test(params.get('desde') || '') ? params.get('desde')! : thirtyDaysAgo())
  const [dateUntil, setDateUntil] = useState(limaDay)
  const [search, setSearch] = useState('')
  const dispatchParam = params.get('despacho')
  const [selection, setSelection] = useState<{ query: string | null; id: string | null } | null>(null)
  const selectedId = selection?.query === dispatchParam ? selection.id : dispatchParam
  const setSelectedId = (id: string | null) => setSelection({ query: dispatchParam, id })
  // Liquidación documental por servicio: al abrir desde una fila se muestra solo ese servicio (una unidad puede
  // llevar varias entregas); «Ver todos» muestra la ruta completa. En «Previos a salida» se ve la ruta entera.
  const [focusStop, setFocusStop] = useState<string | null>(null)
  const [showAllStops, setShowAllStops] = useState(false)
  const openService = (dispatchId: string, requestId: string | null) => { setSelectedId(dispatchId); setFocusStop(requestId); setShowAllStops(false) }
  const [queueError, setQueueError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const [reload, setReload] = useState(0)
  const [anulando, setAnulando] = useState<Doc | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  // Liquidación pendiente: estado documentario por servicio según su tipo (regla de la base)
  const [checklists, setChecklists] = useState<Map<string, SettlementChecklist>>(new Map())
  const [serviceTypes, setServiceTypes] = useState<Awaited<ReturnType<typeof fetchServiceTypes>>>(new Map())
  const [review, setReview] = useState<DeliveryReviewTarget | null>(null)
  const [statusOf, setStatusOf] = useState<{ item: QueueItem; stop: Stop | null; delivery?: DeliveryRow } | null>(null)
  const load = useCallback(async () => { setReload(n => n + 1) }, [])

  useEffect(() => {
    if (!isLoaded) return
    let cancel = false, fetching = false
    const run = async () => {
      if (fetching) return
      fetching = true
      try {
      if (showDeparted && phase !== 'liquidacion' && (!dateFrom || !dateUntil || dateUntil < dateFrom || (Date.parse(dateUntil) - Date.parse(dateFrom)) / 864e5 > 365)) {
        setQueueError('Selecciona un período válido de hasta 366 días.'); return
      }
      const pending = phase === 'liquidacion'
      // Liquidación pendiente: la base filtra rutas con cierre operativo y documentación incompleta
      const { data, error } = await supabase.rpc(pending ? 'get_documentary_pending_settlement' : 'get_documentary_queue_period', {
        p_include_departed: showDeparted,
        p_from: showDeparted ? `${pending ? yearAgo() : dateFrom}T00:00:00-05:00` : null,
        p_until: showDeparted ? `${pending ? limaDay() : dateUntil}T23:59:59.999-05:00` : null,
      })
      if (cancel) return
      if (error) { setQueueError(errorMessage(error)); return }
      setQueueError('')
      const list = (data || []) as QueueItem[]
      setItems(list)
      const types = await fetchServiceTypes(supabase, list.flatMap(i => i.stops.map(st => st.request_id)))
      if (cancel) return
      setServiceTypes(types)
      if (packingOnly) { setDeliveries([]); return }
      const rows: DeliveryRow[] = []
      for (let offset = 0; offset < list.length; offset += 100) {
        const { data: result, error } = await supabase.rpc('delivery_tracking_rows', { p_dispatches: list.slice(offset, offset + 100).map(i => i.id) })
        if (cancel) return
        if (error) { toast.error('No se pudo consultar la conformidad de guías: ' + errorMessage(error)); break }
        rows.push(...((result || []) as DeliveryRow[]))
      }
      if (!cancel) setDeliveries(rows)
      if (phase === 'liquidacion') {
        const found = new Map<string, SettlementChecklist>()
        for (let offset = 0; offset < list.length; offset += 200) {
          const { data: result, error } = await supabase.rpc('get_settlement_checklists', { p_dispatches: list.slice(offset, offset + 200).map(i => i.id) })
          if (cancel) return
          if (error) { toast.error('No se pudo consultar los documentos de liquidación: ' + errorMessage(error)); break }
          ;((result || []) as SettlementChecklist[]).forEach(c => found.set(`${c.dispatch_id}/${c.request_id}`, c))
        }
        if (!cancel) setChecklists(found)
      }
      } catch (e) { if (!cancel) setQueueError(errorMessage(e)) }
      finally { fetching = false }
    }
    void run()
    const timer = window.setInterval(() => void run(), 30000)
    return () => { cancel = true; window.clearInterval(timer) }
  }, [supabase, showDeparted, phase, dateFrom, dateUntil, reload, packingOnly, isLoaded])

  const counts = useMemo(() => {
    const c = { PENDIENTE: 0, REEMISION: 0, LISTO: 0 }
    ;(items || []).forEach(i => { if (i.doc_status in c) c[i.doc_status as keyof typeof c] += Math.max(1, i.stops.length) })
    return c
  }, [items])
  const needle = search.trim().toLocaleLowerCase('es-PE')
  const searchableNumbers = (item: QueueItem, stop: Stop | null) => {
    const numbers = stopNumbers(item, stop, deliveries.find(row => row.dispatch_id === item.id && row.request_id === stop?.request_id))
    return numbers.pending ? '' : numbers.text
  }
  const visible = (items || []).filter(i => phase !== 'salida' || filter === 'TODOS' || i.doc_status === filter).flatMap(item =>
    (item.stops.length ? item.stops : [null]).filter(stop => !needle || [item.dispatch_number, item.vehicle_plate,
      item.driver_name, stop?.ot_code, stop?.request_number, stop?.client, stop?.delivery,
      searchableNumbers(item, stop)].join(' ').toLocaleLowerCase('es-PE').includes(needle))
      .map(stop => ({ item, stop }))).filter(({ item, stop }) => documentPhaseMatches(phase, item, deliveries.find(row => row.dispatch_id === item.id && row.request_id === stop?.request_id), noteLinked(item, stop), checklists.get(`${item.id}/${stop?.request_id}`)?.complete))
  const selectedRoute = items?.find(item => item.id === selectedId)
  // Lista de liquidación de la ruta abierta (en cualquier pestaña; «Liquidación pendiente» ya la trae para toda la bandeja)
  const selectedRouteId = selectedRoute && !NOT_SETTLEABLE.includes(selectedRoute.status) ? selectedRoute.id : null
  useEffect(() => {
    if (!selectedRouteId || phase === 'liquidacion') return
    let stopped = false
    void supabase.rpc('get_settlement_checklists', { p_dispatches: [selectedRouteId] }).then(({ data, error }) => {
      if (stopped || error) return
      setChecklists(current => { const next = new Map(current); ((data || []) as SettlementChecklist[]).forEach(c => next.set(`${c.dispatch_id}/${c.request_id}`, c)); return next })
    })
    return () => { stopped = true }
  }, [selectedRouteId, phase, supabase, items])
  const focused = phase !== 'salida' && !showAllStops && !!focusStop && !!selectedRoute?.stops.some(s => s.request_id === focusStop)
  // Solo el servicio elegido y los archivos de todo el despacho (consolidados)
  const selected = selectedRoute && focused ? { ...selectedRoute, stops: selectedRoute.stops.filter(s => s.request_id === focusStop),
    documents: selectedRoute.documents.filter(d => !d.request_id || d.request_id === focusStop) } : selectedRoute

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
    <div className="min-w-0 space-y-2.5">
      <PageHeader showTitle title="Documentos de Despacho" description="Salida y conformidad en un único espacio · documentos por servicio, parada y OT."
        actions={<><button onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button><TorreControlButton /></>} />
      <p role="note" className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-[#002855]"><b>Nuevo proceso:</b> el conductor carga el Packing List y la guía de remisión desde el app o el enlace de entrega. La salida a ruta ya no depende de la confirmación documentaria; esta bandeja queda como consulta y para documentos opcionales.</p>
      <div className="flex flex-wrap items-center gap-2">
        <TransportWorkflow current="documentos" torre={false} />
        {phase === 'salida' && <div className="ml-auto min-w-0"><InlineStatusBar label="Resumen documentario (filtra la tabla)" active={filter} loading={items === null} onChange={k => setFilter(k as typeof filter)}
          items={[{ key: 'TODOS', label: 'Todos', count: counts.PENDIENTE + counts.REEMISION + counts.LISTO, icon: <Layers />, tone: 'navy' }, { key: 'PENDIENTE', label: 'Pendientes', count: counts.PENDIENTE, icon: <Clock />, tone: 'amber' },
            { key: 'REEMISION', label: 'Reemisión', count: counts.REEMISION, icon: <AlertTriangle />, tone: 'rose' }, { key: 'LISTO', label: 'Listos', count: counts.LISTO, icon: <CheckCircle2 />, tone: 'emerald' }]} /></div>}
      </div>

      <FilterToolbar compact label="Etapa, búsqueda y período">
        <div role="tablist" aria-label="Etapas documentarias" className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {([['salida', packingOnly ? 'Planificación · Packing List' : 'Previos a salida'], ...(!packingOnly ? [['liquidacion', 'Liquidación pendiente'], ['conformidad', 'Conformidad'], ['observados', 'Observados / reemisión'], ['historial', 'Historial']] : [['historial', 'Historial de Packing List']])] as [DocumentPhase, string][]).map(([value, title]) => <button key={value} type="button" role="tab" aria-selected={phase === value} onClick={() => { setPhaseChoice(value); setFilter('TODOS') }} className={`min-h-11 rounded-md px-3 text-sm font-semibold lg:min-h-9 ${phase === value ? 'bg-white text-jrm-navy shadow-sm' : 'text-slate-600 hover:text-jrm-navy'}`}>{title}</button>)}
        </div>
        <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Buscar OT, solicitud, cliente, GR o despacho</span><Search aria-hidden className="absolute left-3 top-3.5 h-4 w-4 text-slate-400" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="OT, solicitud, cliente, GR o despacho" className={`${filterControl} pl-9`} /></label>
        {showDeparted && phase !== 'liquidacion' && <>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-500">Desde<input type="date" aria-label="Desde · salida programada" value={dateFrom} max={dateUntil} onChange={e => setDateFrom(e.target.value)} className={`${filterControl} w-40`} /></label>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-500">Hasta<input type="date" aria-label="Hasta · Lima" value={dateUntil} min={dateFrom} onChange={e => setDateUntil(e.target.value)} className={`${filterControl} w-40`} /></label>
        </>}
        {search && <button type="button" onClick={() => setSearch('')} className="min-h-11 rounded-lg px-3 text-sm font-medium text-blue-700 hover:bg-blue-50">Limpiar</button>}
        <details className="relative">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-jrm-navy hover:bg-blue-50 [&::-webkit-details-marker]:hidden"><Info className="h-4 w-4" aria-hidden="true" />Cómo funciona</summary>
          <div className="absolute right-0 z-30 mt-1 w-[min(36rem,calc(100vw-2rem))] rounded-jrm border border-jrm-line bg-white p-4 shadow-xl">
            <ol aria-label="Secuencia documentaria" className="space-y-3 text-sm">
              {[['Packing List firmado', 'Auditor de Despacho', 'Carga el Packing List en PDF, foto o Excel con su firma. El Asistente Documentario solo vincula los números de Guía de Remisión y Nota de Despacho; puede registrar varios por servicio.'], ['Guía de entrega', 'Conductor / proveedor JRM', 'Adjunta la guía firmada desde el app o el portal del proveedor al realizar la entrega.'], ['Conformidad', 'Supervisor de Transporte', 'Aprueba, observa o rechaza el sustento. Sin aprobación, el servicio no puede avanzar.']].map(([title, role, detail], index) => <li key={title} className="flex items-start gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-jrm-navy text-xs font-bold text-white">{index + 1}</span><div><p className="font-semibold text-jrm-navy">{title} <span className="font-medium text-slate-500">· {role}</span></p><p className="mt-0.5 text-xs leading-5 text-slate-500">{detail}</p></div></li>)}
            </ol>
            <p className="mt-3 border-t border-slate-100 pt-3 text-xs leading-5 text-slate-500">Una fila corresponde a un servicio; el despacho puede reunir varias OT. {showDeparted ? `Consulta por período de hasta 366 días. ${packingOnly ? 'Historial de Packing List por despacho, unidad y OT.' : 'Historial incluye despachos cancelados y sus documentos vigentes; las evidencias y revisiones conservan su historial.'}` : 'Ordenadas por salida del despacho.'}</p>
          </div>
        </details>
        <span className="ml-auto whitespace-nowrap text-xs text-slate-500" aria-live="polite">{items === null ? '' : `${visible.length} servicio(s)`}</span>
      </FilterToolbar>

      {isLoaded && !canNumbers && !canPacking && (
        <p className="text-sm text-slate-500 bg-slate-50 border rounded-lg p-3">Vista de consulta: el Auditor de Despacho carga el Packing List; el Asistente Documentario confirma los documentos. La validación de guías corresponde al Supervisor de Transporte.</p>
      )}

      {queueError && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">No se pudo actualizar la bandeja: {queueError}. {items ? 'Se conserva la última consulta.' : 'Pulsa Actualizar para reintentar.'}</p>}
      {items === null && !queueError ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        : !visible.length ? <p className="text-slate-500 text-sm p-6 text-center border border-slate-200 rounded-xl bg-white">{queueError && !items ? 'La bandeja no está disponible.' : phase === 'salida' && !packingOnly ? 'No hay servicios por salir. Los servicios ya cerrados con documentación pendiente están en «Liquidación pendiente».' : phase === 'liquidacion' ? 'No hay servicios cerrados con documentación pendiente.' : 'No hay solicitudes para estos filtros.'}</p>
        : <section aria-label="Control documentario por OT" className="overflow-hidden rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
          <div className="overflow-x-auto"><DataTable dense className="block w-full text-left text-sm lg:table"><caption className="sr-only">Solicitudes y OT asociadas, Packing List, guía de entrega y conformidad</caption><thead className="hidden bg-slate-50 text-xs text-slate-500 lg:table-header-group"><tr>{['Salida', 'Servicio', 'OT / OC / OS / RQ', 'Placa', 'Empresa', 'Destino', 'GR / Nota', 'Estado', 'Acciones'].map((label, i) => <th key={label} scope="col" className={`whitespace-nowrap px-3 py-2.5 font-semibold ${i === 8 ? 'text-right' : ''}`}>{label}</th>)}</tr></thead><tbody className="block divide-y divide-slate-200 lg:table-row-group">{visible.map(({ item, stop }) => <DocumentRow key={`${item.id}/${stop?.request_id || 'empty'}`} item={item} stop={stop} kind={stop && serviceTypes.has(stop.request_id) ? serviceKind(serviceTypes.get(stop.request_id)) : item.is_pickup ? 'RECOJO_CLIENTE' : null} info={stop ? serviceTypes.get(stop.request_id) : undefined} delivery={deliveries.find(row => row.dispatch_id === item.id && row.request_id === stop?.request_id)} canEdit={canNumbers || canPacking} packingOnly={packingOnly} onManage={() => openService(item.id, stop?.request_id || null)} onStatus={() => setStatusOf({ item, stop, delivery: deliveries.find(row => row.dispatch_id === item.id && row.request_id === stop?.request_id) })} />)}</tbody></DataTable></div>
        </section>}
      <Modal isOpen={!!selected} onClose={() => setSelectedId(null)} title={`Documentos · ${selected?.dispatch_number || ''}${focused && selected?.stops[0] ? ` · ${selected.stops[0].ot_code ? `OT ${selected.stops[0].ot_code}` : referenceLabel(serviceTypes.get(selected.stops[0].request_id)) || selected.stops[0].request_number}` : ''}`} maxWidth="max-w-[1440px]"
        footer={<div className="flex flex-wrap items-center justify-between gap-3"><p className="text-xs text-slate-600">{assistantOnly ? 'Vincula los números por servicio. La guía firmada y su aprobación se gestionan por separado.' : selected && ['CIERRE_OPERATIVO', 'RETORNO_COMPLETADO', 'ENTREGADO'].includes(selected.status) ? 'Ruta cerrada: completa la liquidación de cada servicio según su tipo.' : selected && !NOT_SETTLEABLE.includes(selected.status) ? 'Ruta en curso: puedes liquidar los servicios ya atendidos.' : selected?.missing ? 'Completa los documentos pendientes para autorizar la salida.' : selected?.docs_ready_at ? 'Documentos confirmados para salida.' : 'Documentos y archivos asociados al servicio.'}</p><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setSelectedId(null)} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">Cerrar</button>{selected && canEdit && selected.status === 'PROGRAMADO' && ['PENDIENTE', 'REEMISION'].includes(selected.doc_status) && <button type="button" onClick={() => void confirmDocs(selected)} disabled={busy === selected.id || !!selected.missing} className="flex min-h-11 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500">{busy === selected.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Confirmar documentos para salida</button>}</div></div>}>
        {selectedRoute && phase !== 'salida' && selectedRoute.stops.length > 1 && focusStop && <p className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-[#002855]">
          <span>{focused ? <>Liquidación por servicio: se muestra <b>1 de {selectedRoute.stops.length}</b> servicios de la ruta {selectedRoute.dispatch_number}.</> : <>Ruta {selectedRoute.dispatch_number} completa · {selectedRoute.stops.length} servicios.</>}</span>
          <button type="button" onClick={() => setShowAllStops(v => !v)} className="min-h-9 rounded-lg border border-blue-300 bg-white px-3 font-semibold hover:bg-blue-100">{focused ? `Ver los ${selectedRoute.stops.length} servicios` : 'Ver solo este servicio'}</button>
        </p>}
        {selected && <DispatchCard key={selected.id} item={selected} canEdit={canEdit && selected.status === 'PROGRAMADO'} canPacking={canPacking && selected.status === 'PROGRAMADO'} canSettle={(canNumbers || canManual) && !packingOnly && !NOT_SETTLEABLE.includes(selected.status)} canUpload={canNumbers} canManual={canManual} checklists={checklists} packingOnly={packingOnly} serviceTypes={serviceTypes}
          onVoid={voidDoc} onOpen={openDoc} onUploaded={load}
          deliveries={deliveries.filter(row => row.dispatch_id === selected.id)} onEvidence={row => { setSelectedId(null); setReview(row) }}>
          {!packingOnly && <DocumentNumberLinks key={selected.id} dispatchId={selected.id} services={selected.stops.map(stop => ({ ...stop, order_reference: referenceLabel(serviceTypes.get(stop.request_id)) }))} known={knownNumbers(selected, deliveries)} canEdit={canNumbers && selected.status !== 'CANCELADO'} onChanged={load} />}
        </DispatchCard>}
      </Modal>
      <DocumentStatusModal reference={statusOf?.stop ? referenceLabel(serviceTypes.get(statusOf.stop.request_id)) : null} target={statusOf} packingOnly={packingOnly} canEdit={canNumbers || canPacking} onClose={() => setStatusOf(null)} onManage={id => openService(id, statusOf?.stop?.request_id || null)} onEvidence={setReview} />
      {!packingOnly && <DeliveryReview row={review} onClose={() => setReview(null)} onChanged={() => void load()} />}
      {anulando && <AnularModal doc={anulando} onClose={() => setAnulando(null)} onDone={() => { setAnulando(null); void load() }} />}
    </div>
  )
}

/** Números que el servicio ya tiene por otra vía, para que el modal muestre lo mismo que la columna «GR / Nota». */
function knownNumbers(item: QueueItem, deliveries: DeliveryRow[]): KnownNumber[] {
  const fromDelivery = deliveries.filter(row => row.dispatch_id === item.id && row.guide_number)
    .map(row => ({ request_id: row.request_id, doc_type: 'GUIA_REMISION' as const, document_number: row.guide_number!, source: row.submission_id ? 'guía de entrega' : 'despacho' }))
  const fromFiles = item.documents.filter(doc => doc.request_id && doc.document_number && (doc.doc_type === 'GUIA_REMISION' || doc.doc_type === 'NOTA_DESPACHO'))
    .map(doc => ({ request_id: doc.request_id!, doc_type: doc.doc_type as KnownNumber['doc_type'], document_number: doc.document_number!, source: 'archivo cargado' }))
  return [...fromDelivery, ...fromFiles]
}

/** El recojo del cliente tiene su Nota de Despacho (archivo o número vinculado). */
function noteLinked(item: QueueItem, stop: Stop | null) {
  return item.documents.some(doc => doc.doc_type === 'NOTA_DESPACHO' && doc.request_id === stop?.request_id)
    || !!item.number_references?.some(ref => ref.doc_type === 'NOTA_DESPACHO' && ref.request_id === stop?.request_id)
}

/** GR (guía de entrega o registrada por Documentos) y Nota de Despacho del servicio. */
function stopNumbers(item: QueueItem, stop: Stop | null, delivery: DeliveryRow | undefined) {
  const own = item.documents.filter(doc => doc.request_id === stop?.request_id && doc.document_number)
  const refs = (item.number_references || []).filter(ref => ref.request_id === stop?.request_id)
  const guides = [...new Set([delivery?.guide_number, ...own.filter(doc => doc.doc_type === 'GUIA_REMISION').map(doc => doc.document_number), ...refs.filter(ref => ref.doc_type === 'GUIA_REMISION').map(ref => ref.document_number)].filter(Boolean))]
  const notes = [...new Set([...own.filter(doc => doc.doc_type === 'NOTA_DESPACHO').map(doc => doc.document_number), ...refs.filter(ref => ref.doc_type === 'NOTA_DESPACHO').map(ref => ref.document_number)].filter(Boolean))]
  return documentNumberLabel(guides.join(' · '), notes.join(' · '))
}

type DocStep = { label: string; detail: string; done: boolean; tone: 'ok' | 'pending' | 'danger' | 'na' }
type DocState = { label: string; tone: StatusTone; steps: DocStep[] }

/** Estado documentario único del servicio: resume Packing List, guía (o Nota de Despacho) y conformidad. */
function documentState(item: QueueItem, stop: Stop | null, delivery: DeliveryRow | undefined, packingOnly: boolean): DocState {
  const docs = item.documents.filter(doc => !doc.request_id || doc.request_id === stop?.request_id)
  const packing = docs.find(doc => doc.doc_type === 'PACKING_LIST' && doc.signed && doc.auditor_name && doc.auditor_signed_date)
  const note = docs.find(doc => doc.doc_type === 'NOTA_DESPACHO' && doc.request_id === stop?.request_id) || item.number_references?.find(ref => ref.doc_type === 'NOTA_DESPACHO' && ref.request_id === stop?.request_id)
  const conformity = delivery?.conformity
  const steps: DocStep[] = [
    { label: '1. Packing List', detail: packing ? `Firmado${packing.request_id ? '' : ' · consolidado'}${packing.auditor_name ? ` · ${packing.auditor_name}` : ''}` : 'Firma pendiente del Auditor de Despacho', done: !!packing, tone: packing ? 'ok' : 'pending' },
    item.is_pickup
      ? { label: '2. Nota de Despacho', detail: note ? 'Número vinculado' : 'Número pendiente', done: !!note, tone: note ? 'ok' : 'pending' }
      : { label: '2. Guía de entrega', detail: delivery?.guide_number ? `${delivery.guide_number}${delivery.photos_count ? ` · ${delivery.photos_count} foto(s)` : ''}` : item.status === 'PROGRAMADO' ? 'Se recibe del conductor o proveedor al entregar' : 'Aún no recibida', done: !!delivery?.guide_number, tone: delivery?.guide_number ? 'ok' : 'pending' },
    item.is_pickup
      ? { label: '3. Conformidad', detail: 'No aplica · recojo del cliente', done: true, tone: 'na' }
      : item.status === 'PROGRAMADO' && !conformity
        ? { label: '3. Conformidad', detail: 'Después de la entrega', done: false, tone: 'na' }
        : { label: '3. Conformidad', detail: conformity ? conformityLabels[conformity] : 'No disponible', done: conformity === 'VALIDADA', tone: conformity === 'VALIDADA' ? 'ok' : ['OBSERVADA', 'RECHAZADA'].includes(conformity || '') ? 'danger' : 'pending' },
  ]
  if (packingOnly) {
    // El perfil de Packing List no consulta guías ni conformidad: su estado es solo el del Packing List
    const own = steps.slice(0, 1)
    if (item.docs_reissue) return { label: 'Reemisión', tone: 'danger', steps: own }
    return packing ? { label: 'Packing firmado', tone: 'success', steps: own } : { label: 'Packing pendiente', tone: 'warning', steps: own }
  }
  if (item.docs_reissue) return { label: 'Reemisión', tone: 'danger', steps }
  if (item.status === 'PROGRAMADO') return item.doc_status === 'LISTO' ? { label: 'Listo para salir', tone: 'success', steps } : { label: 'Docs. pendientes', tone: 'warning', steps }
  if (item.is_pickup) return note ? { label: 'Completo', tone: 'success', steps } : { label: 'Nota pendiente', tone: 'warning', steps }
  if (conformity === 'VALIDADA') return { label: 'Conforme', tone: 'success', steps }
  if (conformity === 'OBSERVADA' || conformity === 'RECHAZADA') return { label: conformityLabels[conformity], tone: 'danger', steps }
  if (conformity === 'RECIBIDA') return { label: 'Por validar', tone: 'info', steps }
  if (conformity === 'HISTORICA') return { label: 'Histórica', tone: 'neutral', steps }
  if (conformity === 'NO_APLICA') return { label: 'No aplica', tone: 'neutral', steps }
  if (!delivery) return { label: 'Sin consultar', tone: 'neutral', steps }
  return { label: 'Guía pendiente', tone: 'warning', steps }
}

function DocumentRow({ item, stop, kind, info, delivery, canEdit, packingOnly, onManage, onStatus }: {
  item: QueueItem; stop: Stop | null; kind: ServiceKind | null; info?: { supplier_name: string | null; reference_type: string | null; reference_number: string | null }; delivery?: DeliveryRow; canEdit: boolean; packingOnly: boolean; onManage: () => void; onStatus: () => void
}) {
  const state = documentState(item, stop, delivery, packingOnly)
  const urgent = !['LISTO', 'SALIO'].includes(item.doc_status) && (hoursLeft(item.scheduled_departure) ?? Infinity) < 2
  const cell = 'min-w-0 px-3 py-2 align-middle lg:px-2.5'
  const label = (text: string) => <p className="mb-1 text-xs font-semibold text-slate-500 lg:hidden">{text}</p>
  const driver = item.is_pickup ? 'Recoge el cliente en planta' : item.driver_name || (item.modalidad === 'TERCERO' ? 'Proveedor JRM' : 'Sin conductor')
  const point = kind === 'RECOJO' ? stop?.origin : stop?.delivery
  return <tr className={`grid grid-cols-1 sm:grid-cols-2 lg:table-row ${urgent ? 'bg-amber-50/50' : ''}`}>
    <td className={cell}>{label('Salida')}<span className={`whitespace-nowrap text-xs ${urgent ? 'font-semibold text-amber-800' : 'text-slate-700'}`} title={urgent ? 'Sale en menos de 2 horas' : fullDateTime(item.scheduled_departure)}>{cellDateTime(item.scheduled_departure)}</span></td>
    <td className={cell}>{label('Servicio')}<ServiceTypeBadge kind={kind} /></td>
    <td className={cell}>{label('OT')}<span className="whitespace-nowrap font-bold text-jrm-navy" title={stop ? `Solicitud ${stop.request_number} · Despacho ${item.dispatch_number}` : undefined}>{stop?.ot_code ? `OT ${stop.ot_code}` : referenceLabel(info) || 'Sin OT'}</span></td>
    <td className={cell}>{label('Placa')}<span className="whitespace-nowrap text-xs font-bold uppercase text-slate-800" title={driver}>{item.is_pickup ? 'Cliente' : item.vehicle_plate || 'Sin placa'}</span></td>
    <td className={cell}>{label('Empresa')}{(() => { const supplierRow = kind === 'RECOJO' || kind === 'PUNTO_A_PUNTO', party = supplierRow ? info?.supplier_name || stop?.client : stop?.client; return <p className="truncate font-medium text-slate-800 lg:max-w-40 xl:max-w-48 2xl:max-w-64" title={party ? `${supplierRow ? 'Proveedor' : 'Cliente'}: ${party}` : undefined}>{party || (supplierRow ? 'Proveedor sin vincular' : 'Sin cliente registrado')}</p> })()}</td>
    <td className={cell}>{label(kind === 'RECOJO' ? 'Origen' : 'Destino')}<p className="truncate text-slate-700 lg:max-w-32 xl:max-w-40" title={point || undefined}>{point ? districtOf(point) : 'Sin dirección'}</p></td>
    <td className={cell}>{label('GR / Nota')}{(n => <span title={n.title} className={`whitespace-nowrap ${n.pending ? 'text-xs font-semibold text-amber-700' : 'text-sm font-semibold text-slate-800'}`}>{n.text}</span>)(stopNumbers(item, stop, delivery))}</td>
    <td className={cell}>{label('Estado')}<button type="button" onClick={onStatus} title="Ver Packing List, guía y conformidad" className="inline-flex items-center gap-1 rounded-full focus-visible:outline-2 focus-visible:outline-jrm-navy"><StatusBadge tone={state.tone}>{state.label}</StatusBadge><ChevronRight aria-hidden className="h-3.5 w-3.5 text-slate-400" /></button></td>
    <td className={`${cell} lg:text-right`}>{label('Acciones')}<button type="button" onClick={onManage} className="min-h-11 whitespace-nowrap rounded-lg bg-jrm-navy px-3 text-xs font-semibold text-white hover:bg-jrm-navy-dark lg:min-h-8">{canEdit ? packingOnly ? 'Cargar Packing List' : 'Vincular / ver documentos' : 'Ver documentos'}</button></td>
  </tr>
}

/** Modal de estado documentario: los tres pasos del servicio y sus acciones. */
function DocumentStatusModal({ target, reference, packingOnly, canEdit, onClose, onManage, onEvidence }: {
  target: { item: QueueItem; stop: Stop | null; delivery?: DeliveryRow } | null; reference: string | null; packingOnly: boolean; canEdit: boolean
  onClose: () => void; onManage: (id: string) => void; onEvidence: (row: DeliveryReviewTarget) => void
}) {
  if (!target) return null
  const { item, stop, delivery } = target
  const state = documentState(item, stop, delivery, packingOnly)
  const tone = { ok: 'border-emerald-200 bg-emerald-50 text-emerald-800', pending: 'border-amber-200 bg-amber-50 text-amber-800', danger: 'border-rose-200 bg-rose-50 text-rose-800', na: 'border-slate-200 bg-slate-50 text-slate-600' }
  return <Modal isOpen onClose={onClose} title={`Estado documentario · ${stop?.ot_code ? `OT ${stop.ot_code}` : reference || 'Sin referencia'}`} maxWidth="max-w-lg"
    footer={<div className="flex flex-wrap justify-end gap-2">
      <button type="button" onClick={onClose} className="min-h-11 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700">Cerrar</button>
      {!packingOnly && delivery && !item.is_pickup && <button type="button" onClick={() => { onClose(); onEvidence(delivery) }} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy"><FileCheck2 className="h-4 w-4" />Guía y conformidad</button>}
      <button type="button" onClick={() => { onClose(); onManage(item.id) }} className="min-h-11 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white">{canEdit && item.status === 'PROGRAMADO' ? 'Gestionar documentos' : 'Ver documentos'}</button>
    </div>}>
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><StatusBadge tone={state.tone}>{state.label}</StatusBadge><span className="text-xs text-slate-500">Solicitud {stop?.request_number || '—'} · Despacho {item.dispatch_number} · Sale {cellDateTime(item.scheduled_departure)}</span></div>
      {item.docs_reissue && <p className="rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs font-medium text-rose-800">Reemisión: {item.docs_reissue_reason || 'actualizar y confirmar documentos'}</p>}
      <ol className="space-y-2">{state.steps.map(step => <li key={step.label} className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${tone[step.tone]}`}>
        <span className="font-semibold">{step.label}</span><span className="text-right text-xs">{step.detail}</span>
      </li>)}</ol>
    </div>
  </Modal>
}

function DispatchCard({ item, canEdit, canPacking, canSettle = false, canUpload = false, canManual = false, checklists, packingOnly, serviceTypes, onVoid, onOpen, onUploaded, deliveries, onEvidence, children }: {
  item: QueueItem; canEdit: boolean; canPacking: boolean; canSettle?: boolean; canUpload?: boolean; canManual?: boolean; checklists?: Map<string, SettlementChecklist>; packingOnly: boolean; serviceTypes: Awaited<ReturnType<typeof fetchServiceTypes>>; onVoid: (d: Doc) => void
  onOpen: (p: string) => void; onUploaded: () => Promise<void>; deliveries: DeliveryRow[]; onEvidence: (row: DeliveryReviewTarget) => void; children?: React.ReactNode
}) {
  const [upload, setUpload] = useState<{ requestId: string | null; type: string; label: string } | null>(null)
  const uploadPanel = useRef<HTMLDivElement>(null)
  useEffect(() => { if (upload) uploadPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }, [upload])
  const badge = STATUS_BADGE[item.doc_status]
  const generalDocs = item.documents.filter(d => !d.request_id)
  const consolidated = generalDocs.find(d => d.doc_type === 'PACKING_LIST' && d.signed && d.auditor_name && d.auditor_signed_date)
  const h = hoursLeft(item.scheduled_departure)
  const urgent = !['LISTO', 'SALIO'].includes(item.doc_status) && h !== null && h < 2
  const action = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold lg:min-h-9'
  const secondary = `${action} border border-slate-300 bg-white text-[#002855] hover:bg-slate-50`
  // Estado de cada documento requerido en una sola línea: verde listo, ámbar pendiente
  const chip = (title: string, ready: boolean, detail: string, optional = false) => <li className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${ready ? 'bg-emerald-50 text-emerald-800 ring-emerald-200' : optional ? 'bg-slate-50 text-slate-600 ring-slate-200' : 'bg-amber-50 text-amber-800 ring-amber-200'}`}>{ready ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> : <Clock className="h-3.5 w-3.5 shrink-0" />}<span className="font-semibold">{title}</span><span>· {detail}</span></li>
  const beginUpload = (requestId: string | null, type: string, title: string) => setUpload({ requestId, type, label: title })
  const uploadForm = (requestId: string | null) => upload && upload.requestId === requestId && (canPacking || canEdit) && <div ref={uploadPanel} className="scroll-m-4 border-t border-blue-200 bg-blue-50/40 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-bold text-[#002855]">{DOC_LABEL[upload.type]} · {upload.label}</h4><p className="mt-0.5 text-xs text-slate-500">{upload.requestId ? 'El archivo se vincula únicamente a esta solicitud.' : 'Este archivo cubre todas las solicitudes y OT del despacho.'}</p></div><button type="button" onClick={() => setUpload(null)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 lg:min-h-9">Cancelar</button></div><UploadForm key={`${upload.requestId}/${upload.type}`} dispatchId={item.id} requestId={upload.requestId} isPickup={item.is_pickup} canPacking={canPacking} canDocuments={canEdit} documentType={upload.type} onUploaded={async () => { await onUploaded(); setUpload(null) }} /></div>

  return <div className="min-w-0 space-y-4">
    <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
      <div className="flex items-center gap-2"><Truck aria-hidden className="h-4 w-4 text-[#002855]" /><dt className="sr-only">Unidad</dt><dd><span className="font-bold text-[#002855]">{item.is_pickup ? 'Unidad del cliente' : item.vehicle_plate || 'Sin unidad'}</span> <span className="text-xs text-slate-500">· {item.is_pickup ? 'Recojo por el cliente' : item.modalidad === 'TERCERO' ? 'Transporte contratado por JRM' : 'Transporte JRM'}</span></dd></div>
      <div className="flex items-center gap-1.5"><dt className="text-xs text-slate-500">Conductor</dt><dd className="font-semibold text-slate-800">{item.is_pickup ? 'No aplica' : item.driver_name || 'Sin conductor registrado'}</dd></div>
      <div className="flex items-center gap-1.5"><dt className="text-xs text-slate-500">Salida</dt><dd className={`font-semibold ${urgent ? 'text-red-700' : 'text-slate-800'}`}>{fmtDate(item.scheduled_departure, true)}{urgent && <span className="ml-1 text-xs font-medium">· {h !== null && h < 0 ? 'atrasada' : 'próxima'}</span>}</dd></div>
      <div className="flex items-center gap-1.5 sm:ml-auto"><dt className="sr-only">Estado documentario</dt><dd className="flex items-center gap-2"><StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>{item.docs_ready_at && !item.docs_reissue && <span className="text-xs text-emerald-700">Confirmado · {fmtDate(item.docs_ready_at, true)}</span>}</dd></div>
    </dl>
    {item.docs_reissue && <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Reemisión: {item.docs_reissue_reason || 'Actualizar los documentos del servicio.'}</p>}

    <section aria-label="Documentos por servicio" className="space-y-3">
      <h3 className="text-sm font-bold text-[#002855]">Servicios <span className="font-normal text-slate-500">· {item.stops.length}{item.is_pickup ? ' · Recojo por el cliente' : ''}</span></h3>
      {!item.stops.length && <p className="rounded-xl border border-slate-200 p-4 text-sm text-slate-500">Este despacho no tiene solicitudes asociadas.</p>}
      {item.stops.map((s, i) => {
        const docs = item.documents.filter(d => d.request_id === s.request_id)
        const packing = docs.find(d => d.doc_type === 'PACKING_LIST' && d.signed && d.auditor_name && d.auditor_signed_date) || consolidated
        const note = docs.find(d => d.doc_type === 'NOTA_DESPACHO')
        const delivery = deliveries.find(d => d.request_id === s.request_id)
        const reference = s.ot_code ? `OT ${s.ot_code}` : referenceLabel(serviceTypes.get(s.request_id)) || 'Sin referencia'
        const title = `${reference} · ${s.request_number}`
        const check = checklists?.get(`${item.id}/${s.request_id}`)
        const kind = check?.kind || settlementKind(serviceTypes.get(s.request_id), item.is_pickup)
        return <article key={s.request_id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
            <div className="min-w-0"><p className="break-words font-bold text-[#002855]">{reference} <span className="text-sm font-semibold text-slate-600">· {s.request_number}</span> <span className="text-xs font-normal text-slate-500">· Parada {s.sequence || i + 1}</span></p><p className="mt-0.5 break-words text-sm text-slate-700">{s.client || 'Sin cliente registrado'}</p></div>
            <ul aria-label="Documentos requeridos" className="flex flex-wrap gap-1.5">
              {/* Documentos según el tipo de servicio (misma regla que la liquidación): entrega = GR o Nota + Packing List;
                  recojo = GR; punto a punto = opcionales; recojo por el cliente = Nota de Despacho */}
              {kind === 'ENTREGA' && chip('Packing List', !!packing || !!check?.packing, packing ? `${packing.request_id ? 'Cargado' : 'Consolidado'}${packing.auditor_name ? ` · ${packing.auditor_name}` : ''}` : check?.packing ? 'Cargado' : 'Pendiente')}
              {kind === 'RECOJO_CLIENTE' && chip('Nota de Despacho', !!note || !!check?.note, note || check?.note ? 'Cargada' : 'Pendiente (Asistente)')}
              {!packingOnly && kind === 'ENTREGA' && chip('GR o Nota de Despacho', delivery?.conformity === 'VALIDADA' || !!note || !!check?.note, note || check?.note ? 'Nota de Despacho cargada' : `${delivery ? conformityLabels[delivery.conformity] : 'Aún no disponible'}${delivery?.guide_number ? ` · ${delivery.guide_number}` : ''}`)}
              {!packingOnly && kind === 'RECOJO' && chip('Guía de Remisión', delivery?.conformity === 'VALIDADA', `${delivery ? conformityLabels[delivery.conformity] : 'Aún no disponible'}${delivery?.guide_number ? ` · ${delivery.guide_number}` : ''}`)}
              {!packingOnly && kind === 'TRASLADO' && chip('Documentos', !!packing || !!note || delivery?.conformity === 'VALIDADA' || !!check?.references.length, 'Opcionales en punto a punto', true)}
            </ul>
          </header>
          <div className="grid gap-4 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <dl className="min-w-0 space-y-1.5 text-xs leading-5">
              <div className="flex gap-2"><dt className="w-16 shrink-0 font-semibold text-slate-500">Origen</dt><dd className="min-w-0 break-words text-slate-700">{s.origin || 'Sin origen registrado'}</dd></div>
              <div className="flex gap-2"><dt className="w-16 shrink-0 font-semibold text-slate-500">Destino</dt><dd className="min-w-0 break-words text-slate-700">{s.delivery || 'Sin destino registrado'}</dd></div>
              <div className="flex gap-2"><dt className="w-16 shrink-0 font-semibold text-slate-500">Carga</dt><dd className="min-w-0 text-slate-700">{s.cargo && s.cargo.length > 90 ? <details><summary className="cursor-pointer break-words">{s.cargo.slice(0, 90).trim()}… <span className="font-semibold text-blue-700">Ver todo</span></summary><p className="mt-1 whitespace-pre-line break-words">{s.cargo}</p></details> : <span className="whitespace-pre-line break-words">{s.cargo || 'Sin detalle registrado'}</span>}</dd></div>
            </dl>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-500">Archivos {docs.length ? `(${docs.length})` : ''}</p>
              {docs.length ? <DocList docs={docs} canEdit={canEdit} onVoid={onVoid} onOpen={onOpen} /> : <p className="mt-1 text-xs text-slate-400">Sin archivos cargados.</p>}
            </div>
          </div>
          {(canPacking || canEdit || consolidated || (!packingOnly && !item.is_pickup && delivery)) && <div className="flex flex-wrap gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
            {canPacking && <button type="button" onClick={() => beginUpload(s.request_id, 'PACKING_LIST', title)} className={`${action} bg-[#002855] text-white hover:bg-[#003b7a]`}><Upload className="h-4 w-4" />{packing ? 'Actualizar Packing List' : 'Cargar Packing List'}</button>}
            {canEdit && item.is_pickup && <button type="button" onClick={() => beginUpload(s.request_id, 'NOTA_DESPACHO', title)} className={secondary}><Upload className="h-4 w-4" />{note ? 'Nueva Nota de Despacho' : 'Cargar Nota de Despacho'}</button>}
            {canEdit && <button type="button" onClick={() => beginUpload(s.request_id, 'OTRO', title)} className={secondary}><Upload className="h-4 w-4" />Otro documento</button>}
            {consolidated && <button type="button" onClick={() => onOpen(consolidated.file_path)} className={secondary}><FileText className="h-4 w-4" />Packing List consolidado</button>}
            {!packingOnly && !item.is_pickup && delivery && <button type="button" onClick={() => onEvidence(delivery)} className={`${secondary} sm:ml-auto`}><FileCheck2 className="h-4 w-4" />Ver guía y conformidad</button>}
          </div>}
          {uploadForm(s.request_id)}
          {canSettle && <SettlementUpload key={`${s.request_id}/${checklists?.get(`${item.id}/${s.request_id}`)?.kind || ''}`} dispatchId={item.id} requestId={s.request_id} checklist={checklists?.get(`${item.id}/${s.request_id}`)} canUpload={canUpload} canManual={canManual} onUploaded={onUploaded} />}
        </article>
      })}
    </section>

    {children}

    {(!!generalDocs.length || canEdit || canPacking) && <section aria-label="Archivos de todo el despacho" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"><div><h3 className="text-sm font-bold text-[#002855]">Archivos de todo el despacho</h3><p className="text-xs text-slate-500">Cubren todas las OT del despacho{generalDocs.length ? ` · ${generalDocs.length} archivo(s)` : ''}.</p></div><div className="flex flex-wrap gap-2">
        {canPacking && <button type="button" onClick={() => beginUpload(null, 'PACKING_LIST', 'Todas las solicitudes del despacho')} className={secondary}><Upload className="h-4 w-4" />{consolidated ? 'Reemplazar Packing List consolidado' : 'Packing List consolidado'}</button>}
        {canEdit && <button type="button" onClick={() => beginUpload(null, 'OTRO', 'Todas las solicitudes del despacho')} className={secondary}><Upload className="h-4 w-4" />Otro archivo</button>}
      </div></div>
      {!!generalDocs.length && <div className="border-t border-slate-100 px-4 pb-3"><DocList docs={generalDocs} canEdit={canEdit} onVoid={onVoid} onOpen={onOpen} /></div>}
      {uploadForm(null)}
    </section>}
  </div>
}

// Liquidación por servicio: desde que la ruta sale (también en curso) hasta que se liquida
const NOT_SETTLEABLE = ['PROGRAMADO', 'CANCELADO', 'LIQUIDADO', 'CERRADO']

// Liquidación pendiente: la oficina completa los documentos de un servicio cerrado según su tipo (misma regla que la
// base, settlement_checklist). Documentos con número: primero el número (serie-correlativo); con el número válido se
// activa la carga. Packing List sin correlativo: carga directa. La liquidación es automática al completar los
// obligatorios; la GR cuenta cuando el Supervisor de Transporte la valida. El app del conductor no cambia.
// Tipo de servicio para los documentos requeridos, con los datos de la solicitud (antes de tener la lista de la base)
function settlementKind(info: Parameters<typeof serviceKind>[0], pickup: boolean): SettlementChecklist['kind'] {
  const kind = serviceKind(info)
  if (pickup || kind === 'RECOJO_CLIENTE') return 'RECOJO_CLIENTE'
  return kind === 'RECOJO' ? 'RECOJO' : kind === 'PUNTO_A_PUNTO' ? 'TRASLADO' : 'ENTREGA'
}
type SettlementChecklist = {
  dispatch_id: string; request_id: string; kind: 'ENTREGA' | 'RECOJO' | 'TRASLADO' | 'RECOJO_CLIENTE' | 'RECHAZO'; complete: boolean
  missing: string[]; guide_state: string; note: boolean; packing: boolean; references: string[]
  rejection?: { reason: string; note: string | null; photos: number; captured_at: string; decision: string | null; decision_reason: string | null; decided_at: string | null }
  manual?: { reason: string; missing: string[]; closed_at: string; closed_by: string | null }
}
type NumberedKind = 'GUIA' | 'NOTA' | 'OC' | 'OS' | 'RQ'
const NUMBERED: Record<NumberedKind, { label: string; pattern: RegExp; example: string; hint: string }> = {
  GUIA: { label: 'Guía de Remisión', pattern: /^[A-Z0-9]{3,4}-[0-9]{1,10}$/, example: 'T001-6591', hint: 'Serie y correlativo separados por guion, sin espacios ni ceros omitidos.' },
  NOTA: { label: 'Nota de Despacho', pattern: /^[A-Z0-9]{1,8}-[0-9]{1,10}$/, example: 'ND01-1234', hint: 'Serie y correlativo separados por guion.' },
  OC: { label: 'Orden de Compra (OC)', pattern: /^[A-Z0-9][A-Z0-9/-]{0,29}$/, example: '57724', hint: 'Número de la orden: letras, números, guion o barra.' },
  OS: { label: 'Orden de Servicio (OS)', pattern: /^[A-Z0-9][A-Z0-9/-]{0,29}$/, example: '12045', hint: 'Número de la orden: letras, números, guion o barra.' },
  RQ: { label: 'Requerimiento (RQ)', pattern: /^[A-Z0-9][A-Z0-9/-]{0,29}$/, example: '3381', hint: 'Número del requerimiento: letras, números, guion o barra.' },
}
// Documentos por tipo de servicio: obligatorios (uno de cada grupo) y opcionales
const SETTLEMENT_RULES: Record<SettlementChecklist['kind'], { label: string; required: string; numbered: NumberedKind[]; packingRequired: boolean; packingAllowed: boolean }> = {
  ENTREGA: { label: 'Entrega', required: 'Guía de Remisión (validada) o Nota de Despacho, y Packing List', numbered: ['GUIA', 'NOTA'], packingRequired: true, packingAllowed: true },
  RECOJO: { label: 'Recojo hacia planta', required: 'Guía de Remisión (validada). OC, OS o RQ opcionales', numbered: ['GUIA', 'OC', 'OS', 'RQ'], packingRequired: false, packingAllowed: false },
  TRASLADO: { label: 'Punto a punto', required: 'Ninguno: todos los documentos son opcionales', numbered: ['GUIA', 'NOTA', 'OC', 'OS', 'RQ'], packingRequired: false, packingAllowed: true },
  RECOJO_CLIENTE: { label: 'Recojo por el cliente', required: 'Nota de Despacho', numbered: ['NOTA'], packingRequired: false, packingAllowed: true },
  RECHAZO: { label: 'Rechazada en destino', required: 'evidencia del rechazo (fotos del conductor) y decisión de Despacho: reprogramar o anular', numbered: [], packingRequired: false, packingAllowed: false },
}
const MISSING_LABEL: Record<string, string> = { GUIA_O_NOTA: 'GR validada o Nota de Despacho', PACKING_LIST: 'Packing List', GUIA_REMISION: 'GR validada', NOTA_DESPACHO: 'Nota de Despacho', DECISION_RECHAZO: 'Decisión de Despacho (reprogramar o anular)' }
// Uno de los documentos con número es obligatorio según el tipo de servicio (en entrega: GR o Nota, uno de los dos)
const requiredFor = (service: SettlementChecklist['kind'], doc: NumberedKind) => service === 'ENTREGA' ? doc === 'GUIA' || doc === 'NOTA' : service === 'RECOJO' ? doc === 'GUIA' : service === 'RECOJO_CLIENTE' ? doc === 'NOTA' : false
const GUIDE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp'
const guideMime = (file: File) => /\.pdf$/i.test(file.name) ? 'application/pdf' : /\.png$/i.test(file.name) ? 'image/png' : /\.webp$/i.test(file.name) ? 'image/webp' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : null
const safeName = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(-80)

function SettlementUpload({ dispatchId, requestId, checklist, canUpload, canManual, onUploaded }: {
  dispatchId: string; requestId: string; checklist: SettlementChecklist | undefined; canUpload: boolean; canManual: boolean; onUploaded: () => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const rule = SETTLEMENT_RULES[checklist?.kind || 'ENTREGA']
  // La GR ya enviada (en revisión o aprobada) no se vuelve a cargar aquí; observada o rechazada sí.
  const guideOpen = !checklist || ['PENDIENTE', 'OBSERVADA', 'RECHAZADA'].includes(checklist.guide_state)
  const options = rule.numbered.filter(k => k !== 'GUIA' || guideOpen)
  const [kind, setKind] = useState<NumberedKind>(options[0] || 'NOTA')
  const [number, setNumber] = useState('')
  const [docFiles, setDocFiles] = useState<File[]>([])
  const [packingFiles, setPackingFiles] = useState<File[]>([])
  const [busy, setBusy] = useState<'' | 'doc' | 'packing' | 'manual'>('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualReason, setManualReason] = useState('')
  const operation = useRef(crypto.randomUUID())
  const active = options.includes(kind) ? kind : options[0]
  const spec = active ? NUMBERED[active] : null
  const normalized = number.trim().toUpperCase()
  const valid = !!spec && spec.pattern.test(normalized)

  const send = async (docKind: NumberedKind | 'PACKING', files: File[]) => {
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) throw new Error('Sesión vencida: vuelva a ingresar')
    const evidence = docKind === 'GUIA'
    const bucket = evidence ? 'driver_evidence' : DOCS_BUCKET
    const paths: string[] = []
    try {
      for (const file of files) {
        const mime = evidence ? guideMime(file) : packingMime(file)
        if (!mime) throw new Error(`${file.name}: formato no permitido`)
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name}: supera 10 MB`)
        const path = evidence ? `${auth.user.id}/tercero/${dispatchId}/${crypto.randomUUID()}-${safeName(file.name)}` : `${dispatchId}/${crypto.randomUUID()}-${safeName(file.name)}`
        const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: mime })
        if (error) throw new Error(`No se pudo subir ${file.name}: ${errorMessage(error)}`)
        paths.push(path)
      }
      const { data, error } = await supabase.rpc('settlement_upload_document', {
        p_dispatch: dispatchId, p_request: requestId, p_kind: docKind, p_number: docKind === 'PACKING' ? null : normalized,
        p_files: paths, p_file_names: files.map(f => f.name), p_operation: docKind === 'GUIA' ? operation.current : null,
      })
      if (error) throw error
      if (!(data as { success?: boolean } | null)?.success) throw new Error('No se pudo registrar el documento')
    } catch (error) {
      // Archivos sin registro no sirven: se retiran para no dejar huérfanos
      if (paths.length) await supabase.storage.from(bucket).remove(paths)
      throw error
    }
  }
  const submitDoc = async () => {
    if (!valid || !active || !docFiles.length || busy) return
    setBusy('doc')
    try {
      await send(active, docFiles)
      toast.success(active === 'GUIA' ? `Guía ${normalized} cargada: pasa a validación del Supervisor de Transporte` : `${NUMBERED[active].label} ${normalized} cargada`)
      setNumber(''); setDocFiles([]); operation.current = crypto.randomUUID()
      await onUploaded()
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy('') }
  }
  const submitPacking = async () => {
    if (!packingFiles.length || busy) return
    setBusy('packing')
    try {
      await send('PACKING', packingFiles)
      toast.success(packingFiles.length > 1 ? `${packingFiles.length} archivos de Packing List cargados` : 'Packing List cargado')
      setPackingFiles([])
      await onUploaded()
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy('') }
  }
  const settleManually = async () => {
    if (manualReason.trim().length < 10 || busy) return
    setBusy('manual')
    try {
      const { error } = await supabase.rpc('settlement_mark_settled', { p_dispatch: dispatchId, p_request: requestId, p_reason: manualReason.trim() })
      if (error) throw error
      toast.success('Servicio dado por liquidado')
      setManualOpen(false); setManualReason('')
      await onUploaded()
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy('') }
  }
  const undoManual = async () => {
    if (busy) return
    setBusy('manual')
    try {
      const { error } = await supabase.rpc('settlement_undo_manual', { p_dispatch: dispatchId, p_request: requestId })
      if (error) throw error
      toast.success('Liquidación manual revertida: vuelve a la regla automática')
      await onUploaded()
    } catch (error) { toast.error(errorMessage(error)) } finally { setBusy('') }
  }
  const pick = (setter: (files: File[]) => void) => (event: React.ChangeEvent<HTMLInputElement>) => { setter(Array.from(event.target.files || []).slice(0, 5)); event.target.value = '' }
  const fileButton = 'inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855] hover:bg-slate-50 lg:min-h-9'
  const primary = 'inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white disabled:opacity-40 lg:min-h-9'
  const chosen = (files: File[], clear: () => void) => files.length > 0 && <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">{files.map(f => <span key={f.name + f.size} className="inline-flex items-center gap-1"><KindTag kind={fileKind(f.name, f.type)} />{f.name}</span>)}<button type="button" onClick={clear} className="font-semibold text-red-700">Quitar</button></p>
  const tag = (required: boolean) => <span className={`ml-1 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${required ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-600'}`}>{required ? 'Obligatorio' : 'Opcional'}</span>
  const guideNote = checklist?.rejection ? `Rechazo en destino: ${checklist.rejection.reason}${checklist.rejection.note ? ` · ${checklist.rejection.note}` : ''} · ${checklist.rejection.photos} foto(s)${checklist.rejection.decision ? ` · ${checklist.rejection.decision === 'REPROGRAMADA' ? 'reprogramada' : 'anulada'}: ${checklist.rejection.decision_reason || ''}` : ''}`
    : checklist && !guideOpen ? `GR ${checklist.guide_state === 'RECIBIDA' ? 'enviada · en validación del Supervisor de Transporte' : conformityLabels[checklist.guide_state as keyof typeof conformityLabels] || checklist.guide_state}` : null

  return <div className={`space-y-3 border-t px-4 py-3 ${checklist?.complete ? 'border-emerald-200 bg-emerald-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-[#002855]">Liquidación · {rule.label}</p>
        <p className="text-xs text-slate-600">Obligatorio: {rule.required}.</p>
      </div>
      {checklist && (checklist.complete
        ? <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-800"><CheckCircle2 className="h-3.5 w-3.5" />{checklist.manual ? 'Liquidado manualmente' : 'Liquidado automáticamente'}</span>
        : <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900"><Clock className="h-3.5 w-3.5" />Falta: {checklist.missing.map(m => MISSING_LABEL[m] || m).join(' · ')}</span>)}
    </div>
    {(guideNote || checklist?.note || checklist?.packing || !!checklist?.references.length) && <p className="flex flex-wrap gap-1.5 text-xs">
      {guideNote && <span className="rounded bg-white px-2 py-0.5 ring-1 ring-slate-200">{guideNote}</span>}
      {checklist?.note && <span className="rounded bg-white px-2 py-0.5 ring-1 ring-slate-200">Nota de Despacho vinculada</span>}
      {checklist?.packing && <span className="rounded bg-white px-2 py-0.5 ring-1 ring-slate-200">Packing List cargado</span>}
      {checklist?.references.map(ref => <span key={ref} className="rounded bg-white px-2 py-0.5 ring-1 ring-slate-200">{ref}</span>)}
    </p>}
    {checklist?.manual && <div className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-white px-3 py-2 text-xs ring-1 ring-emerald-200">
      <p className="min-w-0 text-slate-700"><strong>Dado por liquidado</strong>{checklist.manual.closed_by ? ` por ${checklist.manual.closed_by}` : ''} · {new Date(checklist.manual.closed_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}<span className="block text-slate-600">Motivo: {checklist.manual.reason}</span>{!!checklist.manual.missing?.length && <span className="block text-slate-500">Faltaba: {checklist.manual.missing.map(m => MISSING_LABEL[m] || m).join(' · ')}</span>}</p>
      {canManual && <button type="button" onClick={() => void undoManual()} disabled={!!busy} className="min-h-9 rounded-lg border border-slate-300 bg-white px-3 font-semibold text-slate-700 disabled:opacity-40">Revertir</button>}
    </div>}
    {canManual && checklist && !checklist.complete && (manualOpen
      ? <div className="space-y-2 rounded-lg bg-white p-3 ring-1 ring-slate-200">
          <label className="block text-xs text-slate-600">Motivo para dar por liquidado (queda registrado)
            <textarea value={manualReason} onChange={e => setManualReason(e.target.value)} maxLength={500} rows={2} placeholder="Ej.: el cliente confirmó la recepción por correo; la guía física llega el lunes" className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
            <span className="mt-1 block text-slate-500">Mínimo 10 caracteres. Falta: {checklist.missing.map(m => MISSING_LABEL[m] || m).join(' · ')}.</span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={() => { setManualOpen(false); setManualReason('') }} className="min-h-9 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-slate-700">Cancelar</button>
            <button type="button" onClick={() => void settleManually()} disabled={manualReason.trim().length < 10 || !!busy} className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-emerald-700 px-3 text-xs font-semibold text-white disabled:opacity-40">{busy === 'manual' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Confirmar liquidación</button>
          </div>
        </div>
      : <div className="flex justify-end"><button type="button" onClick={() => setManualOpen(true)} className="inline-flex min-h-9 items-center gap-2 rounded-lg border border-emerald-600 bg-white px-3 text-xs font-semibold text-emerald-800 hover:bg-emerald-50"><CheckCircle2 className="h-4 w-4" />Dar por liquidado</button></div>)}
    {canUpload && checklist?.kind !== 'RECHAZO' && <div className={`grid gap-3 ${rule.packingAllowed ? 'lg:grid-cols-2' : ''}`}>
      {spec && active ? <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-1" role="radiogroup" aria-label="Documento con número">
          {options.map(k => <button key={k} type="button" role="radio" aria-checked={active === k} onClick={() => { setKind(k); setNumber(''); setDocFiles([]) }}
            className={`min-h-9 rounded-md px-2.5 text-xs font-semibold ${active === k ? 'bg-[#002855] text-white' : 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50'}`}>{NUMBERED[k].label}</button>)}
        </div>
        <label className="block text-xs text-slate-600">1. Número de {spec.label}{tag(requiredFor(checklist?.kind || 'ENTREGA', active))}
          <input value={number} onChange={e => setNumber(e.target.value.toUpperCase().replace(/\s+/g, ''))} maxLength={30} placeholder={spec.example} autoCapitalize="characters" spellCheck={false}
            aria-invalid={!!number && !valid} className={`mt-1 min-h-11 w-full rounded-lg border bg-white px-3 font-mono text-sm lg:min-h-9 ${number && !valid ? 'border-red-400' : valid ? 'border-emerald-500' : 'border-slate-300'}`} />
          <span className={`mt-1 block ${number && !valid ? 'text-red-700' : 'text-slate-500'}`}>{number && !valid ? spec.hint : valid ? 'Número válido: ya puede cargar el archivo.' : 'Ingrese el número para activar la carga.'}</span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label aria-disabled={!valid} className={`${fileButton} ${!valid ? 'pointer-events-none opacity-40' : ''}`}><Upload className="h-4 w-4" />2. Elegir archivo{active === 'GUIA' ? ' (foto o PDF)' : ''}<input type="file" multiple disabled={!valid || !!busy} accept={active === 'GUIA' ? GUIDE_ACCEPT : PACKING_ACCEPT} className="sr-only" onChange={pick(setDocFiles)} /></label>
          <button type="button" onClick={() => void submitDoc()} disabled={!valid || !docFiles.length || !!busy} className={primary}>{busy === 'doc' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Cargar {active === 'GUIA' ? 'GR' : spec.label}</button>
        </div>
        {chosen(docFiles, () => setDocFiles([]))}
      </div> : <p className="text-xs text-slate-600">{guideNote || 'Sin documentos con número pendientes.'}</p>}
      {rule.packingAllowed && <div className="min-w-0 space-y-2">
        <p className="text-xs font-semibold text-slate-700">Packing List{tag(rule.packingRequired)}</p>
        <p className="text-xs text-slate-500">Sin correlativo: PDF, foto o Excel, hasta 5 archivos.</p>
        <div className="flex flex-wrap items-center gap-2">
          <label className={fileButton}><Upload className="h-4 w-4" />Elegir Packing List<input type="file" multiple disabled={!!busy} accept={PACKING_ACCEPT} className="sr-only" onChange={pick(setPackingFiles)} /></label>
          <button type="button" onClick={() => void submitPacking()} disabled={!packingFiles.length || !!busy} className={primary}>{busy === 'packing' ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Cargar Packing List</button>
        </div>
        {chosen(packingFiles, () => setPackingFiles([]))}
      </div>}
    </div>}
    <p className="text-[11px] text-slate-500">La liquidación es automática: el servicio sale de «Liquidación pendiente» al completar los obligatorios. La GR cuenta cuando el Supervisor de Transporte la aprueba en Conformidad.{canManual ? ' También puedes darlo por liquidado con un motivo.' : ''}</p>
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
  // Una fila por archivo: tipo, nombre (abre el archivo), detalle y anular
  return (
    <>
    <GuiaDetalleModal key={guia || 'none'} guias={guia} onClose={() => setGuia(null)} />
    <ul className="mt-1 divide-y divide-slate-100">
      {docs.map(d => (
        <li key={d.id} className="flex min-w-0 items-center gap-2 py-1 text-xs">
          <KindTag kind={fileKind(d.file_name || d.file_path, d.mime_type)} />
          <div className="min-w-0 flex-1">
            <button type="button" onClick={() => onOpen(d.file_path)} title="Abrir archivo" className="flex min-h-11 w-full min-w-0 flex-col justify-center text-left lg:min-h-9">
              <span className="truncate font-semibold text-blue-800 hover:underline">{d.file_name || 'Archivo adjunto'}</span>
              <span className="truncate text-[11px] text-slate-500">{DOC_LABEL[d.doc_type] || 'Documento'}{d.document_number ? ` ${d.document_number}` : ''}{d.cargo_type ? ` · ${CARGO_LABEL[d.cargo_type] || d.cargo_type}` : ''}{d.doc_type === 'PACKING_LIST' ? d.signed ? ` · Firmado por ${d.auditor_name} · ${fmtDate(d.auditor_signed_date || null)}` : ' · Firma pendiente' : ''}</span>
            </button>
          </div>
          {d.doc_type === 'GUIA_REMISION' && d.document_number && (
            <button type="button" onClick={() => setGuia(d.document_number)} title="Ver los SKUs de la guía (SALIDA del ERP)"
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2 text-[11px] font-semibold text-blue-700 hover:bg-blue-50 lg:min-h-9">
              <ListTree className="h-3.5 w-3.5" /> SKUs
            </button>
          )}
          {canEdit && <button type="button" onClick={() => onVoid(d)} aria-label={`Anular ${d.file_name || DOC_LABEL[d.doc_type] || 'documento'}`} title="Anular documento" className="grid h-11 w-11 shrink-0 place-items-center rounded-lg text-red-700 hover:bg-red-50 lg:h-9 lg:w-9"><Trash2 className="h-4 w-4" /></button>}
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
  const [files, setFiles] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [inputKey, setInputKey] = useState(0)
  const needsNumber = docType === 'GUIA_REMISION' || docType === 'NOTA_DESPACHO'
  const allowSheet = docType === 'OTRO'
  const packing = docType === 'PACKING_LIST'

  const multiple = allowSheet
  const mimeOf = (file: File) => packing ? packingMime(file) : allowSheet ? (isSheetName(file.name) ? sheetMime(file.name) : packingMime(file)) : 'application/pdf'

  const uploadOne = async (file: File, userId: string) => {
    const mime = mimeOf(file) as string
    const path = `${dispatchId}/${packing ? `packing/${userId}/` : ''}${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`
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
  }

  const submit = async () => {
    if (saving) return
    if (!files.length || files.some(f => !f.size)) { toast.error('Seleccione archivos que no estén vacíos'); return }
    const big = files.find(f => f.size > 15 * 1024 * 1024)
    if (big) { toast.error(`${big.name} supera 15 MB`); return }
    if (packing && (!auditor.trim() || !signedDate || !signature)) { toast.error('Indique auditor, fecha y confirme que el Packing List contiene su firma'); return }
    if (needsNumber && !number.trim()) { toast.error('Indique la serie y número'); return }
    const invalid = files.find(f => !packing && !allowSheet && !(f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) || !mimeOf(f))
    if (invalid) { toast.error(allowSheet ? `${invalid.name}: cargue PDF, imagen JPG/PNG/WEBP o Excel` : packing ? 'Seleccione PDF, foto JPG/PNG/WEBP o Excel XLS/XLSX' : 'La Nota de Despacho se carga en PDF'); return }
    setSaving(true)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) throw new Error('Tu sesión venció. Ingresa nuevamente para cargar el documento.')
      const failed: File[] = []
      for (const file of files) {
        try { await uploadOne(file, user.id) } catch (e) { failed.push(file); toast.error(`${file.name}: ${errorMessage(e)}`) }
      }
      const done = files.length - failed.length
      if (done) toast.success(files.length > 1 ? `${done} de ${files.length} archivos cargados` : `${DOC_LABEL[docType]} cargado`)
      // Los archivos que fallaron quedan seleccionados para reintentar
      setFiles(failed); setInputKey(k => k + 1)
      if (!failed.length) { setNumber(''); setSignature(false) }
      if (done) await onUploaded()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(false) }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
      {packing && <div className="grid w-full gap-3 sm:grid-cols-2"><label className="text-xs text-slate-600">Auditor firmante *<input value={auditor} maxLength={120} onChange={e => setAuditor(e.target.value)} placeholder="Nombre y apellido del Auditor de Despacho" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="text-xs text-slate-600">Fecha de firma *<input type="date" value={signedDate} max={today} onChange={e => setSignedDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="flex items-start gap-2 text-xs leading-5 text-slate-600 sm:col-span-2"><input type="checkbox" checked={signature} onChange={e => setSignature(e.target.checked)} className="mt-1" />Confirmo que el archivo adjunto es legible y contiene la firma del auditor de despacho. Se acepta PDF, foto o Excel (XLS/XLSX) del Packing List firmado.</label></div>}
      {!packing && <label className="text-xs text-slate-600">Número {needsNumber ? '*' : '(opcional)'}<input value={number} onChange={e => setNumber(e.target.value)} placeholder={needsNumber ? 'T001-000123' : 'Número del documento'}
        className="mt-1 min-h-11 w-full max-w-48 border border-slate-300 rounded-lg px-3 text-sm" /></label>}
      <label className="block w-full min-w-0 text-xs text-slate-600 sm:flex-1">{multiple ? 'Archivos · PDF, imagen o Excel · máximo 15 MB cada uno' : 'Archivo · máximo 15 MB'}<input disabled={saving} key={inputKey} type="file" multiple={multiple} accept={packing ? PACKING_ACCEPT : allowSheet ? OTHER_ACCEPT : '.pdf'}
        onChange={e => { const picked = Array.from(e.target.files || []); setFiles(multiple ? prev => [...prev, ...picked.filter(p => !prev.some(f => f.name === p.name && f.size === p.size))] : picked.slice(0, 1)); setInputKey(k => k + 1) }}
        className="mt-2 block min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-slate-50 text-xs file:mr-3 file:min-h-11 file:border-0 file:bg-slate-200 file:px-3 file:font-semibold file:text-[#002855]" /></label>
      <button onClick={submit} disabled={saving}
        className="min-h-11 px-3 rounded-lg bg-[#002855] text-white font-semibold disabled:opacity-50 flex items-center gap-1.5">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}{saving ? 'Cargando…' : files.length > 1 ? `Subir ${files.length} archivos` : 'Subir archivo'}
      </button>
      {!!files.length && (
        <ul className="w-full space-y-1.5" aria-label="Archivos seleccionados">
          {files.map((f, i) => (
            <li key={`${f.name}|${f.size}|${i}`} className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs">
              <KindTag kind={fileKind(f.name, f.type)} />
              <span className="min-w-0 flex-1 truncate text-slate-700" title={f.name}>{f.name}</span>
              <span className="shrink-0 tabular-nums text-slate-400">{(f.size / 1024 / 1024).toFixed(2)} MB</span>
              <button type="button" disabled={saving} onClick={() => setFiles(prev => prev.filter((_, j) => j !== i))} aria-label={`Quitar ${f.name}`}
                className="inline-flex min-h-8 items-center rounded px-1.5 text-slate-500 hover:bg-slate-200 hover:text-red-700 disabled:opacity-40"><Trash2 className="h-3.5 w-3.5" /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
