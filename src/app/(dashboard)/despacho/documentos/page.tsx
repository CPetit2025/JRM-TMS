'use client'
import Link from 'next/link'
import { forkliftScopeLabel } from '@/lib/forklift-stop'
import { TransportWorkflow, TorreControlButton } from '@/components/transport/TransportWorkflow'
import { DataTable } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { InlineStatusBar } from '@/components/ui/inline-status-bar'
import { FilterToolbar, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowRight, BadgeCheck, CalendarDays, ClipboardList, MapPin, CheckCircle2, ChevronRight, Clock, History, Info, Layers, FileCheck2, FileImage, FileSpreadsheet, FileText, Link2, ListTree, Loader2, RefreshCw, Save, Search, Trash2, Truck, Upload, User as UserIcon } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Modal } from '@/components/ui/modal'
import { GuiaDetalleModal } from '@/components/guias/GuiaDetalleModal'
import { ErpGuiasValidacion, ErpOtReferencia } from '@/components/erp/ErpReferencia'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { DeliveryReview, type DeliveryReviewTarget } from '@/components/delivery/DeliveryReview'
import { documentPhaseMatches, type DocumentPhase } from '@/lib/document-flow'
import { conformityLabels, documentNumberLabel, type DeliveryRow } from '@/lib/delivery'
import { PACKING_ACCEPT, packingMime } from '@/lib/packing-list'
import { DOCS_BUCKET, errorMessage, fmtDate, receiptUrl } from '@/lib/caja'
import { districtOf } from '@/lib/address'
import { DocumentNumberLinks } from '@/components/despacho/DocumentNumberLinks'
import { referenceLabel } from '@/lib/suppliers'
import { cellDateTime, fullDateTime } from '@/lib/table-format'
import { fetchServiceTypes, serviceKind, type ServiceKind } from '@/lib/request-service'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { DocumentaryBadge, type DocumentaryClosure } from '@/components/despacho/DocumentaryClosure'
import { dispatchStatusLabel } from '@/lib/dispatch-status'
import { GuidesClosureTab, NOT_SETTLEABLE, knownNumbers, settlementKind } from '@/components/documentos/GuidesClosureTab'
import { CostHistoryModal, FILE_CATEGORY, FilesSection, LiquidationDetail, MAX_FILE_MB, MAX_FILES, OtFilesModal, PendingDot, ServicesOverview, useEconomicDetail, useModalContext, type FileRow, type GuideRow } from '@/components/documentos/DispatchModalSections'

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
  // Dirección anterior de la liquidación de un viaje: ahora se trabaja en Torre de Control; la bandeja sigue como lista
  const router = useRouter()
  useEffect(() => { if (requestedPhase === 'liquidacion' && dispatchParam && /^[0-9a-f-]{36}$/i.test(dispatchParam)) router.replace(`/torre-control?despacho=${dispatchParam}&liquidar=documentaria`) }, [requestedPhase, dispatchParam, router])
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
  // Documentación pendiente: estado documentario por servicio según su tipo (regla de la base)
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
      // Documentación pendiente: la base filtra rutas con cierre operativo y documentación incompleta
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
  // Lista de liquidación de la ruta abierta (en cualquier pestaña; «Documentación pendiente» ya la trae para toda la bandeja)
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
      toast.success(`Documentos de ${item.dispatch_number} registrados como preparados`)
      await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(null) }
  }

  // Anulación con causa de lista cerrada (KPI de documentos anulados por error, migración 20261005180000)
  const voidDoc = (doc: Doc) => setAnulando(doc)

  return (
    <div className="min-w-0 space-y-2.5">
      <PageHeader showTitle title="Documentos de Despacho" description="Salida y conformidad en un único espacio · documentos por servicio, parada y OT."
        actions={<><button onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button><Link href="/despacho/documentos/economico" className="flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cierre económico</Link><TorreControlButton /></>} />
      <p role="note" className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-[#002855]"><b>Nuevo proceso:</b> el conductor carga el Packing List y la guía de remisión desde el app o el enlace de entrega. La salida a ruta ya no depende de la confirmación documentaria; esta bandeja queda como consulta y para documentos opcionales.</p>
      <div className="flex flex-wrap items-center gap-2">
        <TransportWorkflow current="documentos" torre={false} />
        {phase === 'salida' && <div className="ml-auto min-w-0"><InlineStatusBar label="Resumen documentario (filtra la tabla)" active={filter} loading={items === null} onChange={k => setFilter(k as typeof filter)}
          items={[{ key: 'TODOS', label: 'Todos', count: counts.PENDIENTE + counts.REEMISION + counts.LISTO, icon: <Layers />, tone: 'navy' }, { key: 'PENDIENTE', label: 'Pendientes', count: counts.PENDIENTE, icon: <Clock />, tone: 'amber' },
            { key: 'REEMISION', label: 'Reemisión', count: counts.REEMISION, icon: <AlertTriangle />, tone: 'rose' }, { key: 'LISTO', label: 'Listos', count: counts.LISTO, icon: <CheckCircle2 />, tone: 'emerald' }]} /></div>}
      </div>

      <FilterToolbar compact label="Etapa, búsqueda y período">
        <div role="tablist" aria-label="Etapas documentarias" className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {([['salida', packingOnly ? 'Planificación · Packing List' : 'Previos a salida'], ...(!packingOnly ? [['liquidacion', 'Documentación pendiente'], ['conformidad', 'Conformidad'], ['observados', 'Observados / reemisión'], ['historial', 'Historial']] : [['historial', 'Historial de Packing List']])] as [DocumentPhase, string][]).map(([value, title]) => <button key={value} type="button" role="tab" aria-selected={phase === value} onClick={() => { setPhaseChoice(value); setFilter('TODOS') }} className={`min-h-11 rounded-md px-3 text-sm font-semibold lg:min-h-9 ${phase === value ? 'bg-white text-jrm-navy shadow-sm' : 'text-slate-600 hover:text-jrm-navy'}`}>{title}</button>)}
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
        : !visible.length ? <p className="text-slate-500 text-sm p-6 text-center border border-slate-200 rounded-xl bg-white">{queueError && !items ? 'La bandeja no está disponible.' : phase === 'salida' && !packingOnly ? 'No hay servicios por salir. Los servicios ya cerrados con documentación pendiente están en «Documentación pendiente».' : phase === 'liquidacion' ? 'No hay servicios cerrados con documentación pendiente.' : 'No hay solicitudes para estos filtros.'}</p>
        : <section aria-label="Control documentario por OT" className="overflow-hidden rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card">
          <div className="overflow-x-auto"><DataTable dense className="block w-full text-left text-sm lg:table"><caption className="sr-only">Solicitudes y OT asociadas, Packing List, guía de entrega y conformidad</caption><thead className="hidden bg-slate-50 text-xs text-slate-500 lg:table-header-group"><tr>{['Salida', 'Servicio', 'OT / OC / OS / RQ', 'Placa', 'Empresa', 'Destino', 'GR / Nota', 'Estado', 'Acciones'].map((label, i) => <th key={label} scope="col" className={`whitespace-nowrap px-3 py-2.5 font-semibold ${i === 8 ? 'text-right' : ''}`}>{label}</th>)}</tr></thead><tbody className="block divide-y divide-slate-200 lg:table-row-group">{visible.map(({ item, stop }) => <DocumentRow key={`${item.id}/${stop?.request_id || 'empty'}`} item={item} stop={stop} kind={stop && serviceTypes.has(stop.request_id) ? serviceKind(serviceTypes.get(stop.request_id)) : item.is_pickup ? 'RECOJO_CLIENTE' : null} info={stop ? serviceTypes.get(stop.request_id) : undefined} delivery={deliveries.find(row => row.dispatch_id === item.id && row.request_id === stop?.request_id)} canEdit={canNumbers || canPacking} packingOnly={packingOnly} onManage={() => openService(item.id, stop?.request_id || null)} onStatus={() => setStatusOf({ item, stop, delivery: deliveries.find(row => row.dispatch_id === item.id && row.request_id === stop?.request_id) })} />)}</tbody></DataTable></div>
        </section>}
      <Modal isOpen={!!selected} onClose={() => setSelectedId(null)} title={`Documentos · ${selected?.dispatch_number || ''}${focused && selected?.stops[0] ? ` · ${selected.stops[0].ot_code ? `OT ${selected.stops[0].ot_code}` : referenceLabel(serviceTypes.get(selected.stops[0].request_id)) || selected.stops[0].request_number}` : ''}`} maxWidth="max-w-[1440px]"
>
        {selectedRoute && phase !== 'salida' && selectedRoute.stops.length > 1 && focusStop && <p className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-[#002855]">
          <span>{focused ? <>Liquidación por servicio: se muestra <b>1 de {selectedRoute.stops.length}</b> servicios de la ruta {selectedRoute.dispatch_number}.</> : <>Ruta {selectedRoute.dispatch_number} completa · {selectedRoute.stops.length} servicios.</>}</span>
          <button type="button" onClick={() => setShowAllStops(v => !v)} className="min-h-9 rounded-lg border border-blue-300 bg-white px-3 font-semibold hover:bg-blue-100">{focused ? `Ver los ${selectedRoute.stops.length} servicios` : 'Ver solo este servicio'}</button>
        </p>}
        {selected && <DispatchCard key={selected.id} item={selected} onClose={() => setSelectedId(null)} footerConfirm={selected && canEdit && selected.status === 'PROGRAMADO' && ['PENDIENTE', 'REEMISION'].includes(selected.doc_status) && <button type="button" onClick={() => void confirmDocs(selected)} disabled={busy === selected.id || !!selected.missing} className="flex min-h-11 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500">{busy === selected.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Marcar documentos preparados</button>} canEdit={canEdit && selected.status === 'PROGRAMADO'} canPacking={canPacking && selected.status === 'PROGRAMADO'} canAttach={canEdit && selected.status !== 'CANCELADO'} canSettle={(canNumbers || canManual) && !packingOnly && !NOT_SETTLEABLE.includes(selected.status)} canUpload={canNumbers} canManual={canManual} checklists={checklists} packingOnly={packingOnly} serviceTypes={serviceTypes}
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

/** El recojo del cliente tiene su Nota de Despacho (archivo o número vinculado). */
function noteLinked(item: QueueItem, stop: Stop | null) {
  return item.documents.some(doc => doc.doc_type === 'NOTA_DESPACHO' && doc.request_id === stop?.request_id)
    || !!item.number_references?.some(ref => ref.doc_type === 'NOTA_DESPACHO' && ref.request_id === stop?.request_id)
}

/** Guías de remisión del servicio: guía de entrega, archivos de Documentos y números vinculados. */
function stopGuides(item: QueueItem, stop: Stop | null, delivery: DeliveryRow | undefined) {
  const own = item.documents.filter(doc => doc.request_id === stop?.request_id && doc.document_number)
  const refs = (item.number_references || []).filter(ref => ref.request_id === stop?.request_id)
  const guides = [...new Set([delivery?.guide_number, ...own.filter(doc => doc.doc_type === 'GUIA_REMISION').map(doc => doc.document_number), ...refs.filter(ref => ref.doc_type === 'GUIA_REMISION').map(ref => ref.document_number)].filter(Boolean))]
  return guides as string[]
}

/** GR (guía de entrega o registrada por Documentos) y Nota de Despacho del servicio. */
function stopNumbers(item: QueueItem, stop: Stop | null, delivery: DeliveryRow | undefined) {
  const own = item.documents.filter(doc => doc.request_id === stop?.request_id && doc.document_number)
  const refs = (item.number_references || []).filter(ref => ref.request_id === stop?.request_id)
  const guides = stopGuides(item, stop, delivery)
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
      {/* Referencia del ERP (solo lectura): las guías del servicio frente al Actualizable y la OT */}
      <ErpGuiasValidacion guias={stopGuides(item, stop, delivery)} ot={stop?.ot_code} />
      {stop?.ot_code && <ErpOtReferencia ot={stop.ot_code} compact />}
    </div>
  </Modal>
}

function DispatchCard({ item, onClose, footerConfirm, canEdit, canPacking, canAttach = false, canSettle = false, canUpload = false, canManual = false, checklists, packingOnly, serviceTypes, onVoid, onOpen, onUploaded, deliveries, onEvidence, children }: {
  item: QueueItem; onClose: () => void; footerConfirm?: React.ReactNode; canEdit: boolean; canPacking: boolean; canAttach?: boolean; canSettle?: boolean; canUpload?: boolean; canManual?: boolean; checklists?: Map<string, SettlementChecklist>; packingOnly: boolean; serviceTypes: Awaited<ReturnType<typeof fetchServiceTypes>>; onVoid: (d: Doc) => void
  onOpen: (p: string) => void; onUploaded: () => Promise<void>; deliveries: DeliveryRow[]; onEvidence: (row: DeliveryReviewTarget) => void; children?: React.ReactNode
}) {
  const [upload, setUpload] = useState<{ requestId: string | null; type: string; label: string } | null>(null)
  const [tab, setTab] = useState<'servicios' | 'guias' | 'archivos' | 'liquidacion'>('servicios')
  const [category, setCategory] = useState('COMPROBANTE')
  const [staged, setStaged] = useState<File[]>([])
  const [saving, setSaving] = useState(false)
  const [history, setHistory] = useState(false)
  const [linking, setLinking] = useState(false)
  const [otFiles, setOtFiles] = useState(false)
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
  const uploadForm = (requestId: string | null) => upload && upload.requestId === requestId && (canPacking || canEdit || (canAttach && upload.type === 'OTRO')) && <div ref={uploadPanel} className="scroll-m-4 border-t border-blue-200 bg-blue-50/40 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="text-sm font-bold text-[#002855]">{DOC_LABEL[upload.type]} · {upload.label}</h4><p className="mt-0.5 text-xs text-slate-500">{upload.requestId ? 'El archivo se vincula únicamente a esta solicitud.' : 'Este archivo cubre todas las solicitudes y OT del despacho.'}</p></div><button type="button" onClick={() => setUpload(null)} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 lg:min-h-9">Cancelar</button></div><UploadForm key={`${upload.requestId}/${upload.type}`} dispatchId={item.id} requestId={upload.requestId} isPickup={item.is_pickup} canPacking={canPacking} canDocuments={canEdit || canAttach} documentType={upload.type} category={upload.type === 'OTRO' && tab === 'archivos' ? category : null} onUploaded={async () => { await onUploaded(); setUpload(null) }} /></div>
  // Contexto que la bandeja no trae (retorno, quién subió, tamaño, categoría) y costos de solo consulta (misma fuente que el Cierre económico)
  const ctx = useModalContext(item.id, item.documents.length)
  const economic = useEconomicDetail(item.id, !packingOnly)
  const docMeta = new Map((ctx?.documents || []).map(d => [d.id, d]))
  const stopLabel = (requestId: string | null) => {
    const s = item.stops.find(x => x.request_id === requestId)
    return s ? { ot: s.ot_code ? `OT ${s.ot_code}` : referenceLabel(serviceTypes.get(s.request_id)) || 'Sin referencia', request: s.request_number } : { ot: 'Toda la ruta', request: item.stops.length ? `${item.stops.length} servicio(s)` : '—' }
  }
  // Guías y notas de la ruta en una tabla: guía del conductor (con su conformidad), números vinculados y archivos, sin repetir números
  const guideRows: GuideRow[] = []
  if (!packingOnly) for (const s of item.stops) {
    const label = stopLabel(s.request_id)
    const rows: GuideRow[] = []
    const add = (row: Omit<GuideRow, 'ot' | 'request'>) => {
      const same = row.number ? rows.find(r => r.type === row.type && r.number?.toUpperCase() === row.number?.toUpperCase()) : undefined
      if (same) { same.file = same.file || row.file; same.date = same.date || row.date; return }
      rows.push({ ...row, ...label })
    }
    const delivery = deliveries.find(d => d.request_id === s.request_id)
    if (delivery?.guide_number) add({ key: `${s.request_id}/gr-app`, type: 'Guía de Remisión', number: delivery.guide_number, date: delivery.submitted_at,
      status: delivery.conformity === 'VALIDADA' ? 'VALIDADA' : ['OBSERVADA', 'RECHAZADA'].includes(delivery.conformity) ? 'OBSERVADA' : 'POR_VALIDAR', onReview: () => onEvidence(delivery) })
    for (const d of item.documents.filter(x => x.request_id === s.request_id && ['GUIA_REMISION', 'NOTA_DESPACHO'].includes(x.doc_type)))
      add({ key: d.id, type: d.doc_type === 'GUIA_REMISION' ? 'Guía de Remisión' : 'Nota de Despacho', number: d.document_number, date: d.uploaded_at, status: 'REGISTRADA', file: { path: d.file_path, name: d.file_name || 'Archivo' } })
    for (const n of (item.number_references || []).filter(x => x.request_id === s.request_id))
      add({ key: `${s.request_id}/${n.doc_type}/${n.document_number}`, type: n.doc_type === 'GUIA_REMISION' ? 'Guía de Remisión' : 'Nota de Despacho', number: n.document_number, date: null, status: 'REGISTRADA' })
    const kind = checklists?.get(`${item.id}/${s.request_id}`)?.kind || settlementKind(serviceTypes.get(s.request_id), item.is_pickup)
    const hasNote = rows.some(r => r.type === 'Nota de Despacho'), grOk = rows.some(r => r.type === 'Guía de Remisión' && r.status === 'VALIDADA')
    const grPending = rows.some(r => r.type === 'Guía de Remisión' && r.status !== 'VALIDADA')
    const missing = kind === 'ENTREGA' && !grOk && !hasNote && !grPending ? 'Guía de Remisión o Nota de Despacho'
      : kind === 'RECOJO' && !grOk && !grPending ? 'Guía de Remisión' : kind === 'RECOJO_CLIENTE' && !hasNote ? 'Nota de Despacho' : null
    if (missing && item.status !== 'PROGRAMADO' && item.status !== 'CANCELADO') rows.push({ key: `${s.request_id}/falta`, ...label, type: missing, number: null, date: null, status: 'FALTA', onReview: delivery ? () => onEvidence(delivery) : undefined })
    guideRows.push(...rows)
  }
  const missingGuides = guideRows.filter(r => r.status === 'FALTA' || r.status === 'POR_VALIDAR').length
  const settlementPending = item.stops.filter(s => checklists?.get(`${item.id}/${s.request_id}`)?.complete === false).length
  const guideCount = guideRows.filter(r => r.status !== 'FALTA').length
  const tabs: [typeof tab, string, number | null, boolean][] = [['servicios', 'Servicios', item.stops.length, false],
    ...(!packingOnly ? [['guias', 'Guías y notas', guideCount, missingGuides > 0 || settlementPending > 0], ['liquidacion', 'Cierre del servicio', null, !!economic?.state.pending.length || settlementPending > 0]] as [typeof tab, string, number | null, boolean][] : []),
    ['archivos', 'Archivos', item.documents.length, false]]
  const TAB_ICON = { servicios: FileText, guias: FileText, liquidacion: BadgeCheck, archivos: ClipboardList } as const
  const firstStop = item.stops[0], lastStop = item.stops[item.stops.length - 1]
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const current = tabs.findIndex(([value]) => value === tab)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length
    setTab(tabs[next][0])
    document.getElementById(`dispatch-doc-tab-${tabs[next][0]}`)?.focus()
  }

  // Archivos: carga por arrastre o selección (Otro documento con categoría), máximo 5 archivos de 10 MB por carga
  const canFiles = canEdit || canAttach
  const stage = (picked: File[]) => {
    const ok = picked.filter(f => /\.(pdf|jpe?g|png|webp|xlsx?|csv)$/i.test(f.name))
    if (ok.length < picked.length) toast.error('Solo PDF, imagen JPG/PNG/WEBP o Excel')
    const big = ok.find(f => f.size > MAX_FILE_MB * 1024 * 1024)
    if (big) { toast.error(`${big.name} supera ${MAX_FILE_MB} MB`); return }
    setStaged(prev => {
      const next = [...prev, ...ok.filter(f => !prev.some(p => p.name === f.name && p.size === f.size))]
      if (next.length > MAX_FILES) toast.error(`Hasta ${MAX_FILES} archivos por carga`)
      return next.slice(0, MAX_FILES)
    })
  }
  const saveFiles = async () => {
    if (!staged.length) return
    setSaving(true)
    const supabase = createClient()
    const failed: File[] = []
    for (const file of staged) {
      try {
        const mime = isSheetName(file.name) ? sheetMime(file.name) : packingMime(file)
        if (!mime) throw new Error('formato no permitido')
        const path = `${item.id}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`
        const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { contentType: mime })
        if (upErr) throw upErr
        const { data, error } = await supabase.rpc('register_dispatch_document', { p_dispatch_id: item.id, p_request_id: null, p_doc_type: 'OTRO', p_cargo_type: null,
          p_document_number: null, p_file_path: path, p_file_name: file.name, p_mime_type: mime, p_size_bytes: file.size, p_notes: null })
        if (error || !data?.success) { await supabase.storage.from(DOCS_BUCKET).remove([path]); throw new Error(error ? errorMessage(error) : data?.error) }
        if (data.id) await supabase.rpc('set_dispatch_document_category', { p_document_id: data.id, p_category: category })
      } catch (e) { failed.push(file); toast.error(`${file.name}: ${errorMessage(e)}`) }
    }
    const done = staged.length - failed.length
    if (done) { toast.success(`${done} archivo(s) guardado(s)`); await onUploaded() }
    setStaged(failed); setSaving(false)
  }
  const fileRows: FileRow[] = [
    ...item.documents.map(d => {
      const meta = docMeta.get(d.id)
      return { key: d.id, name: d.file_name || 'Archivo adjunto', type: (d.file_name || d.file_path).split('.').pop()?.toUpperCase().slice(0, 5) || '—',
        category: d.doc_type === 'OTRO' ? FILE_CATEGORY[meta?.category || 'OTROS'] : `${DOC_LABEL[d.doc_type]}${d.document_number ? ` ${d.document_number}` : ''}`,
        where: item.stops.length > 1 ? (d.request_id ? `${stopLabel(d.request_id).ot} · ${stopLabel(d.request_id).request}` : 'Toda la ruta') : null,
        size: meta?.size_bytes ?? null, date: d.uploaded_at, by: meta?.uploaded_by_name ?? null, onOpen: () => onOpen(d.file_path), onVoid: canEdit ? () => onVoid(d) : undefined }
    }),
    ...deliveries.filter(dl => dl.photos_count > 0).map(dl => ({ key: `ev-${dl.request_id}`, name: `Evidencias de entrega (${dl.photos_count} foto${dl.photos_count === 1 ? '' : 's'})`,
      type: 'Evidencia', category: `App del conductor · ${conformityLabels[dl.conformity]}`, where: item.stops.length > 1 ? `${stopLabel(dl.request_id).ot} · ${stopLabel(dl.request_id).request}` : null,
      size: null, date: dl.submitted_at, by: dl.driver_name, onOpen: () => onEvidence(dl) })),
  ]
  const operative = ['LIQUIDADO', 'CERRADO', 'CIERRE_OPERATIVO', 'RETORNO_COMPLETADO', 'ENTREGADO'].includes(item.status) ? { label: 'Ruta finalizada', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' }
    : item.status === 'PROGRAMADO' ? { label: 'Ruta programada', cls: 'bg-blue-50 text-blue-700 ring-blue-200' }
    : item.status === 'CANCELADO' ? { label: 'Ruta cancelada', cls: 'bg-red-50 text-red-700 ring-red-200' } : { label: 'Ruta en curso', cls: 'bg-amber-50 text-amber-700 ring-amber-200' }
  const btn = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold'

  return <div className="min-w-0 space-y-5">
    {/* Cabecera y pestañas fijas: el contenido se desplaza debajo */}
    <div className="sticky -top-4 z-20 -mx-4 -mt-4 space-y-3 bg-white px-4 pb-3 pt-4 sm:-top-6 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-5">
      <dl className="flex flex-wrap items-center gap-x-10 gap-y-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5">
        <div className="flex items-center gap-3"><Truck aria-hidden className="h-6 w-6 text-[#002855]" /><div><dt className="sr-only">Unidad</dt>
          <dd className="text-sm font-bold text-slate-900">{item.is_pickup ? 'Unidad del cliente' : item.vehicle_plate || 'Sin unidad'}</dd>
          <dd className="text-xs text-slate-500">{item.is_pickup ? 'Recojo por el cliente' : item.modalidad === 'TERCERO' ? 'Transporte contratado por JRM' : 'Transporte JRM'}</dd></div></div>
        <div className="flex items-center gap-3"><UserIcon aria-hidden className="h-6 w-6 text-[#002855]" /><div><dt className="text-xs text-slate-500">Conductor</dt>
          <dd className="text-sm font-bold uppercase text-slate-900">{item.is_pickup ? 'No aplica' : item.driver_name || 'Sin conductor registrado'}</dd></div></div>
        <div className="flex items-center gap-3"><CalendarDays aria-hidden className="h-6 w-6 text-[#002855]" /><div><dt className="text-xs text-slate-500">Salida</dt>
          <dd className={`text-sm font-bold ${urgent ? 'text-red-700' : 'text-slate-900'}`}>{fmtDate(item.scheduled_departure, true)}{urgent && <span className="ml-1 text-xs font-medium">· {h !== null && h < 0 ? 'atrasada' : 'próxima'}</span>}</dd></div></div>
        {ctx?.returned_at && <div className="flex items-center gap-3"><CalendarDays aria-hidden className="h-6 w-6 text-[#002855]" /><div><dt className="text-xs text-slate-500">Retorno</dt>
          <dd className="text-sm font-bold text-slate-900">{fmtDate(ctx.returned_at, true)}</dd></div></div>}
        {firstStop && <div className="flex items-center gap-3"><MapPin aria-hidden className="h-6 w-6 text-[#002855]" /><div><dt className="text-xs text-slate-500">Origen</dt>
          <dd className="max-w-40 truncate text-sm font-bold text-slate-900" title={firstStop.origin || undefined}>{firstStop.origin ? districtOf(firstStop.origin) : '—'}</dd></div></div>}
        {firstStop && <ArrowRight aria-hidden className="h-6 w-6 text-slate-700" />}
        {lastStop && <div className="flex items-center gap-3"><MapPin aria-hidden className="h-6 w-6 text-[#002855]" /><div><dt className="text-xs text-slate-500">Destino</dt>
          <dd className="max-w-40 truncate text-sm font-bold text-slate-900" title={lastStop.delivery || undefined}>{lastStop.delivery ? districtOf(lastStop.delivery) : '—'}{item.stops.length > 1 ? ` (+${item.stops.length - 1})` : ''}</dd></div></div>}
        <div className="sm:ml-auto"><dt className="sr-only">Estado de la ruta</dt><dd title={`${dispatchStatusLabel(item.status)} · ${badge.label}`} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-inset ${operative.cls}`}><CheckCircle2 className="h-4 w-4" />{operative.label}</dd></div>
      </dl>
      {item.docs_reissue && <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs leading-5 text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Reemisión: {item.docs_reissue_reason || 'Actualizar los documentos del servicio.'}</p>}
      <div role="tablist" aria-label="Secciones de documentos del despacho" className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-50 p-1.5">
        {tabs.map(([value, label, count, alert]) => { const Icon = TAB_ICON[value]; return <button key={value} id={`dispatch-doc-tab-${value}`} type="button" role="tab" aria-selected={tab === value} aria-controls={`dispatch-doc-panel-${value}`} tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)} onKeyDown={onTabKeyDown}
          className={`inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-lg px-5 text-sm font-semibold transition-colors ${tab === value ? 'bg-blue-600 text-white shadow-sm' : 'text-slate-700 hover:bg-white hover:text-[#002855]'}`}>
          <Icon className="h-5 w-5" aria-hidden />{label}{count !== null && <span className={`min-w-6 rounded-full px-2 py-0.5 text-xs font-bold ${tab === value ? 'bg-white text-blue-700' : 'bg-blue-100 text-blue-700'}`}>{count}</span>}{alert && <PendingDot />}</button> })}
      </div>
    </div>

    {tab === 'servicios' && <section id="dispatch-doc-panel-servicios" role="tabpanel" aria-labelledby="dispatch-doc-tab-servicios" aria-label="Servicios" className="space-y-5">
      <ServicesOverview detail={economic} dispatchId={item.id} onGuides={() => setTab(packingOnly ? 'archivos' : 'guias')} />
      <details className="group rounded-xl border border-slate-200 bg-white" open={packingOnly || !economic}>
        <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-[#002855] [&::-webkit-details-marker]:hidden">
          <span>Documentos por OT y solicitud <span className="font-normal text-slate-500">· {item.stops.length}{item.is_pickup ? ' · Recojo por el cliente' : ''}</span></span><ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" /></summary>
        <div className="space-y-3 border-t border-slate-100 p-3">
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
              {kind === 'ENTREGA' && chip('Packing List', !!packing || !!check?.packing, packing ? `${packing.request_id ? 'Cargado' : 'Consolidado'}${packing.auditor_name ? ` · ${packing.auditor_name}` : ''}` : check?.packing ? 'Cargado' : 'Pendiente')}
              {kind === 'RECOJO_CLIENTE' && chip('Nota de Despacho', !!note || !!check?.note, note || check?.note ? 'Cargada' : 'Pendiente (Asistente)')}
              {!packingOnly && kind === 'ENTREGA' && chip('GR o Nota de Despacho', delivery?.conformity === 'VALIDADA' || !!note || !!check?.note, note || check?.note ? 'Nota de Despacho cargada' : `${delivery ? conformityLabels[delivery.conformity] : 'Aún no disponible'}${delivery?.guide_number ? ` · ${delivery.guide_number}` : ''}`)}
              {!packingOnly && kind === 'RECOJO' && chip('Guía de Remisión', delivery?.conformity === 'VALIDADA', `${delivery ? conformityLabels[delivery.conformity] : 'Aún no disponible'}${delivery?.guide_number ? ` · ${delivery.guide_number}` : ''}`)}
              {!packingOnly && kind === 'TRASLADO' && chip('Documentos', !!packing || !!note || delivery?.conformity === 'VALIDADA' || !!check?.references.length, 'Opcionales en punto a punto', true)}
              {!packingOnly && check?.documentary && <li><DocumentaryBadge closure={check.documentary} /></li>}
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
        </article>
      })}
        </div>
      </details>
    </section>}

    {tab === 'guias' && <section id="dispatch-doc-panel-guias" role="tabpanel" aria-labelledby="dispatch-doc-tab-guias">
      <GuidesClosureTab dispatchId={item.id} executed={!['PROGRAMADO', 'CANCELADO'].includes(item.status)} canUpload={canUpload && canSettle} canManual={canManual && canSettle} canVoid={canEdit}
        stops={item.stops.map(s => ({ request_id: s.request_id, ot: stopLabel(s.request_id).ot, request_number: s.request_number, client: s.client,
          kind: checklists?.get(`${item.id}/${s.request_id}`)?.kind || settlementKind(serviceTypes.get(s.request_id), item.is_pickup), checklist: checklists?.get(`${item.id}/${s.request_id}`) }))}
        documents={item.documents.map(d => ({ ...d, category: docMeta.get(d.id)?.category ?? null, size: docMeta.get(d.id)?.size_bytes ?? null }))}
        numberRefs={item.number_references || []} deliveries={deliveries} linking={children} showLinking={linking} onToggleLinking={() => setLinking(v => !v)}
        onOpen={onOpen} onEvidence={onEvidence} onVoid={id => { const d = item.documents.find(x => x.id === id); if (d) onVoid(d) }} onChanged={onUploaded} />
    </section>}

    {tab === 'liquidacion' && !packingOnly && <section id="dispatch-doc-panel-liquidacion" role="tabpanel" aria-labelledby="dispatch-doc-tab-liquidacion" aria-label="Liquidación de servicios" className="space-y-5">
      <LiquidationDetail detail={economic} dispatchId={item.id} />
      {canSettle && !item.is_pickup && <ForkliftTimeSettlement dispatchId={item.id} onSaved={onUploaded} />}
    </section>}

    {tab === 'archivos' && <section id="dispatch-doc-panel-archivos" role="tabpanel" aria-labelledby="dispatch-doc-tab-archivos">
      <FilesSection rows={fileRows} canUpload={canFiles} staged={staged} onStage={stage} onUnstage={i => setStaged(prev => prev.filter((_, j) => j !== i))} category={category} onCategory={setCategory}
        extra={canPacking && <button type="button" onClick={() => beginUpload(null, 'PACKING_LIST', 'Todas las solicitudes del despacho')} className="text-xs font-semibold text-blue-700 hover:underline">{consolidated ? 'Reemplazar Packing List consolidado' : 'Cargar Packing List consolidado'}</button>} />
      {uploadForm(null)}
    </section>}

    {/* Pie fijo: acción secundaria de la pestaña, Cerrar y Guardar cambios */}
    <div className="sticky -bottom-4 z-20 -mx-4 -mb-4 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-4 py-3 sm:-bottom-6 sm:-mx-6 sm:-mb-6 sm:px-6">
      <div>
        {(tab === 'servicios' || tab === 'liquidacion') && !packingOnly && <button type="button" onClick={() => setHistory(true)} className={`${btn} border border-slate-300 bg-white text-[#002855] hover:bg-slate-50`}><History className="h-4 w-4" />Ver historia de cambios</button>}
        {tab === 'guias' && children && <button type="button" onClick={() => setLinking(v => !v)} className={`${btn} border border-slate-300 bg-white text-[#002855] hover:bg-slate-50`}><Link2 className="h-4 w-4" />Vincular números</button>}
        {tab === 'archivos' && <button type="button" onClick={() => setOtFiles(true)} className={`${btn} border border-slate-300 bg-white text-[#002855] hover:bg-slate-50`}><History className="h-4 w-4" />Ver todos los archivos de la OT</button>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {footerConfirm}
        <button type="button" onClick={onClose} className={`${btn} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`}>Cerrar</button>
        <button type="button" onClick={() => void saveFiles()} disabled={tab !== 'archivos' || !staged.length || saving} title={tab === 'archivos' ? (staged.length ? 'Guardar los archivos seleccionados' : 'Seleccione archivos para guardar') : 'Sin cambios pendientes en esta pestaña'}
          className={`${btn} bg-blue-600 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300`}>{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar cambios</button>
      </div>
    </div>
    {history && <CostHistoryModal dispatchId={item.id} onClose={() => setHistory(false)} />}
    {otFiles && <OtFilesModal requestIds={item.stops.map(s => s.request_id)} onOpen={onOpen} onClose={() => setOtFiles(false)} />}
  </div>
}

function toLocalInput(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
function ForkliftTimeSettlement({ dispatchId, onSaved }: { dispatchId: string; onSaved: () => Promise<void> }) {
  const supabase = useMemo(() => createClient(), [])
  const [service, setService] = useState<{ stop: string; supplier: string; operator: string; rate: number; hours: number | null; amount: number | null; start: string | null; end: string | null } | null>(null)
  const [open, setOpen] = useState(false), [start, setStart] = useState(''), [end, setEnd] = useState(''), [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void supabase.from('route_forklifts').select('transport_request_id,hourly_rate,final_hours,final_amount,service_started_at,service_ended_at,operator_name,suppliers(business_name),transport_requests(request_number,delivery_address)').eq('dispatch_id', dispatchId).maybeSingle().then(({ data, error: queryError }) => {
      if (!alive) return
      if (queryError) { setError(errorMessage(queryError)); return }
      if (!data) { setService(null); return }
      const vendor = Array.isArray(data.suppliers) ? data.suppliers[0] : data.suppliers
      const stop = Array.isArray(data.transport_requests) ? data.transport_requests[0] : data.transport_requests
      const normalized = { stop: forkliftScopeLabel(data.transport_request_id, { number: stop?.request_number, destination: stop?.delivery_address }), supplier: vendor?.business_name || 'Proveedor montacarga', operator: data.operator_name, rate: Number(data.hourly_rate || 0), hours: data.final_hours == null ? null : Number(data.final_hours), amount: data.final_amount == null ? null : Number(data.final_amount), start: data.service_started_at, end: data.service_ended_at }
      setService(normalized); setStart(toLocalInput(normalized.start)); setEnd(toLocalInput(normalized.end))
    })
    return () => { alive = false }
  }, [supabase, dispatchId])
  if (!service) return null
  const duration = start && end ? (new Date(end).getTime() - new Date(start).getTime()) / 3600000 : 0
  const save = async () => {
    setBusy(true); setError('')
    try {
      const { data, error: rpcError } = await supabase.rpc('settle_route_forklift_times', { p_dispatch_id: dispatchId, p_started_at: new Date(start).toISOString(), p_ended_at: new Date(end).toISOString() })
      if (rpcError) throw rpcError
      if (!data?.success) throw new Error(data?.error || 'No se pudo guardar la liquidación')
      setService(s => s ? { ...s, hours: Number(data.hours), amount: Number(data.amount), start: data.started_at, end: data.ended_at } : s)
      toast.success('Horas del montacarga registradas')
      await onSaved(); setOpen(false)
    } catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }
  return <section className="rounded-xl border border-violet-200 bg-violet-50 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="font-bold text-violet-950">Horas del montacarga · {service.supplier}</h3><p className="text-xs text-violet-900">Punto del servicio: {service.stop}</p><p className="text-xs text-violet-900">{service.operator} · Tarifa: S/ {service.rate.toFixed(2)} por hora{service.hours != null ? ` · Liquidado: ${service.hours} h = S/ ${(service.amount || 0).toFixed(2)}` : ''}</p></div><button type="button" onClick={() => setOpen(true)} className="min-h-10 rounded-lg border border-violet-300 bg-white px-3 text-sm font-semibold text-violet-950">{service.hours == null ? 'Ingresar inicio y fin' : 'Editar horas del servicio'}</button></div>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    <Modal isOpen={open} onClose={() => setOpen(false)} title="Registrar horas del montacarga" footer={<div className="flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-lg border px-4 text-sm">Cancelar</button><button type="button" onClick={() => void save()} disabled={busy || !start || !end || duration <= 0 || duration > 168} className="min-h-10 rounded-lg bg-violet-800 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar liquidación'}</button></div>}>
      <div className="space-y-4 p-1"><p className="text-sm text-slate-600">{service.stop} · {service.supplier} · {service.operator} · Tarifa acordada S/ {service.rate.toFixed(2)} por hora.</p><div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-semibold">Hora de inicio<input aria-label="Hora de inicio del servicio de montacarga" type="datetime-local" value={start} onChange={e => setStart(e.target.value)} className="mt-1 min-h-10 w-full rounded-lg border px-3" /></label><label className="text-xs font-semibold">Hora final<input aria-label="Hora final del servicio de montacarga" type="datetime-local" value={end} onChange={e => setEnd(e.target.value)} className="mt-1 min-h-10 w-full rounded-lg border px-3" /></label></div>{start && end && <div className="rounded-lg bg-violet-50 p-3 text-sm">Duración: <b>{duration > 0 && duration <= 168 ? duration.toFixed(2) : 'Verifique las horas'}</b> h · Importe: <b>S/ {(duration > 0 && duration <= 168 ? duration * service.rate : 0).toFixed(2)}</b></div>}{error && <p role="alert" className="text-sm text-red-700">{error}</p>}</div>
    </Modal>
  </section>
}

// Liquidación por servicio: desde que la ruta sale (también en curso) hasta que se liquida

// Documentación pendiente: la oficina completa los documentos de un servicio cerrado según su tipo (misma regla que la
// base, settlement_checklist). Documentos con número: primero el número (serie-correlativo); con el número válido se
// activa la carga. Packing List sin correlativo: carga directa. La liquidación es automática al completar los
// obligatorios; la GR cuenta cuando el Supervisor de Transporte la valida. El app del conductor no cambia.
// Tipo de servicio para los documentos requeridos, con los datos de la solicitud (antes de tener la lista de la base)
type SettlementChecklist = {
  dispatch_id: string; request_id: string; kind: 'ENTREGA' | 'RECOJO' | 'TRASLADO' | 'RECOJO_CLIENTE' | 'RECHAZO'; complete: boolean
  missing: string[]; guide_state: string; note: boolean; packing: boolean; references: string[]
  rejection?: { reason: string; note: string | null; photos: number; captured_at: string; decision: string | null; decision_reason: string | null; decided_at: string | null }
  manual?: { reason: string; missing: string[]; closed_at: string; closed_by: string | null }
  // Reapertura y estado persistido del cierre documentario (independiente del cierre económico)
  reopened?: { reason: string; at: string; by: string | null }
  documentary?: DocumentaryClosure
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

function UploadForm({ dispatchId, requestId, isPickup, canPacking, canDocuments, documentType, category = null, onUploaded }: {
  dispatchId: string; requestId: string | null; isPickup: boolean; canPacking: boolean; canDocuments: boolean; documentType: string; category?: string | null; onUploaded: () => Promise<void>
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
    // Categoría del archivo (Comprobante, Conformidad, Evidencia u Otros); no cambia su tipo ni las reglas de liquidación
    if (!packing && docType === 'OTRO' && category && data.id) await supabase.rpc('set_dispatch_document_category', { p_document_id: data.id, p_category: category })
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
