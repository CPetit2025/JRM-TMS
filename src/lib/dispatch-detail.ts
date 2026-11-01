import { connectionLevel } from '@/lib/gps-monitor'
import { isZeroClosed, type EconItem, type EconState } from '@/lib/economic-closure'
import type { DeliveryRow } from '@/lib/delivery'

// Detalle de una parada (despacho × solicitud) que devuelve get_dispatch_detail: solo registros guardados.
export type DetailEvent = {
  at: string; source: string; scope: 'RUTA' | 'SERVICIO'; type: string; detail?: string | null
  actor?: string | null; origin?: string | null; level: 'INFO' | 'ALERTA' | 'INCIDENCIA'
}
export type DispatchDetail = {
  dispatch: {
    id: string; number: string | null; status: string; modalidad: string | null; scheduled_departure: string | null
    estimated_distance_km: number | null; vehicle_plate: string | null; services_count: number
    driver: { name: string | null; document_number: string | null } | null
  }
  milestones: {
    programado: string | null; salida: string | null; llegada: string | null; retorno: string | null; cierre: string | null; cierre_estado: string | null
    conformidad: { decision: 'VALIDADA' | 'OBSERVADA' | 'RECHAZADA'; reason: string | null; at: string; by: string | null } | null
    rechazo: { kind: 'TOTAL' | 'PARCIAL'; reason_code: string; at: string; decision: string | null } | null
  }
  presence: { applies: boolean; connected: boolean; last_seen_at: string | null; gps_state: string | null; gps_at: string | null; server_now: string }
  events: DetailEvent[]
  /** Estimado de OSRM guardado al programar (solo rutas programadas desde que existe el dato) */
  estimate?: RouteEstimateData | null
  economic: boolean
  sources_failed: string[]
}

export type RouteEstimateData = {
  distance_km: number | null; duration_min: number | null; origin: { lat: number; lon: number } | null; destination: { lat: number; lon: number } | null
  geometry: [number, number][] | null; source: string; computed_at: string
}
export const durationLabel = (minutes: number | null | undefined) => minutes == null ? null : minutes < 60 ? `${Math.round(minutes)} min` : `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`
export type StepState = 'done' | 'current' | 'pending' | 'alert'
export type Milestone = { key: string; label: string; at: string | null; state: StepState; note: string }

export const detailTime = (value: string | null | undefined) => value ? new Date(value).toLocaleString('es-PE', {
  timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
}) : '—'

/** Hitos de la parada con fecha real; el primero sin registrar después del último registrado es el actual. */
export function milestones(detail: DispatchDetail, row: Pick<DeliveryRow, 'conformity'>, full = false): Milestone[] {
  const m = detail.milestones, review = m.conformidad
  const conformityAlert = review && review.decision !== 'VALIDADA'
  const steps: Omit<Milestone, 'state'>[] = [
    { key: 'programado', label: 'Programado', at: m.programado, note: 'Salida programada' },
    { key: 'salida', label: 'Salida', at: m.salida, note: m.salida ? 'Unidad inició la ruta' : 'Sin salida registrada' },
    { key: 'llegada', label: m.rechazo?.kind === 'TOTAL' ? 'Rechazo en destino' : 'Llegada a destino', at: m.rechazo?.kind === 'TOTAL' ? m.rechazo.at : m.llegada,
      note: m.rechazo?.kind === 'TOTAL' ? 'El cliente rechazó la entrega' : m.llegada ? 'Unidad en destino' : 'Sin llegada registrada' },
    { key: 'conformidad', label: 'Conformidad', at: review?.at ?? null,
      note: review ? `${review.decision === 'VALIDADA' ? 'Validada' : review.decision === 'OBSERVADA' ? 'Observada' : 'Rechazada'}${review.by ? ` por ${review.by}` : ''}`
        : row.conformity === 'RECIBIDA' ? 'Guía recibida · pendiente de validación' : row.conformity === 'NO_APLICA' ? 'No aplica' : 'Pendiente' },
  ]
  if (full) steps.push(
    { key: 'retorno', label: 'Retorno', at: m.retorno, note: m.retorno ? 'Unidad liberada' : 'Sin retorno registrado' },
    { key: 'cierre', label: 'Cierre operativo', at: m.cierre, note: m.cierre ? (m.cierre_estado === 'CIERRE_OPERATIVO' ? 'Cierre operativo registrado' : 'Viaje cerrado') : 'Sin cierre operativo' },
  )
  const done = (s: Omit<Milestone, 'state'>) => !!s.at && !(s.key === 'conformidad' && conformityAlert)
  const last = steps.reduce((acc, s, i) => done(s) ? i : acc, -1)
  return steps.map((s, i) => ({ ...s, state: s.key === 'conformidad' && conformityAlert ? 'alert' : done(s) ? 'done' : i === last + 1 ? 'current' : 'pending' }))
}

export type Pending = { key: string; title: string; detail: string; tab: DetailTab }
/** Pendientes reales de la parada; ninguno se resuelve desde aquí ni cierra otro proceso. */
export function pendingItems(row: DeliveryRow): Pending[] {
  const out: Pending[] = []
  if (row.state === 'PROGRAMADO' && row.documents_state && !['NO_REQUERIDO', 'LISTO'].includes(row.documents_state))
    out.push({ key: 'salida', title: row.documents_state === 'REEMISION' ? 'Documentos de salida por reemitir' : 'Documentos de salida pendientes', detail: 'Completar los documentos de salida de la ruta.', tab: 'documentos' })
  if (row.conformity === 'RECIBIDA') out.push({ key: 'validar', title: 'Guía de entrega pendiente de validación', detail: `Revisar y validar la guía${row.guide_number ? ` ${row.guide_number}` : ''} registrada.`, tab: 'documentos' })
  if (row.conformity === 'OBSERVADA' || row.conformity === 'RECHAZADA') out.push({ key: 'observada', title: `Guía ${row.conformity === 'OBSERVADA' ? 'observada' : 'rechazada'}`, detail: 'El conductor debe volver a enviar la guía y las fotos.', tab: 'documentos' })
  if (row.conformity === 'PENDIENTE' && row.arrived_at) out.push({ key: 'guia', title: 'Guía de entrega sin registrar', detail: 'La unidad llegó al destino y aún no envía la guía.', tab: 'documentos' })
  return out
}

export type GpsStatus = { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; detail: string }
/** «En línea» solo con presencia del app confirmada en los últimos 90 s; tercero y recojo por cliente no tienen GPS. */
export function gpsStatus(detail: DispatchDetail, row: Pick<DeliveryRow, 'modalidad'>): GpsStatus {
  const p = detail.presence
  if (!p.applies) return { label: 'Sin GPS', tone: 'neutral', detail: row.modalidad === 'TERCERO' ? 'Unidad de tercero: sin GPS del app' : row.modalidad === 'RECOJO_CLIENTE' ? 'Recojo por cliente' : 'Sin conductor con app asignado' }
  const level = connectionLevel({ connected: p.connected, last_seen_at: p.last_seen_at }, Date.parse(p.server_now))
  const last = p.gps_at ? `Última posición ${detailTime(p.gps_at)}` : 'Sin posición registrada'
  if (level === 'connected') return { label: 'En línea', tone: 'success', detail: last }
  if (level === 'intermittent') return { label: 'Intermitente', tone: 'warning', detail: last }
  return { label: 'Sin conexión', tone: 'danger', detail: p.last_seen_at ? `${last} · último aviso ${detailTime(p.last_seen_at)}` : last }
}

export const DETAIL_TABS = [
  { key: 'resumen', label: 'Resumen' }, { key: 'ruta', label: 'Ruta y seguimiento' }, { key: 'documentos', label: 'Documentos' },
  { key: 'evidencias', label: 'Fotos y evidencias' }, { key: 'costos', label: 'Costos' }, { key: 'cierre', label: 'Cierre del servicio' }, { key: 'historial', label: 'Historial' },
] as const
export type DetailTab = typeof DETAIL_TABS[number]['key']

const EVENT_TITLES: Record<string, string> = {
  GUIA_RECIBIDA: 'Guía de entrega recibida', LLEGADA_DESTINO: 'Llegada a destino', CONFORMIDAD_VALIDADA: 'Conformidad validada',
  CONFORMIDAD_OBSERVADA: 'Conformidad observada', CONFORMIDAD_RECHAZADA: 'Conformidad rechazada', RECHAZO_TOTAL: 'Rechazo total en destino',
  RECHAZO_PARCIAL: 'Rechazo parcial en destino', RECHAZO_REPROGRAMADA: 'Rechazo: solicitud reprogramada', RECHAZO_ANULADA: 'Rechazo: solicitud anulada',
  SOLICITUD_CREATED: 'Solicitud registrada', SOLICITUD_UPDATED: 'Solicitud actualizada', SOLICITUD_STATUS_CHANGED: 'Cambio de estado de la solicitud',
  DOCUMENTO_REGISTRADO: 'Documento registrado', DOCUMENTO_ANULADO: 'Documento anulado',
  DOCUMENTARIO_INICIAL: 'Cierre documentario: estado inicial', DOCUMENTARIO_AUTOMATICO: 'Cierre documentario: actualización automática',
  DOCUMENTARIO_CIERRE_MANUAL: 'Cierre documentario manual', DOCUMENTARIO_DESHACER_MANUAL: 'Cierre documentario manual deshecho', DOCUMENTARIO_REAPERTURA: 'Cierre documentario reabierto',
  ECONOMICO_ENVIAR: 'Cierre económico enviado', ECONOMICO_APROBAR: 'Cierre económico aprobado', ECONOMICO_OBSERVAR: 'Cierre económico observado',
  ECONOMICO_REABRIR: 'Cierre económico reabierto', ECONOMICO_NOTA: 'Nota del cierre económico', ECONOMICO_AGREGAR: 'Servicio agregado en el cierre económico',
  COSTO_REFERENCIAL: 'Costo referencial', COSTO_ACORDADO: 'Costo acordado', COSTO_AJUSTE: 'Ajuste de costo', COSTO_FINAL: 'Costo final', COSTO_ESTADO: 'Cambio de estado del costo',
  STATUS_CHANGE: 'Cambio de estado de la ruta', CIERRE_OPERATIVO_MANUAL: 'Cierre operativo manual',
}
export const eventTitle = (type: string) => EVENT_TITLES[type] || (type.startsWith('INCIDENTE_') ? `Incidente vehicular · ${type.slice(10).toLowerCase()}` : type.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase()))

export const EVENT_SOURCES: Record<string, string> = {
  OPERACION: 'Operación de la ruta', SOLICITUD: 'Solicitud', ENTREGA: 'Entrega y conformidad', DOCUMENTO: 'Documentos',
  DOCUMENTARIO: 'Cierre documentario', INCIDENTE: 'Incidentes', ECONOMICO: 'Cierre económico', COSTO: 'Costos',
}

export type EventFilter = { from: string; to: string; source: string; actor: string }
/** Filtro por día de Lima (yyyy-mm-dd), fuente y usuario u origen. */
export function filterEvents(events: DetailEvent[], f: EventFilter): DetailEvent[] {
  const day = (at: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at))
  return events.filter(e => (!f.from || day(e.at) >= f.from) && (!f.to || day(e.at) <= f.to) && (!f.source || e.source === f.source) && (!f.actor || eventActor(e) === f.actor))
}
export const eventActor = (e: DetailEvent) => e.actor || (e.origin ? `Sistema · ${e.origin}` : 'Sistema')
export const incidents = (events: DetailEvent[]) => events.filter(e => e.level === 'INCIDENCIA')

/** Filas del Excel del historial (mismas columnas que la tabla). */
export const historyRows = (events: DetailEvent[]) => events.map(e => ({
  'Fecha y hora': detailTime(e.at), Evento: eventTitle(e.type), Fuente: EVENT_SOURCES[e.source] || e.source,
  Ámbito: e.scope === 'RUTA' ? 'Ruta' : 'Servicio', 'Usuario / origen': eventActor(e), Detalle: e.detail || '',
}))

// Documentos y evidencias de la parada (get_dispatch_detail_files + get_dispatch_evidence de la ruta)
export type DetailDocument = {
  id: string; doc_type: string; category: string | null; number: string | null; file_path: string; file_name: string | null
  mime_type: string | null; size_bytes: number | null; uploaded_at: string; uploaded_by: string | null; scope: 'RUTA' | 'SERVICIO'
}
export type DetailSubmission = {
  id: string; photos: string[]; packing_photos: string[]; guide_number: string | null; received_by: string | null; source: string
  captured_at: string; submitted_at: string; submitted_by: string | null
  review: { decision: 'VALIDADA' | 'OBSERVADA' | 'RECHAZADA'; reason: string | null; at: string; by: string | null } | null
}
export type DocumentaryState = { status: 'PENDIENTE' | 'EN_VALIDACION' | 'OBSERVADO' | 'COMPLETO'; source: string | null; missing: string[]; completed_at: string | null; completed_by: string | null; reopened_at: string | null; updated_at: string }
export type DispatchFiles = {
  can_view_documents: boolean; documents: DetailDocument[]; references: { doc_type: string; number: string; at: string; by: string | null }[]
  documentary: DocumentaryState | null; submissions: DetailSubmission[]; arrival: { at: string; lat: number | null; lon: number | null } | null
  rejection: { kind: string; reason_code: string; note: string | null; photos: string[]; captured_at: string; lat: number | null; lon: number | null; decision: string | null } | null
  evidence?: OperationalEvidence[]; service_kind?: string | null; can_add_evidence?: boolean
  sources_failed: string[]
}
export type RouteEvidence = { kind: string; label: string; path: string; taken_at: string | null }
/** Evidencia operativa con etapa (dispatch_evidence), registrada desde el detalle por quien opera la ruta. */
export type OperationalEvidence = {
  id: string; stage: EvidenceStage; file_path: string; file_name: string | null; mime_type: string | null; size_bytes: number | null
  note: string | null; uploaded_at: string; uploaded_by: string | null; scope: 'RUTA' | 'SERVICIO'; can_void: boolean
}
export type EvidenceStage = 'RECOJO' | 'TRANSITO' | 'LLEGADA' | 'DESCARGA' | 'INCIDENCIA' | 'OTRO'
export const EVIDENCE_STAGES: Record<EvidenceStage, string> = { RECOJO: 'Recojo', TRANSITO: 'Tránsito', LLEGADA: 'Llegada', DESCARGA: 'Descarga', INCIDENCIA: 'Incidencia', OTRO: 'Otro' }
/** Mismo límite que el resto de cargas del despacho (el bucket admite hasta 15 MB). */
export const EVIDENCE_MAX_MB = 10
export const EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

export const DOC_TYPE_LABEL: Record<string, string> = { GUIA_REMISION: 'Guía de remisión', NOTA_DESPACHO: 'Nota de despacho', PACKING_LIST: 'Packing list', OTRO: 'Otro documento' }
export const DOC_CATEGORY_LABEL: Record<string, string> = { CONFORMIDAD: 'Conformidad', EVIDENCIA: 'Evidencia', COMPROBANTE: 'Comprobante', OTROS: 'Otros' }
export const docGroup = (d: Pick<DetailDocument, 'doc_type'>) => d.doc_type === 'OTRO' ? 'OTROS' : 'SALIDA'
export const DOCUMENTARY_STEPS = ['PENDIENTE', 'EN_VALIDACION', 'COMPLETO'] as const
export const DOCUMENTARY_LABEL: Record<DocumentaryState['status'], string> = { PENDIENTE: 'Pendiente', EN_VALIDACION: 'En validación', OBSERVADO: 'Observado', COMPLETO: 'Completo' }
export const missingLabel = (code: string) => ({ REAPERTURA: 'Cierre reabierto: requiere revisión', DECISION_RECHAZO: 'Decisión del rechazo en destino' } as Record<string, string>)[code]
  || code.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase())
export const fileSize = (bytes: number | null | undefined) => !bytes ? '—' : bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
export const isImage = (path: string, mime?: string | null) => (mime || '').startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)($|\?)/i.test(path)
export const isPdfFile = (path: string, mime?: string | null) => mime === 'application/pdf' || /\.pdf($|\?)/i.test(path)

/** Grupo de cada evidencia según su fuente real (no hay etapa por foto en el modelo: no se inventa recojo/tránsito). */
export type EvidenceGroup = 'RECOJO' | 'TRANSITO' | 'LLEGADA' | 'DESCARGA' | 'DOCUMENTO' | 'UNIDAD' | 'INCIDENCIA' | 'GASTO' | 'OTRO'
export const EVIDENCE_GROUPS: Record<EvidenceGroup, string> = { RECOJO: 'Recojo', TRANSITO: 'Tránsito', LLEGADA: 'Llegada', DESCARGA: 'Descarga', DOCUMENTO: 'Documento',
  UNIDAD: 'Unidad', INCIDENCIA: 'Incidencias', GASTO: 'Gastos', OTRO: 'Otros' }
export type DetailEvidence = { key: string; group: EvidenceGroup; label: string; path: string; at: string | null; scope: 'RUTA' | 'SERVICIO'; note?: string; by?: string | null
  mime?: string | null; size?: number | null; place?: string | null; evidenceId?: string; canVoid?: boolean }
const ROUTE_KIND: Record<string, EvidenceGroup> = { DOCUMENTO: 'DOCUMENTO', GUIA: 'DOCUMENTO', ENTREGA: 'LLEGADA', CHECKLIST: 'UNIDAD', ODOMETRO: 'UNIDAD', FALLA: 'INCIDENCIA', GASTO: 'GASTO', ANTICIPO: 'GASTO' }
/**
 * Evidencias de la parada por su etapa real: las operativas traen la etapa registrada; las fotos del app en destino son
 * «Llegada» (guía) y «Descarga» (carga entregada); el rechazo es «Incidencias»; lo de la ruta según su fuente.
 */
export function evidenceItems(files: DispatchFiles | null, route: RouteEvidence[], places: { pickup?: string; delivery?: string } = {}): DetailEvidence[] {
  const out: DetailEvidence[] = []
  const stagePlace = (stage: string) => stage === 'RECOJO' ? places.pickup : stage === 'LLEGADA' || stage === 'DESCARGA' ? places.delivery : null
  for (const e of files?.evidence || []) out.push({ key: `o/${e.id}`, group: e.stage, label: e.note || EVIDENCE_STAGES[e.stage], path: `dispatch_documents/${e.file_path}`, at: e.uploaded_at,
    scope: e.scope, by: e.uploaded_by, mime: e.mime_type, size: e.size_bytes, place: stagePlace(e.stage), evidenceId: e.id, canVoid: e.can_void })
  for (const s of files?.submissions || []) {
    const guide = s.guide_number ? ` · guía ${s.guide_number}` : ''
    s.photos.forEach((path, i) => out.push({ key: `s/${s.id}/${i}`, group: 'LLEGADA', label: `Entrega en destino${guide}`, path, at: s.captured_at, scope: 'SERVICIO', note: s.received_by ? `Recibió ${s.received_by}` : undefined, by: s.submitted_by, place: places.delivery }))
    s.packing_photos.forEach((path, i) => out.push({ key: `p/${s.id}/${i}`, group: 'DESCARGA', label: `Carga entregada${guide}`, path, at: s.captured_at, scope: 'SERVICIO', by: s.submitted_by, place: places.delivery }))
  }
  files?.rejection?.photos.forEach((path, i) => out.push({ key: `r/${i}`, group: 'INCIDENCIA', label: `Rechazo ${files.rejection!.kind === 'TOTAL' ? 'total' : 'parcial'} en destino`, path, at: files.rejection!.captured_at, scope: 'SERVICIO', note: files.rejection!.note || undefined, place: places.delivery }))
  // De la ruta: los documentos ya se listan en la pestaña Documentos; aquí solo lo que el app registró como evidencia
  route.filter(r => r.path && r.kind !== 'DOCUMENTO').forEach((r, i) => out.push({ key: `e/${i}`, group: ROUTE_KIND[r.kind] || 'UNIDAD', label: r.label, path: r.path, at: r.taken_at, scope: 'RUTA' }))
  return out.sort((a, b) => (b.at ? Date.parse(b.at) : 0) - (a.at ? Date.parse(a.at) : 0))
}
/** URL firmada de Storage que fuerza la descarga (parámetro download de Supabase); otras URL quedan igual. */
export const downloadUrl = (url: string) => /\/storage\/v1\/object\/sign\//.test(url) ? `${url}${url.includes('?') ? '&' : '?'}download=` : url

// Costos (economic_closure_detail + gastos de Caja de la ruta). Solo lo atribuible a la solicitud suma a su costo.
export type EconomicDetail = {
  success: true; dispatch_number: string; route_status: string; state: EconState; items: EconItem[]
  requests: { id: string; request_number: string; contract_code: string | null; doc_status: string | null }[]
  can_validate: boolean; can_approve: boolean
  services?: { id: string; agreed_rate: number | null; billing_unit: string | null; final_billable_qty: number | null; agreed_qty: number | null }[]
}
export type RouteExpense = { id: string; expense_type: string; amount: number; status: string | null; description: string | null; created_at: string | null; receipt_url?: string | null; provider_name?: string | null }
export type DispatchCosts = { detail: EconomicDetail | null; error: string; expenses: RouteExpense[]; expensesError: string; receipts: Record<string, string | null> }
const amount = (i: EconItem) => Number(i.final_pen ?? i.agreed_pen ?? 0)
export function stopCosts(d: EconomicDetail, row: Pick<DeliveryRow, 'dispatch_id' | 'request_id' | 'request_number'>) {
  const own = d.items.find(i => i.kind === 'FLETE' && i.key === `F:${row.request_id}`)
  const route = own ? null : d.items.find(i => i.kind === 'FLETE' && i.key === `F:${row.dispatch_id}`) || null
  const freight = own || route, freightScope: 'SERVICIO' | 'RUTA' = own || d.requests.length <= 1 ? 'SERVICIO' : 'RUTA'
  const services = d.items.filter(i => i.kind === 'SERVICIO' && i.request_number === row.request_number && !isZeroClosed(i))
  const servicesTotal = Math.round(services.reduce((sum, i) => sum + amount(i), 0) * 100) / 100
  const total = Math.round(((freight && freightScope === 'SERVICIO' ? amount(freight) : 0) + servicesTotal) * 100) / 100
  return { freight, freightScope, services, servicesTotal, total }
}

// Recorrido GPS real de la ruta (route_track_points); se reduce para dibujarlo sin perder inicio ni fin
export type TrackPoint = { at: string; lat: number; lon: number }
export function thinTrack(points: TrackPoint[], max = 400): TrackPoint[] {
  if (points.length <= max) return points
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)])
}

/** Documentos de la parada con estado y responsable reales (registró / validó); lo exigido que falta aparece «Pendiente». */
export type DocumentRow = {
  key: string; name: string; group: 'SALIDA' | 'RECEPCION' | 'OTROS'; number: string | null; related: string; at: string | null
  state: 'VALIDADO' | 'REGISTRADO' | 'PENDIENTE' | 'OBSERVADO' | 'NO_REQUERIDO'; responsible: string | null; path: string | null; mime: string | null; size: number | null
}
const REQUIRED: Record<string, { code: string; name: string; group: DocumentRow['group'] }[]> = {
  ENTREGA: [{ code: 'GUIA_O_NOTA', name: 'Guía de entrega', group: 'RECEPCION' }, { code: 'PACKING_LIST', name: 'Packing list', group: 'SALIDA' }],
  RECOJO: [{ code: 'GUIA_REMISION', name: 'Guía de entrega', group: 'RECEPCION' }],
  RECOJO_CLIENTE: [{ code: 'NOTA_DESPACHO', name: 'Nota de despacho', group: 'SALIDA' }],
}
export function documentRows(files: DispatchFiles, row: Pick<DeliveryRow, 'dispatch_number' | 'request_number' | 'documents_state'>): DocumentRow[] {
  const out: DocumentRow[] = [], related = `Despacho ${row.dispatch_number || ''}\n${row.request_number}`
  for (const s of files.submissions) out.push({ key: `s/${s.id}`, name: 'Guía de entrega', group: 'RECEPCION', number: s.guide_number, related, at: s.submitted_at,
    state: s.review?.decision === 'VALIDADA' ? 'VALIDADO' : s.review ? 'OBSERVADO' : 'PENDIENTE', responsible: s.review?.by || null, path: s.photos[0] || null, mime: null, size: null })
  for (const d of files.documents) out.push({ key: `d/${d.id}`, name: DOC_TYPE_LABEL[d.doc_type] || d.doc_type, group: d.doc_type === 'OTRO' ? 'OTROS' : 'SALIDA', number: d.number,
    related: d.scope === 'RUTA' ? `Ruta ${row.dispatch_number || ''}` : related, at: d.uploaded_at, state: 'REGISTRADO', responsible: d.uploaded_by, path: `dispatch_documents/${d.file_path}`, mime: d.mime_type, size: d.size_bytes })
  for (const r of files.references) if (!out.some(o => o.number && o.number.toUpperCase() === r.number.toUpperCase()))
    out.push({ key: `r/${r.number}`, name: r.doc_type === 'NOTA_DESPACHO' ? 'Nota de despacho' : 'Guía de remisión', group: 'SALIDA', number: r.number, related, at: r.at, state: 'REGISTRADO', responsible: r.by, path: null, mime: null, size: null })
  // Exigidos por el cierre documentario que aún faltan (sin archivo ni número): pendientes, no se inventa el documento
  const missing = files.documentary?.missing || []
  for (const req of REQUIRED[files.service_kind || ''] || []) if (missing.includes(req.code) && !out.some(o => o.name === req.name))
    out.push({ key: `m/${req.code}`, name: req.name, group: req.group, number: null, related, at: null, state: 'PENDIENTE', responsible: null, path: null, mime: null, size: null })
  if (!row.documents_state || row.documents_state === 'NO_REQUERIDO')
    out.push({ key: 'salida', name: 'Documentos de salida', group: 'SALIDA', number: null, related: '—', at: null, state: 'NO_REQUERIDO', responsible: null, path: null, mime: null, size: null })
  return out
}

/** Checklist de conformidad derivado de los registros (solo lectura; se valida en «Guía y conformidad»). */
export type ChecklistItem = { key: string; label: string; state: 'COMPLETO' | 'PENDIENTE' | 'NO_REQUERIDO' | 'OBSERVADO'; note: string }
export function conformityChecklist(files: DispatchFiles, row: Pick<DeliveryRow, 'documents_state' | 'conformity'>): ChecklistItem[] {
  const last = files.submissions[0], photos = files.submissions.reduce((n, s) => n + s.photos.length, 0), pickup = row.conformity === 'NO_APLICA'
  const docsRequired = !!row.documents_state && row.documents_state !== 'NO_REQUERIDO'
  return [
    { key: 'guia', label: 'Guía de entrega recibida', state: last ? 'COMPLETO' : pickup ? 'NO_REQUERIDO' : 'PENDIENTE',
      note: last ? `Guía ${last.guide_number || 'sin número'} enviada ${detailTime(last.submitted_at)}.` : pickup ? 'Recojo por cliente.' : 'Aún no se envía la guía.' },
    { key: 'fotos', label: 'Fotos de entrega', state: photos ? 'COMPLETO' : pickup ? 'NO_REQUERIDO' : 'PENDIENTE', note: photos ? `${photos} foto(s) registrada(s).` : 'Sin fotos de entrega.' },
    { key: 'salida', label: 'Documentos de salida', state: !docsRequired ? 'NO_REQUERIDO' : row.documents_state === 'LISTO' ? 'COMPLETO' : 'PENDIENTE',
      note: !docsRequired ? 'No se requieren documentos de salida.' : row.documents_state === 'LISTO' ? 'Documentos de salida listos.' : 'Documentos de salida pendientes.' },
    { key: 'conformidad', label: 'Conformidad de recepción', state: last?.review?.decision === 'VALIDADA' ? 'COMPLETO' : last?.review ? 'OBSERVADO' : pickup ? 'NO_REQUERIDO' : 'PENDIENTE',
      note: last?.review ? `${last.review.decision === 'VALIDADA' ? 'Validada' : 'Observada'}${last.review.by ? ` por ${last.review.by}` : ''}${last.review.reason ? `: ${last.review.reason}` : ''}.` : 'Validación por el área correspondiente.' },
  ]
}

/** Etapas documentarias con avance (Recepción, Validación, Cierre) contadas desde los registros. */
export function documentaryProgress(files: DispatchFiles): { key: string; label: string; at: null; state: StepState; count: string }[] {
  const received = files.submissions.length > 0, validated = files.submissions.some(s => s.review?.decision === 'VALIDADA')
  const observed = !validated && !!files.submissions[0]?.review, closed = files.documentary?.status === 'COMPLETO'
  return [
    { key: 'recepcion', label: 'Recepción', at: null, state: received || closed ? 'done' : 'current', count: `${received || closed ? 1 : 0}/1` },
    { key: 'validacion', label: 'Validación', at: null, state: validated || closed ? 'done' : observed ? 'alert' : received ? 'current' : 'pending', count: `${validated || closed ? 1 : 0}/1` },
    { key: 'cierre', label: 'Cierre', at: null, state: closed ? 'done' : validated ? 'current' : 'pending', count: `${closed ? 1 : 0}/1` },
  ]
}
