'use client'
import { useState } from 'react'
import { Camera, ChevronLeft, ChevronRight, FileText, Images } from 'lucide-react'
import { EVIDENCE_GROUPS, detailTime, evidenceItems, isImage, type DispatchFiles, type EvidenceGroup, type RouteEvidence } from '@/lib/dispatch-detail'
import { DetailCard, FilePreview, SourcesWarning } from './DetailParts'

const TONE: Record<EvidenceGroup, string> = {
  ENTREGA: 'bg-emerald-50 text-emerald-800', CARGA: 'bg-blue-50 text-jrm-navy', DOCUMENTO: 'bg-violet-50 text-violet-800',
  UNIDAD: 'bg-slate-100 text-slate-700', INCIDENCIA: 'bg-rose-50 text-rose-800', GASTO: 'bg-amber-50 text-amber-900',
}

/** Fotos y archivos registrados para la parada y su ruta, agrupados por su fuente real. No se borran desde aquí. */
export function EvidenciasTab({ files, route, urls, servicesCount }: { files: DispatchFiles; route: RouteEvidence[]; urls: Record<string, string | null>; servicesCount: number }) {
  const all = evidenceItems(files, route)
  const [group, setGroup] = useState<EvidenceGroup | ''>(''), [index, setIndex] = useState(0)
  const shown = all.filter(e => !group || e.group === group), groups = (Object.keys(EVIDENCE_GROUPS) as EvidenceGroup[]).filter(g => all.some(e => e.group === g))
  const current = shown[Math.min(index, shown.length - 1)]
  return <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
    <div className="min-w-0 space-y-4">
      <SourcesWarning failed={files.sources_failed} />
      <DetailCard title={`Fotos y evidencias (${all.length})`} icon={<Camera className="h-5 w-5" aria-hidden />}>
        <div role="group" aria-label="Filtrar evidencias" className="mb-3 flex flex-wrap gap-2">
          {[['', `Todas (${all.length})`] as const, ...groups.map(g => [g, `${EVIDENCE_GROUPS[g]} (${all.filter(e => e.group === g).length})`] as const)].map(([key, label]) =>
            <button key={key || 'todas'} type="button" aria-pressed={group === key} onClick={() => { setGroup(key); setIndex(0) }} className={`min-h-9 rounded-lg border px-3 text-sm font-semibold ${group === key ? 'border-jrm-navy bg-blue-50 text-jrm-navy' : 'border-slate-300 text-slate-600'}`}>{label}</button>)}
        </div>
        {!shown.length ? <p className="text-sm text-slate-500">Sin evidencias registradas.</p>
          : <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{shown.map((e, i) => { const url = urls[e.path]; return <li key={e.key} className="min-w-0">
            <button type="button" onClick={() => setIndex(i)} aria-label={`Ver ${e.label}`} className={`block w-full overflow-hidden rounded-xl border text-left ${current?.key === e.key ? 'border-jrm-navy ring-2 ring-blue-100' : 'border-slate-200'}`}>
              <span className="grid h-28 place-items-center bg-slate-100">{url && isImage(e.path)
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={url} alt={e.label} loading="lazy" className="h-full w-full object-cover" /> : <FileText aria-hidden className="h-8 w-8 text-slate-400" />}</span>
              <span className="block space-y-1 p-2 text-xs">
                <span className={`inline-block rounded-md px-1.5 py-0.5 font-semibold ${TONE[e.group]}`}>{EVIDENCE_GROUPS[e.group]}</span>
                <span className="block truncate font-medium text-slate-800" title={e.label}>{e.label}</span>
                <span className="block text-slate-500">{detailTime(e.at)}{e.scope === 'RUTA' && servicesCount > 1 ? ' · de la ruta' : ''}</span>
              </span>
            </button>
          </li> })}</ul>}
        <p className="mt-3 text-xs text-slate-500">Las fotos se registran desde el app del conductor y el enlace del tercero; quedan como respaldo y no se eliminan.</p>
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4">
      <DetailCard title="Resumen de evidencias" icon={<Images className="h-5 w-5" aria-hidden />}>
        <dl className="divide-y text-sm">{groups.length ? groups.map(g => <div key={g} className="flex justify-between py-1.5"><dt className="text-slate-600">{EVIDENCE_GROUPS[g]}</dt><dd className="font-semibold tabular-nums">{all.filter(e => e.group === g).length}</dd></div>)
          : <p className="text-slate-500">Sin evidencias.</p>}</dl>
      </DetailCard>
      <DetailCard title="Vista previa" actions={shown.length > 1 && <span className="flex items-center gap-1">
        <button type="button" aria-label="Evidencia anterior" disabled={!current || shown.indexOf(current) === 0} onClick={() => setIndex(shown.indexOf(current) - 1)} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
        <span className="text-xs tabular-nums text-slate-600">{current ? shown.indexOf(current) + 1 : 0} / {shown.length}</span>
        <button type="button" aria-label="Evidencia siguiente" disabled={!current || shown.indexOf(current) === shown.length - 1} onClick={() => setIndex(shown.indexOf(current) + 1)} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-300 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
      </span>}>
        {current ? <div className="space-y-2">
          <p className="text-sm font-semibold text-slate-800">{current.label}</p>
          <p className="text-xs text-slate-500">{EVIDENCE_GROUPS[current.group]} · {detailTime(current.at)}{current.note ? ` · ${current.note}` : ''}</p>
          <FilePreview url={urls[current.path]} path={current.path} title={current.label} />
        </div> : <p className="text-sm text-slate-500">Seleccione una evidencia.</p>}
      </DetailCard>
    </div>
  </div>
}
