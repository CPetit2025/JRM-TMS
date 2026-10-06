'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Clock, FileCheck2, FileSpreadsheet, FileText, ListTree, Loader2, RefreshCw, Trash2, Truck, Upload } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { GuiaDetalleModal } from '@/components/guias/GuiaDetalleModal'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { DeliveryReview, type DeliveryReviewTarget } from '@/components/delivery/DeliveryReview'
import { conformityLabels, type DeliveryRow } from '@/lib/delivery'
import { DOCS_BUCKET, errorMessage, fmtDate, receiptUrl } from '@/lib/caja'

// Asistente: Packing List firmado por el auditor y Nota de Despacho en recojos.
// La guía de entrega obligatoria procede del app/proveedor; solo Transporte valida la conformidad.

type Stop = { request_id: string; request_number: string; sequence: number | null; delivery: string; cargo: string | null; client: string | null }
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
  const supabase = useMemo(() => createClient(), [])
  const { canWrite, isLoaded } = usePermissions()
  const canEdit = canWrite('documentario')
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [filter, setFilter] = useState<'TODOS' | 'PENDIENTE' | 'REEMISION' | 'LISTO'>('TODOS')
  const [showDeparted, setShowDeparted] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const [reload, setReload] = useState(0)
  const [anulando, setAnulando] = useState<Doc | null>(null)
  const [deliveries, setDeliveries] = useState<DeliveryRow[]>([])
  const [review, setReview] = useState<DeliveryReviewTarget | null>(null)
  const load = useCallback(async () => { setReload(n => n + 1) }, [])

  useEffect(() => {
    let cancel = false
    const run = async () => {
      const { data, error } = await supabase.rpc('get_documentary_queue', { p_include_departed: showDeparted })
      if (cancel) return
      if (error) toast.error(errorMessage(error))
      const list = error ? [] : (data || []) as QueueItem[]
      setItems(list)
      const rows: DeliveryRow[] = []
      for (let offset = 0; offset < list.length; offset += 100) {
        const { data: result, error } = await supabase.rpc('delivery_tracking_rows', { p_dispatches: list.slice(offset, offset + 100).map(i => i.id) })
        if (cancel) return
        if (error) { toast.error('No se pudo consultar la conformidad de guías: ' + errorMessage(error)); break }
        rows.push(...((result || []) as DeliveryRow[]))
      }
      if (!cancel) setDeliveries(rows)

    }
    void run()
    const timer = window.setInterval(() => void run(), 30000)
    return () => { cancel = true; window.clearInterval(timer) }
  }, [supabase, showDeparted, reload])

  const counts = useMemo(() => {
    const c = { PENDIENTE: 0, REEMISION: 0, LISTO: 0 }
    ;(items || []).forEach(i => { if (i.doc_status in c) c[i.doc_status as keyof typeof c]++ })
    return c
  }, [items])
  const visible = (items || []).filter(i => filter === 'TODOS' || i.doc_status === filter)

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
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><FileText className="w-6 h-6 text-blue-600" />Documentos de Despacho</h1>
          <p className="text-sm text-slate-500">Packing List firmado por el auditor de despacho y seguimiento de guías de entrega. Ordenado por hora de salida.</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-600 flex items-center gap-1.5">
            <input type="checkbox" checked={showDeparted} onChange={e => setShowDeparted(e.target.checked)} />Ver los que ya salieron (7 días)
          </label>
          <button onClick={() => { setItems(null); void load() }} className="p-2 rounded-lg border hover:bg-slate-50" title="Actualizar"><RefreshCw className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="grid gap-3 rounded-xl border border-blue-100 bg-blue-50/60 p-4 text-sm md:grid-cols-3">
        <div><p className="font-semibold text-[#002855]">1. Asistente Documentario</p><p className="mt-1 text-xs leading-5 text-slate-600">Carga el Packing List firmado por el auditor y confirma los documentos antes de la salida. En recojos, adjunta también la Nota de Despacho.</p></div>
        <div><p className="font-semibold text-[#002855]">2. Conductor o proveedor</p><p className="mt-1 text-xs leading-5 text-slate-600">Después de entregar, sube obligatoriamente la guía firmada: conductor desde el app; proveedor contratado desde el portal de transportistas.</p></div>
        <div><p className="font-semibold text-[#002855]">3. Supervisor de Transporte</p><p className="mt-1 text-xs leading-5 text-slate-600">Aprueba, observa o rechaza la guía. El servicio no avanza mientras falte el sustento o su aprobación.</p></div>
      </div>
      <div className="flex flex-wrap gap-2">
        {([['TODOS', 'Todos'], ['PENDIENTE', `Pendientes (${counts.PENDIENTE})`], ['REEMISION', `Reemisión (${counts.REEMISION})`], ['LISTO', `Listos (${counts.LISTO})`]] as const).map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className={`px-3 py-1.5 rounded-full text-sm border ${filter === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 hover:bg-slate-50'}`}>{l}</button>
        ))}
      </div>

      {isLoaded && !canEdit && (
        <p className="text-sm text-slate-500 bg-slate-50 border rounded-lg p-3">Vista de consulta: el Asistente Documentario carga y confirma el Packing List firmado. La validación de guías corresponde al Supervisor de Transporte.</p>
      )}

      {items === null ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        : visible.length === 0 ? <p className="text-slate-400 text-sm p-6 text-center border rounded-xl bg-white">No hay despachos en esta bandeja.</p>
        : visible.map(item => (
          <DispatchCard key={item.id} item={item} canEdit={canEdit && item.status === 'PROGRAMADO'} busy={busy === item.id}
            onConfirm={() => confirmDocs(item)} onVoid={voidDoc} onOpen={openDoc} onUploaded={load}
            deliveries={deliveries.filter(r => r.dispatch_id === item.id)} onEvidence={setReview} />
        ))}
      <DeliveryReview row={review} onClose={() => setReview(null)} onChanged={() => void load()} />
      {anulando && <AnularModal doc={anulando} onClose={() => setAnulando(null)} onDone={() => { setAnulando(null); void load() }} />}
    </div>
  )
}

function DispatchCard({ item, canEdit, busy, onConfirm, onVoid, onOpen, onUploaded, deliveries, onEvidence }: {
  item: QueueItem; canEdit: boolean; busy: boolean; onConfirm: () => void; onVoid: (d: Doc) => void
  onOpen: (p: string) => void; onUploaded: () => Promise<void>; deliveries: DeliveryRow[]; onEvidence: (row: DeliveryReviewTarget) => void
}) {
  const h = hoursLeft(item.scheduled_departure)
  const urgent = item.doc_status !== 'LISTO' && item.doc_status !== 'SALIO' && h !== null && h < 2
  const badge = STATUS_BADGE[item.doc_status]
  const generalDocs = item.documents.filter(d => !d.request_id)

  return (
    <div className={`bg-white rounded-xl border shadow-sm ${urgent ? 'border-red-400 ring-1 ring-red-200' : ''}`}>
      <div className="p-4 border-b flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-slate-800">{item.dispatch_number}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full border font-semibold ${badge.cls}`}>{badge.label}</span>
            {item.is_pickup && <span className="text-xs px-2 py-0.5 rounded-full border bg-violet-50 text-violet-700 border-violet-200">Recojo del cliente</span>}
          </div>
          <div className="text-sm text-slate-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
            <span className="flex items-center gap-1"><Truck className="w-3.5 h-3.5" />{item.is_pickup ? 'Unidad del cliente' : `${item.vehicle_plate || '—'} · ${item.driver_name || 'Sin conductor'}`}</span>
            <span className={`flex items-center gap-1 ${urgent ? 'text-red-600 font-semibold' : ''}`}>
              <Clock className="w-3.5 h-3.5" />Salida {fmtDate(item.scheduled_departure, true)}
              {h !== null && item.doc_status !== 'SALIO' && (h < 0 ? ' · atrasado' : ` · en ${h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${h.toFixed(1)} h`}`)}
            </span>
          </div>
          {item.docs_reissue && (
            <p className="mt-2 text-sm text-red-700 flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" />Reemitir: {item.docs_reissue_reason || 'cambió el despacho'}</p>
          )}
          {item.docs_ready_at && !item.docs_reissue && (
            <p className="mt-2 text-xs text-emerald-700">Confirmado por {item.docs_ready_by_name || '—'} · {fmtDate(item.docs_ready_at, true)}</p>
          )}
        </div>
        {canEdit && (item.doc_status === 'PENDIENTE' || item.doc_status === 'REEMISION') && (
          <button onClick={onConfirm} disabled={busy}
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}Confirmar Packing List y documentos
          </button>
        )}
      </div>

      <div className="divide-y">
        {item.stops.map((s, i) => {
          const docs = item.documents.filter(d => d.request_id === s.request_id)
          return (
            <div key={s.request_id} className="p-4">
              <div className="text-sm font-semibold text-slate-700">Parada {s.sequence || i + 1} · {s.request_number}</div>
              <div className="text-xs text-slate-500">{[s.client, s.delivery, s.cargo].filter(Boolean).join(' · ')}</div>
              <DocList docs={docs} canEdit={canEdit} onVoid={onVoid} onOpen={onOpen} />
              {canEdit && <UploadForm dispatchId={item.id} requestId={s.request_id} isPickup={item.is_pickup} onUploaded={onUploaded} />}
            </div>
          )
        })}
        <div className="p-4 bg-slate-50/60 rounded-b-xl">
          <div className="text-sm font-semibold text-slate-700">Documentos generales del despacho</div>
          <div className="text-xs text-slate-500">Un Packing List consolidado firmado cubre todas las paradas. También puedes adjuntarlo por parada; debe estar firmado por el auditor.</div>
          <DocList docs={generalDocs} canEdit={canEdit} onVoid={onVoid} onOpen={onOpen} />
          {canEdit && <UploadForm dispatchId={item.id} requestId={null} isPickup={item.is_pickup} onUploaded={onUploaded} />}
        </div>
        <div className="space-y-3 p-4"><p className="flex items-center gap-2 text-sm font-semibold text-[#002855]"><FileCheck2 className="h-4 w-4" />Guías firmadas de entrega · obligatorias</p><p className="text-xs leading-5 text-slate-500">Responsable: {item.is_pickup ? 'cliente que retira · se conserva la Nota de Despacho' : item.modalidad === 'TERCERO' ? 'proveedor contratado por JRM, desde su portal' : 'conductor asignado, desde el app'}. El asistente consulta el sustento; el Supervisor de Transporte valida.</p>
          {!deliveries.length ? <p className="text-xs text-slate-500">Conformidad no disponible. Actualiza la bandeja para consultar.</p> : deliveries.map(row => <div key={row.request_id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"><div><p className="font-semibold">{row.request_number} · OT {row.ot_code}</p><p className="mt-1 text-xs text-slate-600">{conformityLabels[row.conformity]}{row.guide_number ? ` · Guía ${row.guide_number}` : ''}{row.photos_count > 0 ? ` · ${row.photos_count} foto(s)` : ''}</p></div><button onClick={() => onEvidence(row)} className="min-h-10 rounded-lg border px-3 text-xs font-semibold text-blue-700">Consultar sustento y validación</button></div>)}
        </div>
      </div>
    </div>
  )
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
  if (docs.length === 0) return <p className="text-xs text-slate-400 mt-2">Sin documentos cargados.</p>
  return (
    <>
    <GuiaDetalleModal key={guia || 'none'} guias={guia} onClose={() => setGuia(null)} />
    <ul className="mt-2 space-y-1">
      {docs.map(d => (
        <li key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
          {isSheetName(d.file_name || d.file_path) ? <FileSpreadsheet className="w-4 h-4 text-emerald-600" /> : <FileText className="w-4 h-4 text-blue-600" />}
          <button onClick={() => onOpen(d.file_path)} className="text-blue-700 hover:underline font-medium">
            {DOC_LABEL[d.doc_type]}{d.document_number ? ` ${d.document_number}` : ''}
          </button>
          {d.doc_type === 'GUIA_REMISION' && d.document_number && (
            <button type="button" onClick={() => setGuia(d.document_number)} title="Ver los SKUs de la guía (SALIDA del ERP)"
              className="inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[11px] font-semibold text-blue-700 hover:bg-blue-100">
              <ListTree className="w-3 h-3" /> SKUs
            </button>
          )}
          {d.doc_type === 'PACKING_LIST' && <span className={`text-xs ${d.signed ? 'text-emerald-700' : 'text-amber-700'}`}>{d.signed ? `Firmado por ${d.auditor_name} · ${d.auditor_signed_date}` : 'Documento anterior: firma del auditor pendiente de registrar'}</span>}
          {d.cargo_type && <span className="text-xs text-slate-500">({CARGO_LABEL[d.cargo_type] || d.cargo_type})</span>}
          <span className="text-xs text-slate-400">{d.uploaded_by || '—'} · {fmtDate(d.uploaded_at, true)}</span>
          {canEdit && <button onClick={() => onVoid(d)} className="text-slate-400 hover:text-red-600" title="Anular"><Trash2 className="w-3.5 h-3.5" /></button>}
        </li>
      ))}
    </ul>
    </>
  )
}

function UploadForm({ dispatchId, requestId, isPickup, onUploaded }: {
  dispatchId: string; requestId: string | null; isPickup: boolean; onUploaded: () => Promise<void>
}) {
  const supabase = useMemo(() => createClient(), [])
  const types = requestId && isPickup ? ['PACKING_LIST', 'NOTA_DESPACHO', 'OTRO'] : ['PACKING_LIST', 'OTRO']
  const [docType, setDocType] = useState(types[0])
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
    if (!file) { toast.error('Seleccione el archivo'); return }
    if (file.size > 15 * 1024 * 1024) { toast.error('El archivo supera 15 MB'); return }
    if (packing && (!auditor.trim() || !signedDate || !signature)) { toast.error('Indique auditor, fecha y confirme que el Packing List contiene su firma'); return }
    if (needsNumber && !number.trim()) { toast.error('Indique la serie y número'); return }
    const sheet = isSheetName(file.name)
    if (!(file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) && !(allowSheet && sheet) && !(packing && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type))) {
      toast.error(packing ? 'Adjunte el Packing List firmado en PDF o foto; un Excel no acredita la firma.' : allowSheet ? 'Cargue un PDF o un Excel' : 'La Nota de Despacho se carga en PDF'); return
    }
    const mime = packing && file.type.startsWith('image/') ? file.type : sheet ? sheetMime(file.name) : 'application/pdf'
    const path = `${dispatchId}/${crypto.randomUUID()}-${file.name.replace(/[^\w.-]+/g, '_').slice(-80)}`
    setSaving(true)
    try {
      const { error: upErr } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { contentType: mime })
      if (upErr) throw upErr
      const { data, error } = packing ? await supabase.rpc('register_signed_packing_list', {
        p_dispatch_id: dispatchId, p_request_id: requestId, p_file_path: path, p_file_name: file.name,
        p_mime_type: mime, p_size_bytes: file.size, p_auditor: auditor.trim(), p_signed_date: signedDate, p_signature_confirmed: signature,
      }) : await supabase.rpc('register_dispatch_document', {
        p_dispatch_id: dispatchId, p_request_id: requestId, p_doc_type: docType, p_cargo_type: null,
        p_document_number: number.trim() || null, p_file_path: path, p_file_name: file.name,
        p_mime_type: mime, p_size_bytes: file.size, p_notes: null,
      })
      if (error || !data?.success) {
        // El archivo sin registro no sirve: se retira para no dejar huérfanos
        await supabase.storage.from(DOCS_BUCKET).remove([path])
        throw new Error(error ? errorMessage(error) : data?.error)
      }
      toast.success(`${DOC_LABEL[docType]} cargado`)
      setNumber(''); setFile(null); setSignature(false); setInputKey(k => k + 1)
      await onUploaded()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(false) }
  }

  return (
    <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <select value={docType} onChange={e => setDocType(e.target.value)} className="border rounded-lg px-2 py-1.5 bg-white">
        {types.map(t => <option key={t} value={t}>{DOC_LABEL[t]}</option>)}
      </select>
      {packing && <div className="grid w-full gap-3 sm:grid-cols-2"><label className="text-xs text-slate-600">Auditor firmante *<input value={auditor} maxLength={120} onChange={e => setAuditor(e.target.value)} placeholder="Nombre del auditor de despacho" className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="text-xs text-slate-600">Fecha de firma *<input type="date" value={signedDate} max={today} onChange={e => setSignedDate(e.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2 text-sm" /></label><label className="flex items-start gap-2 text-xs leading-5 text-slate-600 sm:col-span-2"><input type="checkbox" checked={signature} onChange={e => setSignature(e.target.checked)} className="mt-1" />Confirmo que el archivo adjunto es legible y contiene la firma del auditor de despacho. Se acepta PDF o foto del documento firmado.</label></div>}
      <input value={number} onChange={e => setNumber(e.target.value)} placeholder={needsNumber ? 'Serie-número (T001-000123)' : 'N° (opcional)'}
        className="border rounded-lg px-2 py-1.5 w-48" />
      <input key={inputKey} type="file" accept={packing ? '.pdf,image/jpeg,image/png,image/webp' : allowSheet ? '.pdf,.xlsx,.xls,.csv' : '.pdf'} onChange={e => setFile(e.target.files?.[0] || null)}
        className="text-xs max-w-[220px]" />
      <button onClick={submit} disabled={saving}
        className="px-3 py-1.5 rounded-lg bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5">
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}Subir
      </button>
    </div>
  )
}
