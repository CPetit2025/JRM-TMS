'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck, Eye, FileText, Plus } from 'lucide-react'
import { StatusBadge } from '@/components/ui/status-badge'
import type { DeliveryRow } from '@/lib/delivery'
import { DOC_CATEGORY_LABEL, DOC_TYPE_LABEL, DOCUMENTARY_LABEL, DOCUMENTARY_STEPS, detailTime, docGroup, fileSize, missingLabel, type DetailDocument, type DispatchFiles } from '@/lib/dispatch-detail'
import { DetailCard, FilePreview, SourcesWarning } from './DetailParts'

type Filter = 'TODOS' | 'SALIDA' | 'OTROS'
const reviewTone = (d?: string) => d === 'VALIDADA' ? 'success' : d ? 'danger' : 'warning'
const reviewLabel = (d?: string) => d === 'VALIDADA' ? 'Validada' : d === 'OBSERVADA' ? 'Observada' : d === 'RECHAZADA' ? 'Rechazada' : 'Por validar'

/** Documentos de la parada y de su ruta, guías de entrega y estado del cierre documentario (solo lectura). */
export function DocumentosTab({ row, files, urls, documentsHref }: { row: DeliveryRow; files: DispatchFiles; urls: Record<string, string | null>; documentsHref?: string }) {
  const [filter, setFilter] = useState<Filter>('TODOS'), [selected, setSelected] = useState<string | null>(null)
  const docs = files.documents.filter(d => filter === 'TODOS' || docGroup(d) === filter)
  const preview = files.documents.find(d => d.id === selected) || files.documents[0] || null
  const count = (f: Filter) => files.documents.filter(d => f === 'TODOS' || docGroup(d) === f).length
  const closure = files.documentary, stepIndex = closure ? DOCUMENTARY_STEPS.indexOf(closure.status === 'OBSERVADO' ? 'EN_VALIDACION' : closure.status) : -1
  const name = (d: DetailDocument) => `${DOC_TYPE_LABEL[d.doc_type] || d.doc_type}${d.category ? ` · ${DOC_CATEGORY_LABEL[d.category] || d.category}` : ''}`
  return <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
    <div className="min-w-0 space-y-4">
      <SourcesWarning failed={files.sources_failed} />
      <DetailCard title="Documentos del despacho" icon={<FileText className="h-5 w-5" aria-hidden />}
        actions={documentsHref && <Link href={documentsHref} className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy"><Plus className="h-4 w-4" aria-hidden />Agregar documento</Link>}>
        {!files.can_view_documents ? <p className="text-sm text-slate-500">Sin acceso a los archivos de documentos de este despacho.</p> : <>
          <div role="group" aria-label="Filtrar documentos" className="mb-3 flex flex-wrap gap-2">{(['TODOS', 'SALIDA', 'OTROS'] as Filter[]).map(f => <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
            className={`min-h-9 rounded-lg border px-3 text-sm font-semibold ${filter === f ? 'border-jrm-navy bg-blue-50 text-jrm-navy' : 'border-slate-300 text-slate-600'}`}>{f === 'TODOS' ? 'Todos' : f === 'SALIDA' ? 'Salida' : 'Otros'} ({count(f)})</button>)}</div>
          {!docs.length ? <p className="text-sm text-slate-500">Sin documentos registrados{filter !== 'TODOS' ? ' en este grupo' : ''}.</p>
            : <ul className="divide-y rounded-lg border border-slate-200">{docs.map(d => <li key={d.id} className={`flex flex-wrap items-center gap-3 p-3 text-sm ${preview?.id === d.id ? 'bg-blue-50/60' : ''}`}>
              <div className="min-w-0 flex-1"><p className="font-semibold text-slate-800">{name(d)}{d.number && <span className="ml-1 font-normal text-slate-600">· {d.number}</span>}</p>
                <p className="text-xs text-slate-500">{detailTime(d.uploaded_at)} · Registrado por {d.uploaded_by || 'usuario no disponible'} · {fileSize(d.size_bytes)} · {d.scope === 'RUTA' ? 'De la ruta' : 'De esta solicitud'}</p></div>
              <button type="button" onClick={() => setSelected(d.id)} aria-label={`Ver ${name(d)}`} className="flex min-h-9 items-center gap-1 rounded-lg border border-slate-300 px-2.5 text-xs font-semibold text-jrm-navy"><Eye className="h-4 w-4" aria-hidden />Ver</button>
            </li>)}</ul>}
        </>}
        {files.references.length > 0 && <div className="mt-4"><h4 className="mb-2 text-sm font-semibold text-slate-700">Números vinculados por el Asistente Documentario</h4>
          <ul className="flex flex-wrap gap-2">{files.references.map((r, i) => <li key={`${r.number}/${i}`} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs" title={`${detailTime(r.at)}${r.by ? ` · ${r.by}` : ''}`}>{r.doc_type === 'NOTA_DESPACHO' ? 'Nota' : 'GR'} {r.number}</li>)}</ul></div>}
      </DetailCard>
      <DetailCard title="Guías de entrega (recepción)" icon={<ClipboardCheck className="h-5 w-5" aria-hidden />}>
        {!files.submissions.length ? <p className="text-sm text-slate-500">{row.conformity === 'NO_APLICA' ? 'No aplica: recojo por cliente.' : 'Sin guía de entrega enviada.'}</p>
          : <ul className="divide-y rounded-lg border border-slate-200">{files.submissions.map(s => <li key={s.id} className="flex flex-wrap items-start gap-3 p-3 text-sm">
            <div className="min-w-0 flex-1"><p className="font-semibold text-slate-800">Guía {s.guide_number || 'sin número'}</p>
              <p className="text-xs text-slate-500">Enviada {detailTime(s.submitted_at)}{s.submitted_by ? ` por ${s.submitted_by}` : ''}{s.received_by ? ` · recibió ${s.received_by}` : ''} · {s.photos.length} foto(s)</p>
              {s.review && <p className="text-xs text-slate-600">{reviewLabel(s.review.decision)} {detailTime(s.review.at)}{s.review.by ? ` por ${s.review.by}` : ''}{s.review.reason ? ` · ${s.review.reason}` : ''}</p>}</div>
            <StatusBadge tone={reviewTone(s.review?.decision)}>{reviewLabel(s.review?.decision)}</StatusBadge>
          </li>)}</ul>}
      </DetailCard>
      <DetailCard title="Checklist del cierre documentario" icon={<ClipboardCheck className="h-5 w-5" aria-hidden />}
        actions={closure && <StatusBadge tone={closure.status === 'COMPLETO' ? 'success' : closure.status === 'OBSERVADO' ? 'danger' : 'warning'}>{DOCUMENTARY_LABEL[closure.status]}</StatusBadge>}>
        {!closure ? <p className="text-sm text-slate-500">El cierre documentario de esta solicitud aún no tiene registro.</p>
          : closure.status === 'COMPLETO' ? <p className="text-sm text-emerald-800">Documentación completa{closure.source === 'MANUAL' ? ' (cierre manual)' : ''}{closure.completed_at ? ` · ${detailTime(closure.completed_at)}` : ''}{closure.completed_by ? ` por ${closure.completed_by}` : ''}.</p>
          : closure.missing.length ? <ul className="space-y-1.5">{closure.missing.map(code => <li key={code} className="flex items-center gap-2 text-sm text-amber-900"><span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />Falta: {missingLabel(code)}</li>)}</ul>
          : <p className="text-sm text-slate-600">En validación.</p>}
        <p className="mt-3 text-xs text-slate-500">El cierre documentario es independiente del operativo y del económico; se gestiona en Documentos del despacho.</p>
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4">
      <DetailCard title="Estado documentario">
        {closure ? <ol className="flex">{DOCUMENTARY_STEPS.map((s, i) => <li key={s} className="flex flex-1 flex-col items-center text-center text-xs">
          <span aria-hidden className={`grid h-7 w-7 place-items-center rounded-full ${i < stepIndex || closure.status === 'COMPLETO' ? 'bg-emerald-600 text-white' : i === stepIndex ? (closure.status === 'OBSERVADO' ? 'bg-rose-600 text-white' : 'bg-blue-600 text-white') : 'bg-slate-200 text-slate-500'}`}>{i + 1}</span>
          <span className="mt-1 font-semibold text-slate-700">{i === stepIndex && closure.status === 'OBSERVADO' ? 'Observado' : DOCUMENTARY_LABEL[s]}</span>
        </li>)}</ol> : <p className="text-sm text-slate-500">Sin registro.</p>}
      </DetailCard>
      <DetailCard title="Vista previa del documento">
        {preview && files.can_view_documents ? <div className="space-y-2"><p className="text-sm font-semibold text-slate-800">{name(preview)}{preview.number ? ` · ${preview.number}` : ''}</p>
          <FilePreview url={urls[`dispatch_documents/${preview.file_path}`]} path={preview.file_path} mime={preview.mime_type} title={name(preview)} /></div>
          : <p className="text-sm text-slate-500">Seleccione un documento para verlo.</p>}
      </DetailCard>
    </div>
  </div>
}
