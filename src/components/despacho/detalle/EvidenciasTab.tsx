'use client'
import { useMemo, useRef, useState } from 'react'
import { Ban, CalendarDays, Camera, ChevronLeft, ChevronRight, Download, FileText, Images, Loader2, MapPin, Maximize2, Plus, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { districtOf } from '@/lib/address'
import type { DeliveryRow } from '@/lib/delivery'
import { EVIDENCE_GROUPS, EVIDENCE_MAX_MB, EVIDENCE_STAGES, EVIDENCE_TYPES, detailTime, downloadUrl, evidenceItems, isImage, isPdfFile,
  type DetailEvidence, type DispatchFiles, type EvidenceGroup, type EvidenceStage, type RouteEvidence } from '@/lib/dispatch-detail'
import { zipFiles, zipName } from '@/lib/zip'
import { DetailCard, ServiceStrip, SourcesWarning, Img } from './DetailParts'

const TONE: Record<EvidenceGroup, string> = {
  RECOJO: 'bg-blue-50 text-jrm-navy', TRANSITO: 'bg-sky-50 text-sky-800', LLEGADA: 'bg-emerald-50 text-emerald-800', DESCARGA: 'bg-emerald-50 text-emerald-800',
  DOCUMENTO: 'bg-violet-50 text-violet-800', UNIDAD: 'bg-slate-100 text-slate-700', INCIDENCIA: 'bg-rose-50 text-rose-800', GASTO: 'bg-amber-50 text-amber-900', OTRO: 'bg-slate-100 text-slate-700',
}
// Etapas operativas siempre visibles (como en el bosquejo, aunque tengan 0); las demás fuentes solo si hay evidencias
const STAGE_FILTERS: EvidenceGroup[] = ['RECOJO', 'TRANSITO', 'LLEGADA', 'DESCARGA', 'INCIDENCIA']
const ext = (path: string, mime?: string | null) => (path.match(/\.(\w{2,5})(?:$|\?)/)?.[1] || (mime === 'application/pdf' ? 'pdf' : 'jpg')).toLowerCase()

/** Fotos y evidencias de la parada por etapa real; se agregan con etapa y se anulan con motivo (no se borran). */
export function EvidenciasTab({ row, files, route, urls, servicesCount, onChanged }: {
  row: DeliveryRow; files: DispatchFiles; route: RouteEvidence[]; urls: Record<string, string | null>; servicesCount: number; onChanged: () => void
}) {
  const db = useMemo(() => createClient(), [])
  const all = evidenceItems(files, route, { pickup: districtOf(row.pickup_address) || row.pickup_address, delivery: districtOf(row.delivery_address) || row.delivery_address })
  const [group, setGroup] = useState<EvidenceGroup | ''>(''), [index, setIndex] = useState(0), [adding, setAdding] = useState(false), [zipping, setZipping] = useState(false)
  const shown = all.filter(e => !group || e.group === group), current = shown[Math.min(index, shown.length - 1)], pos = current ? shown.indexOf(current) : -1
  const filters = [...STAGE_FILTERS, ...(Object.keys(EVIDENCE_GROUPS) as EvidenceGroup[]).filter(g => !STAGE_FILTERS.includes(g) && all.some(e => e.group === g))]
  const count = (g: EvidenceGroup) => all.filter(e => e.group === g).length

  const downloadAll = async () => {
    setZipping(true)
    try {
      const used = new Set<string>(), items = await Promise.all(all.filter(e => urls[e.path]).map(async (e, i) => {
        const res = await fetch(urls[e.path]!); if (!res.ok) throw new Error(e.label)
        return { name: zipName(`${String(i + 1).padStart(2, '0')}-${EVIDENCE_GROUPS[e.group]}-${e.label}`, ext(e.path, e.mime), used), data: new Uint8Array(await res.arrayBuffer()), date: e.at ? new Date(e.at) : undefined }
      }))
      if (!items.length) { toast.error('No hay evidencias disponibles para descargar.'); return }
      const a = document.createElement('a'); a.href = URL.createObjectURL(zipFiles(items)); a.download = `evidencias-despacho-${row.dispatch_number || row.dispatch_id}-${row.request_number}.zip`
      a.click(); window.setTimeout(() => URL.revokeObjectURL(a.href), 10000)
    } catch (e) { toast.error(`No se pudo descargar ${e instanceof Error ? e.message : 'una evidencia'}. Intente nuevamente.`) } finally { setZipping(false) }
  }
  const voidEvidence = async (e: DetailEvidence) => {
    const reason = window.prompt(`Motivo para anular «${e.label}» (mínimo 10 caracteres). La evidencia queda registrada como anulada:`)
    if (!reason?.trim()) return
    const { data, error } = await db.rpc('void_dispatch_evidence', { p_id: e.evidenceId, p_reason: reason.trim() })
    if (error || !data?.success) { toast.error(error?.message || data?.error || 'No se pudo anular la evidencia'); return }
    toast.success('Evidencia anulada'); setIndex(0); onChanged()
  }

  return <div className="grid items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.75fr)_minmax(22rem,1fr)]">
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <SourcesWarning failed={files.sources_failed} />
      <ServiceStrip row={row} icon={<Images />} />
      <DetailCard title={`Fotos y evidencias (${all.length})`} icon={<Camera />} actions={<div className="flex flex-wrap gap-2">
        {files.can_add_evidence && <button type="button" onClick={() => setAdding(true)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50"><Plus className="h-4 w-4" aria-hidden />Agregar evidencia</button>}
        <button type="button" onClick={() => void downloadAll()} disabled={zipping || !all.some(e => urls[e.path])} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50 disabled:opacity-50">
          {zipping ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />}Descargar todas</button>
      </div>}>
        <div role="group" aria-label="Filtrar evidencias" className="mb-4 flex flex-wrap gap-2">
          {([['', `Todas (${all.length})`], ...filters.map(g => [g, `${EVIDENCE_GROUPS[g]} (${count(g)})`])] as [EvidenceGroup | '', string][]).map(([key, label]) =>
            <button key={key || 'todas'} type="button" aria-pressed={group === key} onClick={() => { setGroup(key); setIndex(0) }}
              className={`min-h-9 rounded-lg border px-3 text-sm font-semibold ${group === key ? 'border-blue-200 bg-blue-50 text-jrm-navy' : key && !count(key) ? 'border-slate-200 text-slate-400' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>{label}</button>)}
        </div>
        <ul className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {shown.map((e, i) => { const url = urls[e.path]; return <li key={e.key} className="min-w-0">
            <button type="button" onClick={() => setIndex(i)} aria-label={`Ver ${e.label}`} className={`block w-full overflow-hidden rounded-xl border bg-white text-left ${current?.key === e.key ? 'border-blue-400 ring-2 ring-blue-100' : 'border-slate-200 hover:border-slate-300'}`}>
              <span className="grid h-36 place-items-center bg-slate-100">{url && isImage(e.path, e.mime)
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={url} alt={e.label} loading="lazy" className="h-full w-full object-cover" /> : <FileText aria-hidden className="h-10 w-10 text-slate-400" />}</span>
              <span className="block space-y-1.5 p-3 text-sm">
                <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${TONE[e.group]}`}>{EVIDENCE_GROUPS[e.group]}</span>
                <span className="flex items-center gap-1.5 text-xs text-slate-600"><CalendarDays aria-hidden className="h-3.5 w-3.5" />{detailTime(e.at)}</span>
                {e.place && <span className="flex items-center gap-1.5 text-xs text-slate-600"><MapPin aria-hidden className="h-3.5 w-3.5" />{e.place}</span>}
                <span className="block truncate text-slate-800" title={e.label}>{e.label}{e.scope === 'RUTA' && servicesCount > 1 ? ' · de la ruta' : ''}</span>
              </span>
            </button>
          </li> })}
          {files.can_add_evidence && <li><button type="button" onClick={() => setAdding(true)} className="grid h-full min-h-[14rem] w-full place-items-center rounded-xl border-2 border-dashed border-slate-300 p-4 text-center hover:bg-slate-50">
            <span><span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-blue-600 text-white"><Plus className="h-6 w-6" /></span>
              <span className="mt-2 block font-semibold text-jrm-navy">Agregar más fotos</span><span className="block text-xs text-slate-500">JPG, PNG o PDF (máx. {EVIDENCE_MAX_MB} MB)</span></span>
          </button></li>}
        </ul>
        {!shown.length && !files.can_add_evidence && <p className="text-sm text-slate-500">Sin evidencias registradas{group ? ' en esta etapa' : ''}.</p>}
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Resumen de evidencias" icon={<Images />}>
        <dl className="divide-y divide-slate-100 text-sm">
          <div className="flex justify-between py-2"><dt className="text-slate-700">Total de evidencias</dt><dd className="font-semibold tabular-nums">{all.length}</dd></div>
          {filters.filter(g => count(g)).map(g => <div key={g} className="flex justify-between py-2"><dt className="text-slate-700">{EVIDENCE_GROUPS[g]}</dt><dd className="font-semibold tabular-nums">{count(g)}</dd></div>)}
        </dl>
      </DetailCard>
      <DetailCard title="Vista previa" icon={<Camera />}>
        {current ? <div className="space-y-3">
          <div className="relative overflow-hidden rounded-lg bg-slate-100">
            {urls[current.path] && isImage(current.path, current.mime) ? <Img src={urls[current.path]!} alt={current.label} className="h-64 w-full object-cover" />
              : urls[current.path] && isPdfFile(current.path, current.mime) ? <iframe src={urls[current.path]!} title={current.label} className="h-64 w-full bg-white" />
              : <p className="grid h-64 place-items-center text-sm text-slate-500">Archivo no disponible.</p>}
            <span className="absolute right-3 top-3 rounded-md bg-slate-900/70 px-2 py-0.5 text-xs font-semibold text-white">{pos + 1} / {shown.length}</span>
            {pos > 0 && <button type="button" aria-label="Evidencia anterior" onClick={() => setIndex(pos - 1)} className="absolute left-3 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-white shadow"><ChevronLeft className="h-5 w-5" /></button>}
            {pos < shown.length - 1 && <button type="button" aria-label="Evidencia siguiente" onClick={() => setIndex(pos + 1)} className="absolute right-3 top-1/2 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full bg-white shadow"><ChevronRight className="h-5 w-5" /></button>}
          </div>
          <p className="font-semibold text-jrm-navy">{current.label}</p>
          <span className={`inline-block rounded-md px-2 py-0.5 text-xs font-semibold ${TONE[current.group]}`}>{EVIDENCE_GROUPS[current.group]}</span>
          <p className="flex items-center gap-2 text-sm text-slate-700"><CalendarDays aria-hidden className="h-4 w-4 text-jrm-navy" />{detailTime(current.at)}</p>
          {current.place && <p className="flex items-center gap-2 text-sm text-slate-700"><MapPin aria-hidden className="h-4 w-4 text-jrm-navy" />{current.place}</p>}
          {(current.note || current.by) && <p className="text-sm text-slate-600">{[current.note, current.by && `Registró ${current.by}`].filter(Boolean).join(' · ')}</p>}
          <div className="flex flex-wrap justify-around gap-2 border-t border-slate-100 pt-3 text-sm font-semibold">
            {urls[current.path] && <a href={downloadUrl(urls[current.path]!)} download className="flex min-h-10 items-center gap-1.5 text-jrm-navy"><Download className="h-4 w-4" aria-hidden />Descargar</a>}
            {urls[current.path] && <a href={urls[current.path]!} target="_blank" rel="noreferrer" className="flex min-h-10 items-center gap-1.5 text-jrm-navy"><Maximize2 className="h-4 w-4" aria-hidden />Ampliar</a>}
            {current.canVoid && <button type="button" onClick={() => void voidEvidence(current)} className="flex min-h-10 items-center gap-1.5 text-rose-600"><Ban className="h-4 w-4" aria-hidden />Anular</button>}
          </div>
        </div> : <p className="text-sm text-slate-500">Sin evidencias para mostrar.</p>}
      </DetailCard>
    </div>
    {adding && <AddEvidence row={row} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); onChanged() }} />}
  </div>
}

/** Carga de una evidencia con etapa: sube a la carpeta propia del despacho y la registra; si el registro falla, retira el archivo. */
function AddEvidence({ row, onClose, onSaved }: { row: DeliveryRow; onClose: () => void; onSaved: () => void }) {
  const db = useMemo(() => createClient(), [])
  const [stage, setStage] = useState<EvidenceStage>('RECOJO'), [note, setNote] = useState(''), [file, setFile] = useState<File | null>(null), [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const pick = (f: File | null) => {
    if (f && !EVIDENCE_TYPES.includes(f.type)) { toast.error('Formato no admitido: use JPG, PNG, WEBP o PDF'); return }
    if (f && f.size > EVIDENCE_MAX_MB * 1024 * 1024) { toast.error(`${f.name} supera ${EVIDENCE_MAX_MB} MB`); return }
    setFile(f)
  }
  const save = async () => {
    if (!file || busy) return
    setBusy(true)
    try {
      const { data: auth } = await db.auth.getUser()
      if (!auth.user) throw new Error('Sesión vencida: vuelva a ingresar')
      const safe = file.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '-').slice(-80)
      const path = `${row.dispatch_id}/evidencia/${auth.user.id}/${Date.now()}-${safe}`
      const { error: up } = await db.storage.from('dispatch_documents').upload(path, file, { contentType: file.type, upsert: false })
      if (up) throw up
      const { data, error } = await db.rpc('register_dispatch_evidence', { p_dispatch: row.dispatch_id, p_request: row.request_id, p_stage: stage, p_file_path: path,
        p_file_name: file.name, p_mime_type: file.type, p_size_bytes: file.size, p_note: note.trim() || null })
      if (error || !data?.success) { await db.storage.from('dispatch_documents').remove([path]); throw new Error(error?.message || data?.error || 'No se registró la evidencia') }
      toast.success('Evidencia registrada'); onSaved()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo cargar la evidencia') } finally { setBusy(false) }
  }
  return <div className="fixed inset-0 z-[10000] grid place-items-center bg-slate-900/50 p-3" role="dialog" aria-modal="true" aria-label="Agregar evidencia">
    <div className="w-full max-w-md space-y-4 rounded-2xl bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between"><h3 className="text-lg font-bold text-jrm-navy">Agregar evidencia</h3><button type="button" onClick={onClose} aria-label="Cerrar" className="grid h-9 w-9 place-items-center rounded-lg hover:bg-slate-100"><X className="h-5 w-5" /></button></div>
      <p className="text-sm text-slate-600">Despacho {row.dispatch_number} · {row.request_number}</p>
      <label className="block text-sm font-medium text-slate-700">Etapa
        <select value={stage} onChange={e => setStage(e.target.value as EvidenceStage)} className="mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-2">{(Object.keys(EVIDENCE_STAGES) as EvidenceStage[]).map(s => <option key={s} value={s}>{EVIDENCE_STAGES[s]}</option>)}</select></label>
      <label className="block text-sm font-medium text-slate-700">Descripción (opcional)
        <input value={note} maxLength={500} onChange={e => setNote(e.target.value)} placeholder="Ej.: Unidad en punto de recojo - vista general" className="mt-1 h-10 w-full rounded-lg border border-slate-300 px-3" /></label>
      <button type="button" onClick={() => input.current?.click()} className="flex w-full flex-col items-center gap-1 rounded-xl border-2 border-dashed border-slate-300 p-5 text-sm hover:bg-slate-50">
        <Upload className="h-6 w-6 text-jrm-navy" aria-hidden /><span className="font-semibold text-jrm-navy">{file ? file.name : 'Seleccionar archivo'}</span><span className="text-xs text-slate-500">JPG, PNG o PDF (máx. {EVIDENCE_MAX_MB} MB)</span>
      </button>
      <input ref={input} type="file" accept={EVIDENCE_TYPES.join(',')} className="hidden" onChange={e => pick(e.target.files?.[0] || null)} />
      <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold">Cancelar</button>
        <button type="button" disabled={!file || busy} onClick={() => void save()} className="flex min-h-10 items-center gap-2 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white disabled:opacity-50">{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}Registrar</button></div>
    </div>
  </div>
}
