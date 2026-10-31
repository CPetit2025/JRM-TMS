'use client'
import type { ReactNode } from 'react'
import { AlertCircle, Check, Download, ExternalLink, FileText } from 'lucide-react'
import { detailTime, downloadUrl, isImage, isPdfFile, type DetailTab, type Milestone, type Pending } from '@/lib/dispatch-detail'

export function DetailCard({ title, icon, actions, children }: { title: string; icon?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <section aria-label={title} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2 font-bold text-jrm-navy">{icon}{title}</h3>{actions}</div>
    {children}
  </section>
}

export function Fields({ items, cols = 'sm:grid-cols-2 lg:grid-cols-3' }: { items: [string, ReactNode][]; cols?: string }) {
  return <dl className={`grid gap-x-6 gap-y-3 text-sm ${cols}`}>{items.map(([name, value]) => <div key={name} className="min-w-0">
    <dt className="text-xs font-medium text-slate-500">{name}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-slate-800">{value}</dd>
  </div>)}</dl>
}

const dot = (state: Milestone['state']) => state === 'done' ? 'bg-emerald-600 text-white' : state === 'current' ? 'bg-blue-600 text-white ring-4 ring-blue-100'
  : state === 'alert' ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-500'

/** Línea de hitos horizontal (se desplaza en pantallas angostas). */
export function MilestoneStepper({ steps }: { steps: Milestone[] }) {
  return <ol aria-label="Hitos del despacho" className="flex min-w-0 overflow-x-auto pb-1">{steps.map((s, i) => <li key={s.key} className="relative flex min-w-24 flex-1 flex-col items-center text-center">
    {i > 0 && <span aria-hidden className={`absolute right-1/2 top-3.5 h-0.5 w-full ${s.state === 'done' || s.state === 'alert' ? 'bg-emerald-500' : 'bg-slate-200'}`} />}
    <span aria-hidden className={`relative grid h-7 w-7 place-items-center rounded-full ${dot(s.state)}`}>{s.state === 'done' ? <Check className="h-4 w-4" /> : s.state === 'alert' ? <AlertCircle className="h-4 w-4" /> : <span className="h-2 w-2 rounded-full bg-current" />}</span>
    <span className={`mt-2 text-xs font-semibold ${s.state === 'pending' ? 'text-slate-500' : 'text-slate-800'}`}>{s.label}</span>
    <span className="text-[11px] text-slate-500">{s.at ? detailTime(s.at) : '—'}</span>
    <span className="sr-only">{s.note}</span>
  </li>)}</ol>
}

/** Hitos en lista vertical con su descripción. */
export function MilestoneList({ steps }: { steps: Milestone[] }) {
  return <ol className="space-y-3">{steps.map(s => <li key={s.key} className="flex items-start gap-3">
    <span aria-hidden className={`mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${dot(s.state)}`}>{s.state === 'done' ? <Check className="h-3.5 w-3.5" /> : s.state === 'alert' ? <AlertCircle className="h-3.5 w-3.5" /> : <span className="h-1.5 w-1.5 rounded-full bg-current" />}</span>
    <div className="grid min-w-0 flex-1 gap-x-4 sm:grid-cols-[minmax(0,10rem)_minmax(0,9rem)_minmax(0,1fr)]">
      <p className="font-semibold text-slate-800">{s.label}</p><p className="text-sm tabular-nums text-slate-600">{s.at ? detailTime(s.at) : '—'}</p><p className="text-sm text-slate-500">{s.note}</p>
    </div>
  </li>)}</ol>
}

export function PendingList({ items, onGo }: { items: Pending[]; onGo?: (tab: DetailTab) => void }) {
  if (!items.length) return <p className="text-sm text-slate-500">Sin pendientes registrados para esta entrega.</p>
  return <ul className="space-y-2">{items.map(p => <li key={p.key} className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3">
    <FileText aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" />
    <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-amber-900">{p.title}</p><p className="text-xs text-amber-900/80">{p.detail}</p></div>
    {onGo && <button type="button" onClick={() => onGo(p.tab)} className="min-h-9 shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 text-xs font-semibold text-amber-900">Ver</button>}
  </li>)}</ul>
}

export function SourcesWarning({ failed }: { failed: string[] }) {
  if (!failed.length) return null
  return <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">Parte del historial no está disponible por ahora ({failed.join(', ')}). Se muestra lo que sí está registrado.</p>
}

/** Vista previa con URL firmada: imagen o PDF en la página; otros formatos solo se abren o descargan. */
export function FilePreview({ url, path, mime, title }: { url: string | null | undefined; path: string; mime?: string | null; title: string }) {
  if (!url) return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Archivo no disponible o sin permiso para verlo.</p>
  return <div className="space-y-2">
    {isImage(path, mime) ? <a href={url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={title} className="max-h-[28rem] w-full object-contain" /></a>
      : isPdfFile(path, mime) ? <iframe src={url} title={title} className="h-[28rem] w-full rounded-lg border border-slate-200" />
      : <p className="rounded-lg border border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-600">Este formato no tiene vista previa.</p>}
    <div className="flex flex-wrap gap-2">
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy"><ExternalLink className="h-4 w-4" aria-hidden />Abrir</a>
      <a href={downloadUrl(url)} download className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy"><Download className="h-4 w-4" aria-hidden />Descargar</a>
    </div>
  </div>
}
