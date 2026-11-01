'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ClipboardCheck, Clock, Download, Eye, FileText, Package, Plus, Search } from 'lucide-react'
import type { DeliveryRow } from '@/lib/delivery'
import { conformityChecklist, detailTime, documentRows, documentaryProgress, downloadUrl, type ChecklistItem, type DetailTab, type DispatchFiles, type DocumentRow } from '@/lib/dispatch-detail'
import { DetailCard, FilePreview, IconButton, MilestoneStepper, ServiceStrip, SourcesWarning } from './DetailParts'

type Filter = 'TODOS' | DocumentRow['group']
const FILTERS: [Filter, string][] = [['TODOS', 'Todos'], ['SALIDA', 'Salida'], ['RECEPCION', 'Recepción'], ['OTROS', 'Otros']]
const STATE: Record<DocumentRow['state'], [string, string]> = {
  VALIDADO: ['Validado', 'bg-emerald-50 text-emerald-700 ring-emerald-200'], REGISTRADO: ['Registrado', 'bg-emerald-50 text-emerald-700 ring-emerald-200'],
  PENDIENTE: ['Pendiente', 'bg-orange-50 text-orange-700 ring-orange-200'], OBSERVADO: ['Observado', 'bg-rose-50 text-rose-700 ring-rose-200'], NO_REQUERIDO: ['No requerido', 'bg-slate-100 text-slate-600 ring-slate-200'],
}
const CHECK: Record<ChecklistItem['state'], [string, string]> = {
  COMPLETO: ['Completo', 'bg-emerald-50 text-emerald-700 ring-emerald-200'], PENDIENTE: ['Pendiente', 'bg-slate-100 text-slate-600 ring-slate-200'],
  NO_REQUERIDO: ['No requerido', 'bg-slate-100 text-slate-600 ring-slate-200'], OBSERVADO: ['Observado', 'bg-rose-50 text-rose-700 ring-rose-200'],
}
export const Chip = ({ value }: { value: [string, string] }) => <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset ${value[1]}`}>{value[0]}</span>
const GROUP_TAG: Record<DocumentRow['group'], string> = { SALIDA: 'Salida', RECEPCION: 'Recepción', OTROS: 'Otros' }

/** Documentos de la parada y su ruta, checklist de conformidad y estado documentario (solo lectura). */
export function DocumentosTab({ row, files, urls, documentsHref, onDocuments, onGo }: { row: DeliveryRow; files: DispatchFiles; urls: Record<string, string | null>; documentsHref?: string; onDocuments?: () => void; onGo?: (tab: DetailTab) => void }) {
  const [filter, setFilter] = useState<Filter>('TODOS'), [search, setSearch] = useState(''), [selected, setSelected] = useState<string | null>(null)
  const all = documentRows(files, row), checklist = conformityChecklist(files, row), progress = documentaryProgress(files)
  const needle = search.trim().toLocaleLowerCase('es-PE')
  const shown = all.filter(d => (filter === 'TODOS' || d.group === filter) && (!needle || `${d.name} ${d.number || ''} ${d.responsible || ''}`.toLocaleLowerCase('es-PE').includes(needle)))
  const related = files.submissions.flatMap(s => [...s.photos.map((path, i) => ({ path, label: i === 0 ? 'Foto de entrega' : `Foto de entrega ${i + 1}`, at: s.captured_at })),
    ...s.packing_photos.map((path, i) => ({ path, label: `Carga entregada ${i + 1}`, at: s.captured_at }))])
  const preview = all.find(d => d.key === selected && d.path) || (selected && related.find(r => r.path === selected) ? null : all.find(d => d.path)) || null
  const previewRelated = selected ? related.find(r => r.path === selected) : null
  const pendingCheck = checklist.some(c => c.state === 'PENDIENTE' || c.state === 'OBSERVADO')
  return <div className="grid items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.75fr)_minmax(22rem,1fr)]">
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <SourcesWarning failed={files.sources_failed} />
      <ServiceStrip row={row} icon={<FileText />} title={<span><span className="block text-sm font-normal text-slate-500">Referencia</span>Despacho {row.dispatch_number} · {row.request_number}</span>} />
      <DetailCard title="Documentos del despacho" icon={<FileText />}
        // Ruta que ya salió: la liquidación documentaria se abre encima; antes de salir, el Packing List se arma en Documentos
        actions={onDocuments && row.state !== 'PROGRAMADO' ? <button type="button" onClick={onDocuments} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50"><Plus className="h-4 w-4" aria-hidden />Agregar documento</button>
          : documentsHref && <Link href={documentsHref} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50"><Plus className="h-4 w-4" aria-hidden />Agregar documento</Link>}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div role="group" aria-label="Filtrar documentos" className="flex flex-wrap gap-2">{FILTERS.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}
            className={`min-h-9 rounded-lg border px-3 text-sm font-semibold ${filter === key ? 'border-blue-200 bg-blue-50 text-jrm-navy' : 'border-slate-300 text-slate-600 hover:bg-slate-50'}`}>{label} ({all.filter(d => key === 'TODOS' || d.group === key).length})</button>)}</div>
          <label className="relative ml-auto w-full sm:w-64"><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar documento, número o tipo…" aria-label="Buscar documento"
            className="h-9 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-sm" /></label>
        </div>
        {!files.can_view_documents && <p className="mb-2 text-xs text-slate-500">Sin acceso a los archivos cargados por Documentos: se muestran la guía de entrega y los pendientes.</p>}
        {!shown.length ? <p className="py-4 text-sm text-slate-500">Sin documentos con este filtro.</p> : <>
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 lg:block"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Tipo de documento', 'Número', 'Relacionado con', 'Fecha', 'Estado', 'Responsable', 'Acciones'].map(h => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-200">{shown.map(d => <tr key={d.key} className={`align-middle ${preview?.key === d.key && !previewRelated ? 'bg-blue-50/50' : ''}`}>
              <td className="px-3 py-2.5"><div className="flex items-center gap-3"><FileText aria-hidden className={`h-6 w-6 shrink-0 ${d.mime === 'application/pdf' ? 'text-rose-500' : 'text-slate-400'}`} />
                <div><p className="font-semibold text-slate-800">{d.name}</p><span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-jrm-navy">{GROUP_TAG[d.group]}</span></div></div></td>
              <td className="px-3 py-2.5">{d.number || (d.state === 'NO_REQUERIDO' ? 'No requerido' : '—')}</td>
              <td className="whitespace-pre-line px-3 py-2.5 text-slate-600">{d.related}</td>
              <td className="px-3 py-2.5 tabular-nums text-slate-600">{d.at ? detailTime(d.at) : '—'}</td>
              <td className="px-3 py-2.5"><Chip value={STATE[d.state]} /></td>
              <td className="px-3 py-2.5 text-slate-700">{d.responsible || (d.state === 'PENDIENTE' ? 'Sin asignar' : '—')}</td>
              <td className="px-3 py-2.5"><div className="flex gap-1.5">
                <IconButton label={`Ver ${d.name}`} disabled={!d.path} onClick={() => setSelected(d.key)}><Eye className="h-4 w-4" /></IconButton>
                {d.path && urls[d.path] && <IconButton label={`Descargar ${d.name}`} href={downloadUrl(urls[d.path]!)} download><Download className="h-4 w-4" /></IconButton>}
              </div></td>
            </tr>)}</tbody>
          </table></div>
          <ul className="space-y-2 lg:hidden">{shown.map(d => <li key={d.key} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex items-start justify-between gap-2"><div><p className="font-semibold text-slate-800">{d.name} {d.number && <span className="font-normal text-slate-600">· {d.number}</span>}</p>
              <p className="text-xs text-slate-500">{GROUP_TAG[d.group]} · {d.at ? detailTime(d.at) : 'Sin fecha'} · {d.responsible || 'Sin asignar'}</p></div><Chip value={STATE[d.state]} /></div>
            {d.path && <div className="mt-2 flex gap-1.5"><IconButton label={`Ver ${d.name}`} onClick={() => setSelected(d.key)}><Eye className="h-4 w-4" /></IconButton>
              {urls[d.path] && <IconButton label={`Descargar ${d.name}`} href={downloadUrl(urls[d.path]!)} download><Download className="h-4 w-4" /></IconButton>}</div>}
          </li>)}</ul>
        </>}
      </DetailCard>
      <DetailCard title="Checklist de conformidad" icon={<ClipboardCheck />} actions={<Chip value={pendingCheck ? ['Pendiente', 'bg-orange-50 text-orange-700 ring-orange-200'] : ['Completo', 'bg-emerald-50 text-emerald-700 ring-emerald-200']} />}>
        <div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr><th className="px-3 py-2.5 font-medium">Ítem</th><th className="px-3 py-2.5 font-medium">Estado</th><th className="px-3 py-2.5 font-medium">Observación</th></tr></thead>
          <tbody className="divide-y divide-slate-200">{checklist.map(c => <tr key={c.key}><td className="px-3 py-2.5 text-slate-800">{c.label}</td><td className="px-3 py-2.5"><Chip value={CHECK[c.state]} /></td><td className="px-3 py-2.5 text-slate-600">{c.note}</td></tr>)}</tbody>
        </table></div>
        <p className="mt-2 text-xs text-slate-500">Se valida en «Guía y conformidad». El cierre documentario es independiente del operativo y del económico.</p>
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Estado documentario" icon={<Package />} actions={onGo && <button type="button" onClick={() => onGo('historial')} className="text-sm font-semibold text-jrm-navy underline-offset-2 hover:underline">Historial</button>}>
        <MilestoneStepper steps={progress.map(p => ({ ...p, value: <span className={`mt-1 rounded-md px-2 py-0.5 text-xs font-semibold ${p.state === 'done' ? 'bg-emerald-50 text-emerald-700' : p.state === 'alert' || p.state === 'current' ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{p.count}</span> }))} />
        {files.documentary?.missing.length ? <p className="mt-3 text-xs text-slate-600">Falta para el cierre: {files.documentary.missing.map(m => m.replaceAll('_', ' ').toLowerCase()).join(', ')}.</p> : null}
      </DetailCard>
      <DetailCard title="Vista previa del documento" icon={<Eye />}>
        {previewRelated ? <div className="space-y-2"><p className="font-semibold text-jrm-navy">{previewRelated.label}</p><FilePreview url={urls[previewRelated.path]} path={previewRelated.path} title={previewRelated.label} /></div>
          : preview?.path ? <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-jrm-navy">{preview.name}{preview.number ? ` · ${preview.number}` : ''}</p><Chip value={STATE[preview.state]} /></div>
            <FilePreview url={urls[preview.path]} path={preview.path} mime={preview.mime} title={preview.name} /></div>
          : <p className="text-sm text-slate-500">Sin archivo para previsualizar.</p>}
      </DetailCard>
      {/* Las fotos de entrega se ven en un solo lugar: «Fotos y evidencias» (aquí solo el acceso) */}
      <DetailCard title={`Fotos de entrega (${related.length})`} icon={<Clock />}>
        {!related.length ? <p className="text-sm text-slate-500">Sin fotos de entrega.</p>
          : <div className="space-y-2 text-sm text-slate-600"><p>Están con el resto de la evidencia de la entrega, por etapa.</p>
            {onGo && <button type="button" onClick={() => onGo('evidencias')} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 font-semibold text-jrm-navy hover:bg-slate-50"><Eye className="h-4 w-4" aria-hidden />Ver en Fotos y evidencias</button>}</div>}
      </DetailCard>
    </div>
  </div>
}
