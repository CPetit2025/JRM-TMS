'use client'
import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, ChevronDown, Clock, Download, Eye, FileText, History, Image as ImageIcon, Info, Loader2, Plus, Trash2, Truck, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { DOCS_BUCKET, errorMessage } from '@/lib/caja'
import { packingMime } from '@/lib/packing-list'
import { Modal } from '@/components/ui/modal'
import { TableActions, type TableAction } from '@/components/ui/table-actions'
import { DOCUMENTARY_LABEL, DocumentaryBadge, type DocumentaryClosure, type DocumentaryStatus } from '@/components/despacho/DocumentaryClosure'
import type { DeliveryRow } from '@/lib/delivery'

// Pestaña «Guías y notas» del modal de Documentos (bosquejo aprobado):
// 1. Guías de remisión y notas de despacho de la ruta (sin duplicar números) con ver, descargar, subir y vincular.
// 2. Cierre documentario por servicio: documentos requeridos según el tipo de servicio, su cumplimiento, carga directa,
//    cierre manual con motivo e historial. Usa las mismas funciones de la base que la liquidación documentaria.

export type ServiceKind = 'ENTREGA' | 'RECOJO' | 'TRASLADO' | 'RECOJO_CLIENTE' | 'RECHAZO'
export type Checklist = {
  kind: ServiceKind; complete: boolean; missing: string[]; guide_state: string; note: boolean; packing: boolean; references: string[]
  rejection?: { photos: number; decision: string | null } | null
  manual?: { reason: string; closed_at: string; closed_by: string | null } | null
  documentary?: DocumentaryClosure
}
export type StopInfo = { request_id: string; ot: string; request_number: string; client: string | null; kind: ServiceKind; checklist?: Checklist }
export type DocInfo = {
  id: string; request_id: string | null; doc_type: string; document_number: string | null; file_path: string; file_name: string | null
  uploaded_at: string; signed?: boolean; category?: string | null; size?: number | null
}
type Props = {
  dispatchId: string; stops: StopInfo[]; documents: DocInfo[]; numberRefs: { request_id: string; doc_type: string; document_number: string }[]
  deliveries: DeliveryRow[]; executed: boolean; canUpload: boolean; canManual: boolean; canVoid: boolean; linking: React.ReactNode
  showLinking: boolean; onToggleLinking: () => void
  onOpen: (path: string) => void; onEvidence: (row: DeliveryRow) => void; onVoid: (docId: string) => void; onChanged: () => Promise<void>
}

type UploadKind = 'GUIA' | 'NOTA' | 'PACKING' | 'EVIDENCIA' | 'CONFORMIDAD'
const UPLOAD_LABEL: Record<UploadKind, string> = { GUIA: 'Guía de Remisión', NOTA: 'Nota de Despacho', PACKING: 'Packing List', EVIDENCIA: 'Evidencia de entrega', CONFORMIDAD: 'Conformidad del cliente' }
const NUMBER_RULE: Partial<Record<UploadKind, { pattern: RegExp; example: string }>> = {
  GUIA: { pattern: /^[A-Z0-9]{3,4}-[0-9]{1,10}$/, example: 'T001-6591' }, NOTA: { pattern: /^[A-Z0-9]{1,8}-[0-9]{1,10}$/, example: 'ND01-1234' },
}
const guideMime = (f: File) => /\.pdf$/i.test(f.name) ? 'application/pdf' : /\.png$/i.test(f.name) ? 'image/png' : /\.webp$/i.test(f.name) ? 'image/webp' : /\.jpe?g$/i.test(f.name) ? 'image/jpeg' : null
const safeName = (name: string) => name.replace(/[^\w.-]+/g, '_').slice(-80)
const fmtDay = (v: string | null) => (v ? new Date(v).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—')
const fmtSize = (b: number | null | undefined) => (b ? `${(b / 1024 / 1024).toFixed(1)} MB` : null)
const fmtWhen = (v: string) => new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

function Pill({ tone, children, icon: Icon }: { tone: 'green' | 'amber' | 'red' | 'blue' | 'slate'; children: React.ReactNode; icon?: typeof CheckCircle2 }) {
  const cls = { green: 'bg-emerald-50 text-emerald-700 ring-emerald-200', amber: 'bg-amber-50 text-amber-700 ring-amber-200', red: 'bg-red-50 text-red-700 ring-red-200', blue: 'bg-blue-50 text-blue-700 ring-blue-200', slate: 'bg-slate-50 text-slate-600 ring-slate-200' }[tone]
  return <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>{Icon && <Icon className="h-3.5 w-3.5" />}{children}</span>
}
function Tag({ tone, children }: { tone: 'amber' | 'slate'; children: React.ReactNode }) {
  return <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone === 'amber' ? 'bg-amber-50 text-amber-700 ring-amber-200' : 'bg-slate-50 text-slate-600 ring-slate-200'}`}>{children}</span>
}
const PdfMark = () => <span className="grid h-7 w-6 shrink-0 place-items-center rounded-sm bg-red-600 text-[7px] font-bold text-white">PDF</span>
const SectionIcon = ({ icon: Icon }: { icon: typeof FileText }) => <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-700"><Icon className="h-6 w-6" /></span>

type GuideRow = {
  key: string; stop: StopInfo; type: 'GUIA' | 'NOTA'; number: string | null; date: string | null
  status: 'VALIDADA' | 'EN_VALIDACION' | 'OBSERVADA' | 'REGISTRADA' | 'PENDIENTE' | 'FALTA'; doc?: DocInfo; delivery?: DeliveryRow
}
const ROW_STATUS: Record<GuideRow['status'], { label: string; tone: 'green' | 'amber' | 'red' | 'blue'; icon: typeof CheckCircle2 }> = {
  VALIDADA: { label: 'Validada', tone: 'green', icon: CheckCircle2 }, REGISTRADA: { label: 'Registrada', tone: 'blue', icon: CheckCircle2 },
  EN_VALIDACION: { label: 'Por validar', tone: 'amber', icon: Clock }, OBSERVADA: { label: 'Observada', tone: 'red', icon: AlertCircle },
  PENDIENTE: { label: 'Pendiente', tone: 'amber', icon: Clock }, FALTA: { label: 'Falta', tone: 'red', icon: AlertCircle },
}
// Regla del documento con número según el tipo de servicio (misma regla que settlement_checklist_rules)
const docRule = (kind: ServiceKind, type: 'GUIA' | 'NOTA') =>
  kind === 'ENTREGA' ? (type === 'GUIA' ? 'Obligatorio' : 'Según corresponda') : kind === 'RECOJO' ? (type === 'GUIA' ? 'Obligatorio' : 'Opcional')
    : kind === 'RECOJO_CLIENTE' ? (type === 'NOTA' ? 'Obligatorio' : 'Opcional') : 'Opcional'

type Requirement = {
  key: string; title: string; subtitle?: string; icon: typeof FileText; rule: string; required: boolean
  done: boolean; state: { label: string; tone: 'green' | 'amber' | 'red' | 'slate' | 'blue'; icon: typeof CheckCircle2 }
  file?: DocInfo | null; reference?: string | null; upload?: UploadKind | null; view?: () => void; note: string
}

type HistoryEvent = { id: string; action: string; previous_status: DocumentaryStatus | null; new_status: DocumentaryStatus; reason: string | null; created_at: string; actor: string | null; details: { carga_inicial?: boolean } }
const HISTORY_ACTION: Record<string, string> = { INICIAL: 'Registro inicial', AUTOMATICO: 'Cambio automático', CIERRE_MANUAL: 'Cierre manual', DESHACER_MANUAL: 'Cierre manual deshecho', REAPERTURA: 'Reapertura' }

export function GuidesClosureTab(p: Props) {
  const supabase = useMemo(() => createClient(), [])
  const multi = p.stops.length > 1
  const [upload, setUpload] = useState<{ kind: UploadKind; requestId: string; number?: string } | null>(null)
  const [reasonFor, setReasonFor] = useState<null | { action: 'manual' | 'undo' | 'reopen'; requestId: string }>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [history, setHistory] = useState<(HistoryEvent & { stop: StopInfo })[] | null>(null)
  const stopKey = p.stops.map(s => `${s.request_id}:${s.checklist?.documentary?.status || ''}:${s.checklist?.complete}`).join('|')

  useEffect(() => {
    let alive = true
    void Promise.all(p.stops.map(s => supabase.rpc('get_documentary_closure_history', { p_dispatch: p.dispatchId, p_request: s.request_id })
      .then(({ data }) => ((data || []) as HistoryEvent[]).map(e => ({ ...e, stop: s }))))).then(all => {
      if (alive) setHistory(all.flat().sort((a, b) => b.created_at.localeCompare(a.created_at)))
    })
    return () => { alive = false }
    // stopKey cambia cuando cambia el cierre de algún servicio
  }, [supabase, p.dispatchId, stopKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 1 · Guías y notas: guía del conductor (con su revisión), archivos y números vinculados, sin repetir números
  const rows: GuideRow[] = []
  for (const s of p.stops) {
    const own: GuideRow[] = []
    const add = (r: GuideRow) => {
      const same = r.number ? own.find(x => x.type === r.type && x.number?.toUpperCase() === r.number?.toUpperCase()) : undefined
      if (same) { same.doc = same.doc || r.doc; same.date = same.date || r.date; same.delivery = same.delivery || r.delivery
        if (same.status === 'PENDIENTE' && r.status !== 'PENDIENTE') same.status = r.status; return }
      own.push(r)
    }
    const delivery = p.deliveries.find(d => d.request_id === s.request_id)
    if (delivery?.guide_number) add({ key: `${s.request_id}/app`, stop: s, type: 'GUIA', number: delivery.guide_number, date: delivery.submitted_at, delivery,
      status: delivery.conformity === 'VALIDADA' ? 'VALIDADA' : ['OBSERVADA', 'RECHAZADA'].includes(delivery.conformity) ? 'OBSERVADA' : 'EN_VALIDACION' })
    for (const d of p.documents.filter(x => x.request_id === s.request_id && ['GUIA_REMISION', 'NOTA_DESPACHO'].includes(x.doc_type)))
      add({ key: d.id, stop: s, type: d.doc_type === 'GUIA_REMISION' ? 'GUIA' : 'NOTA', number: d.document_number, date: d.uploaded_at, doc: d, status: 'REGISTRADA' })
    for (const n of p.numberRefs.filter(x => x.request_id === s.request_id && ['GUIA_REMISION', 'NOTA_DESPACHO'].includes(x.doc_type)))
      add({ key: `${s.request_id}/${n.doc_type}/${n.document_number}`, stop: s, type: n.doc_type === 'GUIA_REMISION' ? 'GUIA' : 'NOTA', number: n.document_number, date: null, status: 'PENDIENTE' })
    const has = (t: 'GUIA' | 'NOTA') => own.some(r => r.type === t)
    if (p.executed) {
      if ((s.kind === 'ENTREGA' && !has('GUIA') && !has('NOTA')) || (s.kind === 'RECOJO' && !has('GUIA')))
        own.push({ key: `${s.request_id}/falta-gr`, stop: s, type: 'GUIA', number: null, date: null, status: 'FALTA' })
      if (s.kind === 'RECOJO_CLIENTE' && !has('NOTA')) own.push({ key: `${s.request_id}/falta-nd`, stop: s, type: 'NOTA', number: null, date: null, status: 'FALTA' })
    }
    rows.push(...own)
  }

  // 2 · Cierre documentario por servicio: requisitos según el tipo de servicio
  const requirements = (s: StopInfo): Requirement[] => {
    const c = s.checklist
    const docs = p.documents.filter(d => d.request_id === s.request_id)
    const routeDocs = p.documents.filter(d => !d.request_id)
    const delivery = p.deliveries.find(d => d.request_id === s.request_id)
    const gr = rows.find(r => r.stop.request_id === s.request_id && r.type === 'GUIA' && r.status === 'VALIDADA')
    const grAny = rows.find(r => r.stop.request_id === s.request_id && r.type === 'GUIA' && r.status !== 'FALTA')
    const nd = rows.find(r => r.stop.request_id === s.request_id && r.type === 'NOTA' && r.status !== 'FALTA' && (r.doc || c?.note))
    const packing = docs.find(d => d.doc_type === 'PACKING_LIST') || routeDocs.find(d => d.doc_type === 'PACKING_LIST')
    const evidence = docs.find(d => d.category === 'EVIDENCIA')
    const conformity = docs.find(d => d.category === 'CONFORMIDAD')
    const out: Requirement[] = []
    const ok = { label: '', tone: 'green' as const, icon: CheckCircle2 }
    if (s.kind === 'RECHAZO') {
      out.push({ key: 'rej-ev', title: 'Evidencia del rechazo', subtitle: 'Fotos del conductor', icon: ImageIcon, rule: 'Obligatorio', required: true, done: !!c?.rejection?.photos,
        state: c?.rejection?.photos ? { ...ok, label: `${c.rejection.photos} foto(s)` } : { label: 'Pendiente', tone: 'red', icon: AlertCircle }, view: delivery ? () => p.onEvidence(delivery) : undefined, note: 'Las sube el conductor desde el app.' })
      out.push({ key: 'rej-dec', title: 'Decisión de Despacho', subtitle: 'Reprogramar o anular', icon: FileText, rule: 'Obligatorio', required: true, done: !!c?.rejection?.decision,
        state: c?.rejection?.decision ? { ...ok, label: c.rejection.decision === 'REPROGRAMADA' ? 'Reprogramada' : 'Anulada' } : { label: 'Pendiente', tone: 'red', icon: AlertCircle }, note: 'Se registra en Torre de Control.' })
      return out
    }
    const deliveryDone = s.kind === 'RECOJO' ? !!gr : s.kind === 'RECOJO_CLIENTE' ? !!nd : !!gr || !!nd
    const grReviewing = !deliveryDone && grAny && grAny.status === 'EN_VALIDACION'
    const title = s.kind === 'RECOJO' ? 'Guía de Remisión' : s.kind === 'RECOJO_CLIENTE' ? 'Nota de Despacho' : 'Documento de entrega'
    out.push({ key: 'entrega', title, subtitle: s.kind === 'ENTREGA' || s.kind === 'TRASLADO' ? '(GR o Nota de Despacho)' : undefined, icon: FileText,
      rule: s.kind === 'TRASLADO' ? 'Opcional' : s.kind === 'ENTREGA' ? 'Obligatorio: al menos uno' : 'Obligatorio', required: s.kind !== 'TRASLADO', done: deliveryDone,
      state: gr && s.kind !== 'RECOJO_CLIENTE' ? { ...ok, label: 'Cumplido con GR' } : nd && s.kind !== 'RECOJO' ? { ...ok, label: 'Cumplido con Nota' }
        : grReviewing ? { label: 'GR por validar', tone: 'amber', icon: Clock } : s.kind === 'TRASLADO' ? { label: 'Sin archivo', tone: 'slate', icon: AlertCircle } : { label: 'Pendiente', tone: 'red', icon: AlertCircle },
      file: gr?.doc || nd?.doc || null, reference: (gr || nd || grAny)?.number || null, view: (gr || grAny)?.delivery && !(gr || nd)?.doc ? () => p.onEvidence((gr || grAny)!.delivery!) : undefined,
      upload: deliveryDone ? null : s.kind === 'RECOJO_CLIENTE' ? 'NOTA' : 'GUIA',
      note: s.kind === 'ENTREGA' ? 'Si existe GR validada, no exige Nota de Despacho.' : s.kind === 'RECOJO' ? 'La GR cuenta cuando el Supervisor de Transporte la valida.' : s.kind === 'RECOJO_CLIENTE' ? 'Nota de Despacho del recojo por el cliente.' : 'Documentos opcionales en punto a punto.' })
    if (s.kind !== 'RECOJO') out.push({ key: 'packing', title: 'Packing List', icon: FileText, rule: s.kind === 'ENTREGA' ? 'Obligatorio' : 'Opcional', required: s.kind === 'ENTREGA',
      done: !!c?.packing || !!packing, state: c?.packing || packing ? { ...ok, label: packing && !packing.request_id ? 'Consolidado' : 'Cargado' } : s.kind === 'ENTREGA' ? { label: 'Pendiente', tone: 'red', icon: AlertCircle } : { label: 'Sin archivo', tone: 'slate', icon: AlertCircle },
      file: packing || null, upload: 'PACKING', note: s.kind === 'ENTREGA' ? 'Requerido para cierre documentario.' : 'Documento opcional.' })
    if (s.kind === 'RECOJO' && c?.references.length) out.push({ key: 'ref', title: 'Orden de referencia', subtitle: '(OC, OS o RQ)', icon: FileText, rule: 'Opcional', required: false, done: true,
      state: { ...ok, label: 'Registrada' }, reference: c.references.join(', '), note: 'Sustento del recojo.' })
    out.push({ key: 'evidencia', title: 'Evidencia de entrega', icon: ImageIcon, rule: 'Opcional', required: false, done: !!evidence || !!delivery?.photos_count,
      state: evidence || delivery?.photos_count ? { ...ok, label: delivery?.photos_count ? `${delivery.photos_count} foto(s)` : 'Con archivo' } : { label: 'Sin archivo', tone: 'slate', icon: AlertCircle },
      file: evidence || null, view: !evidence && delivery?.photos_count ? () => p.onEvidence(delivery) : undefined, upload: 'EVIDENCIA', note: 'Fotos de entrega en destino.' })
    out.push({ key: 'conformidad', title: 'Conformidad del cliente', icon: FileText, rule: 'Opcional', required: false, done: !!conformity,
      state: conformity ? { ...ok, label: 'Con archivo' } : { label: 'Sin archivo', tone: 'slate', icon: AlertCircle }, file: conformity || null, upload: 'CONFORMIDAD', note: 'Documento opcional.' })
    return out
  }
  const reqByStop = p.stops.map(s => ({ stop: s, reqs: requirements(s) }))
  const mandatory = reqByStop.flatMap(x => x.reqs.filter(r => r.required))
  const done = mandatory.filter(r => r.done).length
  const pendingDocs = mandatory.length - done
  const incomplete = p.stops.filter(s => s.checklist && !s.checklist.complete)

  const uploadFiles = async (u: NonNullable<typeof upload>, number: string, files: File[]) => {
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user) throw new Error('Sesión vencida: vuelva a ingresar')
    if (u.kind === 'EVIDENCIA' || u.kind === 'CONFORMIDAD') {
      // Otro documento del servicio con su categoría (permitido también después de la salida)
      for (const file of files) {
        const mime = packingMime(file)
        if (!mime) throw new Error(`${file.name}: formato no permitido`)
        const path = `${p.dispatchId}/${crypto.randomUUID()}-${safeName(file.name)}`
        const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { contentType: mime })
        if (upErr) throw upErr
        const { data, error } = await supabase.rpc('register_dispatch_document', { p_dispatch_id: p.dispatchId, p_request_id: u.requestId, p_doc_type: 'OTRO', p_cargo_type: null,
          p_document_number: null, p_file_path: path, p_file_name: file.name, p_mime_type: mime, p_size_bytes: file.size, p_notes: null })
        if (error || !data?.success) { await supabase.storage.from(DOCS_BUCKET).remove([path]); throw new Error(error ? errorMessage(error) : data?.error) }
        if (data.id) await supabase.rpc('set_dispatch_document_category', { p_document_id: data.id, p_category: u.kind })
      }
      return
    }
    // Guía, Nota o Packing List del servicio: misma carga que la liquidación documentaria (settlement_upload_document)
    const evidence = u.kind === 'GUIA', bucket = evidence ? 'driver_evidence' : DOCS_BUCKET
    const paths: string[] = []
    try {
      for (const file of files) {
        const mime = evidence ? guideMime(file) : packingMime(file)
        if (!mime) throw new Error(`${file.name}: formato no permitido`)
        const path = evidence ? `${auth.user.id}/tercero/${p.dispatchId}/${crypto.randomUUID()}-${safeName(file.name)}` : `${p.dispatchId}/${crypto.randomUUID()}-${safeName(file.name)}`
        const { error } = await supabase.storage.from(bucket).upload(path, file, { contentType: mime })
        if (error) throw error
        paths.push(path)
      }
      const { data, error } = await supabase.rpc('settlement_upload_document', { p_dispatch: p.dispatchId, p_request: u.requestId, p_kind: u.kind,
        p_number: u.kind === 'PACKING' ? null : number, p_files: paths, p_file_names: files.map(f => f.name), p_operation: evidence ? crypto.randomUUID() : null })
      if (error) throw error
      if (!(data as { success?: boolean } | null)?.success) throw new Error('No se pudo registrar el documento')
    } catch (e) { if (paths.length) await supabase.storage.from(bucket).remove(paths); throw e }
  }
  const submitReason = async () => {
    if (!reasonFor || reason.trim().length < 10) return
    setBusy(true)
    try {
      const rpc = reasonFor.action === 'manual' ? 'settlement_mark_settled' : reasonFor.action === 'undo' ? 'settlement_undo_manual' : 'documentary_reopen'
      const { error } = await supabase.rpc(rpc, { p_dispatch: p.dispatchId, p_request: reasonFor.requestId, p_reason: reason.trim() })
      if (error) throw error
      toast.success(reasonFor.action === 'manual' ? 'Cierre documentario manual registrado' : reasonFor.action === 'undo' ? 'Cierre manual deshecho' : 'Cierre documentario reabierto')
      setReasonFor(null); setReason('')
      await p.onChanged()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-[#002855] hover:bg-slate-50'
  const iconBtn = 'grid h-9 w-9 place-items-center rounded-lg border border-slate-300 bg-white text-[#002855] hover:bg-slate-50'
  const canAct = p.canUpload && p.executed
  const vincular: TableAction[] = [
    { id: 'vincular', label: 'Vincular número de GR o Nota', onSelect: p.onToggleLinking },
    ...(canAct ? p.stops.flatMap(s => (['GUIA', 'NOTA', 'PACKING'] as UploadKind[]).map(k => ({ id: `${k}-${s.request_id}`, label: `Subir ${UPLOAD_LABEL[k]}${multi ? ` · ${s.ot} ${s.request_number}` : ''}`, onSelect: () => setUpload({ kind: k, requestId: s.request_id }) }))) : []),
  ]

  return <div className="space-y-5">
    {/* 1 · Guías de remisión y notas de despacho */}
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3"><SectionIcon icon={FileText} /><div>
          <h3 className="text-base font-bold text-[#002855]">1. Guías de remisión y notas de despacho</h3>
          <p className="text-sm text-slate-500">Documentos registrados para el cierre documentario de la ruta y cada servicio.</p></div></div>
        <div className="flex items-stretch overflow-hidden rounded-lg bg-blue-600 text-white">
          <button type="button" onClick={() => (canAct ? setUpload({ kind: p.stops[0]?.kind === 'RECOJO_CLIENTE' ? 'NOTA' : 'GUIA', requestId: p.stops[0]?.request_id }) : p.onToggleLinking())} disabled={!p.stops.length}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"><Plus className="h-4 w-4" />Vincular documento</button>
          <span className="border-l border-blue-400 [&_button]:h-full [&_button]:rounded-none [&_button]:border-0 [&_button]:bg-blue-600 [&_button]:text-white hover:[&_button]:bg-blue-700"><TableActions label="Más opciones de vinculación" actions={vincular} compact /></span>
        </div>
      </div>
      {p.showLinking && p.linking && <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3">{p.linking}</div>}
      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[60rem] text-sm">
          <thead className="bg-slate-50 text-left text-sm font-medium text-slate-600"><tr>
            <th className="w-10 px-3 py-2.5">#</th><th className="px-3 py-2.5">Tipo de documento</th><th className="px-3 py-2.5">Serie - Número</th><th className="px-3 py-2.5">Fecha</th>
            <th className="px-3 py-2.5">Servicio / OT</th><th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5">Archivo</th><th className="px-3 py-2.5">Acciones</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No hay guías ni notas registradas para esta ruta.</td></tr>}
            {rows.map((r, i) => {
              const st = ROW_STATUS[r.status], rule = docRule(r.stop.kind, r.type)
              const view = r.doc ? () => p.onOpen(r.doc!.file_path) : r.delivery ? () => p.onEvidence(r.delivery!) : null
              const more: TableAction[] = [
                ...(r.delivery ? [{ id: 'conf', label: 'Ver guía y conformidad', onSelect: () => p.onEvidence(r.delivery!) }] : []),
                ...(canAct ? [{ id: 'up', label: r.doc ? 'Subir nueva versión' : 'Subir archivo', onSelect: () => setUpload({ kind: r.type, requestId: r.stop.request_id, number: r.number || undefined }) }] : []),
                ...(r.doc && p.canVoid ? [{ id: 'void', label: 'Anular documento', tone: 'danger' as const, onSelect: () => p.onVoid(r.doc!.id) }] : []),
              ]
              return <tr key={r.key} className={r.status === 'FALTA' ? 'bg-red-50/30' : ''}>
                <td className="px-3 py-3 text-slate-600">{i + 1}</td>
                <td className="px-3 py-3"><span className="mr-2 text-slate-900">{r.type === 'GUIA' ? 'GR - Guía de Remisión' : 'Nota de Despacho'}</span><Tag tone={rule === 'Obligatorio' ? 'amber' : 'slate'}>{rule}</Tag></td>
                <td className="px-3 py-3 tabular-nums text-slate-900">{r.number ? r.number.replace('-', ' - ') : '—'}</td>
                <td className="px-3 py-3 text-slate-600">{fmtDay(r.date)}</td>
                <td className="px-3 py-3"><span className="text-slate-900">{r.stop.ot}</span><span className="block text-xs text-slate-500">{r.stop.request_number}</span></td>
                <td className="px-3 py-3"><Pill tone={st.tone} icon={st.icon}>{st.label}</Pill></td>
                <td className="px-3 py-3">{r.doc ? <div className="flex items-center gap-2"><PdfMark /><div className="min-w-0"><button type="button" onClick={() => p.onOpen(r.doc!.file_path)} className="block max-w-48 truncate text-blue-700 hover:underline">{r.doc.file_name || 'Archivo'}</button>
                  <span className="text-xs text-slate-500">{[fmtSize(r.doc.size), fmtDay(r.doc.uploaded_at)].filter(Boolean).join(' · ')}</span></div></div>
                  : r.delivery ? <span className="text-xs text-slate-500">Guía del conductor · {r.delivery.photos_count} foto(s)</span> : <span className="text-slate-400">—</span>}</td>
                <td className="px-3 py-3"><div className="flex items-center gap-2">
                  {view ? <><button type="button" onClick={view} className={btn}><Eye className="h-4 w-4" />{r.status === 'EN_VALIDACION' ? 'Validar' : 'Ver'}</button>
                    {r.doc && <button type="button" onClick={() => p.onOpen(r.doc!.file_path)} aria-label="Descargar" className={iconBtn}><Download className="h-4 w-4" /></button>}</>
                    : canAct ? <button type="button" onClick={() => setUpload({ kind: r.type, requestId: r.stop.request_id, number: r.number || undefined })} className={btn}><Upload className="h-4 w-4" />Subir archivo</button> : null}
                  {more.length > 0 && <TableActions label={`Más acciones de ${r.number || 'documento'}`} actions={more} compact />}
                </div></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
      <p className="flex items-start gap-3 rounded-xl border border-blue-200 bg-blue-50/60 px-4 py-3 text-sm leading-6 text-slate-700"><Info className="mt-1 h-4 w-4 shrink-0 text-blue-600" />
        <span>No se registra una guía de remisión o nota de despacho dos veces. Aquí se muestran los documentos realmente registrados para la ruta o servicio.<br />
          Para completar el cierre documentario se requiere como mínimo la Guía de Remisión (validada) o la Nota de Despacho, según el servicio.</span></p>
    </section>

    {/* 2 · Cierre documentario por servicio */}
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-start gap-3"><SectionIcon icon={Truck} /><div>
          <h3 className="text-base font-bold text-[#002855]">2. Cierre documentario por servicio</h3>
          <p className="text-sm text-slate-500">Valida los documentos obligatorios y el cumplimiento de la entrega.</p></div></div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-2 rounded-lg bg-emerald-50 px-3 py-2"><CheckCircle2 className="h-6 w-6 text-emerald-600" /><div><p className="text-sm font-semibold text-slate-900">{done} de {mandatory.length} obligatorios completos</p><p className="text-xs text-slate-500">Documentos requeridos</p></div></div>
          <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${pendingDocs ? 'bg-amber-50' : 'bg-slate-50'}`}><Clock className={`h-6 w-6 ${pendingDocs ? 'text-amber-600' : 'text-slate-400'}`} /><div><p className={`text-sm font-semibold ${pendingDocs ? 'text-amber-700' : 'text-slate-700'}`}>{pendingDocs ? `${pendingDocs} documento${pendingDocs === 1 ? '' : 's'} pendiente${pendingDocs === 1 ? '' : 's'}` : 'Sin pendientes'}</p><p className="text-xs text-slate-500">Para cierre documentario</p></div></div>
          {p.canManual && p.executed && incomplete.length > 0 && <button type="button" onClick={() => { setReasonFor({ action: 'manual', requestId: incomplete[0].request_id }); setReason('') }}
            className="inline-flex items-center gap-2 rounded-lg border border-emerald-600 bg-white px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"><CheckCircle2 className="h-4 w-4" />Cerrar manualmente</button>}
        </div>
      </div>
      {reqByStop.map(({ stop: s, reqs }) => {
        const isOpen = open[s.request_id] ?? (!multi || !!(s.checklist && !s.checklist.complete))
        const doc = s.checklist?.documentary
        return <div key={s.request_id} className="overflow-hidden rounded-xl border border-slate-200">
          <div className="flex flex-wrap items-center gap-2 bg-white px-4 py-3">
            <button type="button" onClick={() => setOpen(o => ({ ...o, [s.request_id]: !isOpen }))} aria-expanded={isOpen} className="flex items-center gap-3 text-left">
              <ChevronDown className={`h-4 w-4 text-[#002855] transition-transform ${isOpen ? '' : '-rotate-90'}`} />
              <span className="text-base"><b className="text-[#002855]">{s.ot} - {s.request_number}</b><span className="text-slate-700"> · {s.client || 'Sin cliente'}</span></span></button>
            <span className="ml-auto flex flex-wrap items-center gap-2">{doc && <DocumentaryBadge closure={doc} compact />}
              {p.canManual && s.checklist?.manual && <button type="button" onClick={() => { setReasonFor({ action: 'undo', requestId: s.request_id }); setReason('') }} className="text-xs font-semibold text-slate-600 hover:underline">Deshacer cierre manual</button>}
              {p.canManual && doc?.status === 'COMPLETO' && <button type="button" onClick={() => { setReasonFor({ action: 'reopen', requestId: s.request_id }); setReason('') }} className="text-xs font-semibold text-red-700 hover:underline">Reabrir</button>}</span>
          </div>
          {isOpen && <div className="overflow-x-auto border-t border-slate-100">
            <table className="w-full min-w-[58rem] text-sm">
              <thead className="bg-slate-50 text-left text-sm font-medium text-slate-600"><tr>
                <th className="px-4 py-2.5">Documento requerido</th><th className="px-3 py-2.5">Regla</th><th className="px-3 py-2.5">Cumplimiento</th><th className="px-3 py-2.5">Archivo / referencia</th><th className="px-3 py-2.5">Acción</th><th className="px-3 py-2.5">Observación</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {reqs.map(r => <tr key={r.key}>
                  <td className="px-4 py-3"><div className="flex items-center gap-3"><r.icon className="h-5 w-5 shrink-0 text-blue-700" /><div><p className="text-slate-900">{r.title}</p>{r.subtitle && <p className="text-xs text-slate-500">{r.subtitle}</p>}</div></div></td>
                  <td className="px-3 py-3"><Tag tone={r.required ? 'amber' : 'slate'}>{r.rule}</Tag></td>
                  <td className="px-3 py-3"><Pill tone={r.state.tone} icon={r.state.icon}>{r.state.label}</Pill></td>
                  <td className="px-3 py-3">{r.file ? <div className="flex items-center gap-2"><PdfMark /><div className="min-w-0"><button type="button" onClick={() => p.onOpen(r.file!.file_path)} className="block max-w-48 truncate text-blue-700 hover:underline">{r.file.file_name || 'Archivo'}</button>{fmtSize(r.file.size) && <span className="text-xs text-slate-500">{fmtSize(r.file.size)}</span>}</div></div>
                    : r.reference ? <span className="tabular-nums text-slate-800">{r.reference}</span> : <span className="text-slate-500">{r.required ? 'No registrado' : '—'}</span>}</td>
                  <td className="px-3 py-3"><div className="flex items-center gap-2">
                    {r.file ? <><button type="button" onClick={() => p.onOpen(r.file!.file_path)} className={btn}><Eye className="h-4 w-4" />Ver</button><button type="button" onClick={() => p.onOpen(r.file!.file_path)} aria-label="Descargar" className={iconBtn}><Download className="h-4 w-4" /></button></>
                      : r.view ? <button type="button" onClick={r.view} className={btn}><Eye className="h-4 w-4" />Ver</button>
                      : r.upload && canAct ? <button type="button" onClick={() => setUpload({ kind: r.upload!, requestId: s.request_id })} className={btn}><Upload className="h-4 w-4" />Subir archivo</button> : <span className="text-slate-400">—</span>}
                  </div></td>
                  <td className="px-3 py-3 text-slate-600">{r.note}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </div>
      })}
      <div className="overflow-hidden rounded-xl border border-slate-200">
        <h4 className="flex items-center gap-2 px-4 py-3 text-base font-bold text-[#002855]"><History className="h-5 w-5" />Historial del cierre documentario</h4>
        <div className="overflow-x-auto"><table className="w-full min-w-[46rem] text-sm">
          <thead className="bg-slate-50 text-left text-sm font-medium text-slate-600"><tr><th className="px-4 py-2">Fecha</th><th className="px-3 py-2">Usuario</th><th className="px-3 py-2">Acción</th><th className="px-3 py-2">Detalle</th></tr></thead>
          <tbody className="divide-y divide-slate-100">
            {history === null && <tr><td colSpan={4} className="px-4 py-4 text-center"><Loader2 className="mx-auto h-4 w-4 animate-spin text-slate-400" /></td></tr>}
            {history?.length === 0 && <tr><td colSpan={4} className="px-4 py-4 text-center text-slate-500">Sin movimientos registrados.</td></tr>}
            {history?.map(e => <tr key={e.id}>
              <td className="px-4 py-2 tabular-nums text-slate-700">{fmtWhen(e.created_at)}</td>
              <td className="px-3 py-2 text-slate-700">{e.actor || (e.details?.carga_inicial ? 'Carga inicial' : 'Sistema')}</td>
              <td className="px-3 py-2 text-slate-800">{HISTORY_ACTION[e.action] || e.action}</td>
              <td className="px-3 py-2 text-slate-600">{multi ? `${e.stop.ot} ${e.stop.request_number} · ` : ''}{e.previous_status ? `${DOCUMENTARY_LABEL[e.previous_status]} → ` : ''}{DOCUMENTARY_LABEL[e.new_status]}{e.reason ? ` · ${e.reason}` : ''}</td>
            </tr>)}
          </tbody>
        </table></div>
      </div>
    </section>

    {upload && <UploadDialog upload={upload} stops={p.stops} onClose={() => setUpload(null)} onSubmit={async (u, number, files) => { await uploadFiles(u, number, files); await p.onChanged() }} />}
    {reasonFor && <Modal isOpen onClose={() => setReasonFor(null)} title={reasonFor.action === 'manual' ? 'Cerrar manualmente el cierre documentario' : reasonFor.action === 'undo' ? 'Deshacer cierre manual' : 'Reabrir cierre documentario'} maxWidth="max-w-lg"
      footer={<div className="flex justify-end gap-2"><button type="button" onClick={() => setReasonFor(null)} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold">Cancelar</button>
        <button type="button" onClick={() => void submitReason()} disabled={busy || reason.trim().length < 10} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-40">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Confirmar</button></div>}>
      <div className="space-y-3 text-sm">
        {reasonFor.action === 'manual' && incomplete.length > 1 && <label className="block text-slate-700">Servicio<select value={reasonFor.requestId} onChange={e => setReasonFor({ ...reasonFor, requestId: e.target.value })} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2">
          {incomplete.map(s => <option key={s.request_id} value={s.request_id}>{s.ot} · {s.request_number}</option>)}</select></label>}
        {reasonFor.action === 'manual' && (() => { const c = p.stops.find(s => s.request_id === reasonFor.requestId)?.checklist; return c?.missing.length ? <p className="rounded-lg bg-amber-50 p-2 text-amber-800">Falta: {c.missing.join(' · ').replace(/_/g, ' ').toLowerCase()}</p> : null })()}
        <label className="block text-slate-700">Motivo (queda en el historial)<textarea value={reason} onChange={e => setReason(e.target.value)} rows={3} maxLength={500} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2" placeholder="Mínimo 10 caracteres" /></label>
      </div>
    </Modal>}
  </div>
}

function UploadDialog({ upload, stops, onClose, onSubmit }: {
  upload: { kind: UploadKind; requestId: string; number?: string }; stops: StopInfo[]; onClose: () => void
  onSubmit: (u: { kind: UploadKind; requestId: string }, number: string, files: File[]) => Promise<void>
}) {
  const [kind, setKind] = useState(upload.kind)
  const [requestId, setRequestId] = useState(upload.requestId)
  const [number, setNumber] = useState(upload.number || '')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const rule = NUMBER_RULE[kind]
  const normalized = number.trim().toUpperCase()
  const valid = !rule || rule.pattern.test(normalized)
  const accept = kind === 'GUIA' ? '.pdf,.jpg,.jpeg,.png,.webp' : '.pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx'
  const submit = async () => {
    if (!valid || !files.length) return
    const big = files.find(f => f.size > 10 * 1024 * 1024)
    if (big) { toast.error(`${big.name} supera 10 MB`); return }
    setBusy(true)
    try { await onSubmit({ kind, requestId }, normalized, files); toast.success(`${UPLOAD_LABEL[kind]} cargada${kind === 'GUIA' ? ': pasa a validación del Supervisor de Transporte' : ''}`); onClose() }
    catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return <Modal isOpen onClose={onClose} title={`Subir ${UPLOAD_LABEL[kind]}`} maxWidth="max-w-lg"
    footer={<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold">Cancelar</button>
      <button type="button" onClick={() => void submit()} disabled={busy || !valid || !files.length} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-40">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}Subir</button></div>}>
    <div className="space-y-3 text-sm">
      <label className="block text-slate-700">Documento<select value={kind} onChange={e => { setKind(e.target.value as UploadKind); setNumber('') }} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2">
        {(Object.keys(UPLOAD_LABEL) as UploadKind[]).map(k => <option key={k} value={k}>{UPLOAD_LABEL[k]}</option>)}</select></label>
      {stops.length > 1 && <label className="block text-slate-700">Servicio<select value={requestId} onChange={e => setRequestId(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 px-3 py-2">
        {stops.map(s => <option key={s.request_id} value={s.request_id}>{s.ot} · {s.request_number}</option>)}</select></label>}
      {rule && <label className="block text-slate-700">Serie y número<input value={number} onChange={e => setNumber(e.target.value.toUpperCase().replace(/\s+/g, ''))} placeholder={rule.example}
        className={`mt-1 block w-full rounded-lg border px-3 py-2 font-mono ${number && !valid ? 'border-red-400' : 'border-slate-300'}`} />
        {number && !valid && <span className="text-xs text-red-700">Formato: serie y correlativo separados por guion (ej. {rule.example}).</span>}</label>}
      <label className="block text-slate-700">Archivo{kind === 'GUIA' ? ' (foto o PDF)' : ''} · máximo 10 MB, hasta 5
        <input type="file" multiple accept={accept} onChange={e => { setFiles(Array.from(e.target.files || []).slice(0, 5)); e.target.value = '' }} className="mt-1 block w-full text-xs" /></label>
      {files.length > 0 && <ul className="space-y-1 text-xs">{files.map(f => <li key={f.name + f.size} className="flex items-center gap-2"><FileText className="h-3.5 w-3.5 text-slate-500" /><span className="flex-1 truncate">{f.name}</span>
        <button type="button" onClick={() => setFiles(fs => fs.filter(x => x !== f))} aria-label={`Quitar ${f.name}`} className="text-slate-500 hover:text-red-700"><Trash2 className="h-3.5 w-3.5" /></button></li>)}</ul>}
      {kind === 'GUIA' && <p className="text-xs text-slate-500">La GR cuenta para el cierre cuando el Supervisor de Transporte la valida en Conformidad.</p>}
    </div>
  </Modal>
}

