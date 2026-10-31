'use client'
import type { ReactNode } from 'react'
import { AlertCircle, Check, Download, ExternalLink, FileText, Info, MapPin, Maximize2 } from 'lucide-react'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { districtOf } from '@/lib/address'
import { deliveryServiceKind, type DeliveryRow } from '@/lib/delivery'
import { partyName, referenceLabel, requiresSupplier } from '@/lib/suppliers'
import { detailTime, downloadUrl, isImage, isPdfFile, type DetailTab, type Milestone, type Pending } from '@/lib/dispatch-detail'

/** Tarjeta de sección como en los bosquejos: título azul con icono y acciones a la derecha. */
export function DetailCard({ title, icon, actions, children, className = '' }: { title: ReactNode; icon?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section aria-label={typeof title === 'string' ? title : undefined} className={`min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 ${className}`}>
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><h3 className="flex items-center gap-2.5 text-base font-bold text-jrm-navy sm:text-lg">{icon && <span className="text-jrm-navy [&>svg]:h-5 [&>svg]:w-5">{icon}</span>}{title}</h3>{actions}</div>
    {children}
  </section>
}

/** Celdas con bordes finos (grilla de datos de los bosquejos). */
export function CellGrid({ items, cols = 'sm:grid-cols-2 lg:grid-cols-3' }: { items: [string, ReactNode, string?][]; cols?: string }) {
  return <dl className={`grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-sm ${cols}`}>{items.map(([name, value, span]) => <div key={name} className={`min-w-0 bg-white p-3 ${span || ''}`}>
    <dt className="text-xs font-medium text-slate-500">{name}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-slate-800">{value}</dd>
  </div>)}</dl>
}
// Compatibilidad: lista simple de datos (sin bordes)
export function Fields({ items, cols = 'sm:grid-cols-2 lg:grid-cols-3' }: { items: [string, ReactNode][]; cols?: string }) {
  return <dl className={`grid gap-x-6 gap-y-3 text-sm ${cols}`}>{items.map(([name, value]) => <div key={name} className="min-w-0">
    <dt className="text-xs font-medium text-slate-500">{name}</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-slate-800">{value}</dd>
  </div>)}</dl>
}

export const Place = ({ text }: { text: string }) => <span className="flex items-start gap-2"><MapPin aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-jrm-navy" /><span>{text || '—'}</span></span>

/** Franja «Información del servicio» de las pestañas Documentos, Evidencias y Costos. */
export function ServiceStrip({ row, title = 'Información del servicio', icon }: { row: DeliveryRow; title?: ReactNode; icon?: ReactNode }) {
  const party = partyName(row, row.client_name, row.supplier_name)
  return <DetailCard title={title} icon={icon}>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4 2xl:grid-cols-8">
      {([['Tipo de servicio', <ServiceTypeBadge key="t" kind={deliveryServiceKind(row)} full />], ['N.º despacho', row.dispatch_number || '—'], ['Solicitud (RT)', row.request_number],
        ['Documento de referencia', referenceLabel(row) || '—'], [requiresSupplier(row) ? 'Proveedor' : 'Cliente', <span key="p" title={party || undefined} className="line-clamp-2">{party || '—'}</span>, 'col-span-2'],
        ['Origen', <Place key="o" text={districtOf(row.pickup_address) || row.pickup_address} />], ['Destino', <Place key="d" text={districtOf(row.delivery_address) || row.delivery_address} />]] as [string, ReactNode, string?][])
        .map(([name, value, span]) => <div key={name} className={`min-w-0 border-slate-200 2xl:border-l 2xl:pl-3 2xl:first:border-l-0 2xl:first:pl-0 ${span || ''}`}><dt className="text-xs font-medium text-slate-500">{name}</dt><dd className="mt-1 break-words font-medium text-slate-800">{value}</dd></div>)}
    </dl>
  </DetailCard>
}

const dot = (state: Milestone['state']) => state === 'done' ? 'bg-emerald-600 text-white' : state === 'current' ? 'bg-blue-600 text-white ring-4 ring-blue-100'
  : state === 'alert' ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-400'
const StepIcon = ({ state, small = false }: { state: Milestone['state']; small?: boolean }) => state === 'done' ? <Check className={small ? 'h-3.5 w-3.5' : 'h-4 w-4'} strokeWidth={3} />
  : state === 'alert' ? <AlertCircle className={small ? 'h-3.5 w-3.5' : 'h-4 w-4'} /> : <span className={`${small ? 'h-1.5 w-1.5' : 'h-2.5 w-2.5'} rounded-full ${state === 'pending' ? 'bg-slate-400' : 'bg-white'}`} />
const dayTime = (v: string | null) => v ? [new Date(v).toLocaleDateString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit' }), new Date(v).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false })] : ['—', '']

/** Línea de estados horizontal: círculo, etiqueta y fecha/hora en dos líneas (se desplaza en pantallas angostas). */
export function MilestoneStepper({ steps }: { steps: { key: string; label: string; at: string | null; state: Milestone['state']; note?: string; value?: ReactNode }[] }) {
  return <ol aria-label="Línea de estados" className="flex min-w-0 overflow-x-auto pb-1">{steps.map((s, i) => <li key={s.key} className="relative flex min-w-[5.5rem] flex-1 flex-col items-center text-center">
    {i > 0 && <span aria-hidden className={`absolute right-1/2 top-[15px] h-0.5 w-full ${s.state === 'done' || s.state === 'alert' || s.state === 'current' ? 'bg-emerald-500' : 'bg-slate-200'}`} />}
    <span aria-hidden className={`relative grid h-8 w-8 place-items-center rounded-full ${dot(s.state)}`}><StepIcon state={s.state} /></span>
    <span className={`mt-2 text-xs font-bold sm:text-sm ${s.state === 'pending' ? 'font-medium text-slate-500' : 'text-slate-800'}`}>{s.label}</span>
    {s.value ?? <><span className="text-xs tabular-nums text-slate-500">{dayTime(s.at)[0]}</span><span className="text-xs tabular-nums text-slate-500">{dayTime(s.at)[1] || (s.at ? '' : '')}</span></>}
    {s.note && <span className="sr-only">{s.note}</span>}
  </li>)}</ol>
}

export function Callout({ title, children, tone = 'info' }: { title: ReactNode; children?: ReactNode; tone?: 'info' | 'warning' }) {
  return <div className={`mt-4 flex items-start gap-3 rounded-lg border p-3 ${tone === 'info' ? 'border-blue-100 bg-blue-50' : 'border-amber-200 bg-amber-50'}`}>
    <Info aria-hidden className={`mt-0.5 h-5 w-5 shrink-0 ${tone === 'info' ? 'fill-blue-600 text-white' : 'fill-amber-500 text-white'}`} />
    <div className="min-w-0 text-sm"><p className="font-semibold text-jrm-navy">{title}</p>{children && <div className="text-slate-600">{children}</div>}</div>
  </div>
}

/** Cronología vertical con línea de unión: hito, fecha y descripción. */
export function MilestoneList({ steps, columns = true }: { steps: Milestone[]; columns?: boolean }) {
  return <ol className="relative">{steps.map((s, i) => <li key={s.key} className="relative flex items-start gap-3 pb-4 last:pb-0">
    {i < steps.length - 1 && <span aria-hidden className={`absolute left-[11px] top-6 h-[calc(100%-1rem)] w-0.5 ${s.state === 'done' ? 'bg-emerald-500' : 'bg-slate-200'}`} />}
    <span aria-hidden className={`relative mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full ${dot(s.state)}`}><StepIcon state={s.state} small /></span>
    {columns ? <div className="grid min-w-0 flex-1 gap-x-4 sm:grid-cols-[minmax(0,9rem)_minmax(0,9rem)_minmax(0,1fr)]">
      <p className="font-semibold text-slate-800">{s.label}</p><p className="text-sm tabular-nums text-slate-600">{s.at ? detailTime(s.at) : '—'}</p><p className="text-sm text-slate-500">{s.note}</p>
    </div> : <div className="grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4">
      <p className="font-semibold text-slate-800">{s.label}</p>
      <div className="min-w-0"><p className="text-sm tabular-nums text-slate-700">{s.at ? detailTime(s.at) : 'Pendiente'}</p><p className="text-xs text-slate-500">{s.note}</p></div>
    </div>}
  </li>)}</ol>
}

/** Pendientes en tarjetas naranja (no se resuelven desde aquí). */
export function PendingList({ items, onGo, goLabel = 'Ver' }: { items: Pending[]; onGo?: (tab: DetailTab) => void; goLabel?: string }) {
  if (!items.length) return <p className="text-sm text-slate-500">Sin pendientes registrados para esta entrega.</p>
  return <ul className="space-y-2.5">{items.map(p => <li key={p.key} className="flex items-start gap-3 rounded-lg border border-orange-200 bg-orange-50/70 p-3">
    <FileText aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-orange-600" />
    <div className="min-w-0 flex-1"><p className="text-sm font-semibold text-orange-700">{p.title}</p><p className="text-xs text-slate-600">{p.detail}</p></div>
    {onGo && <button type="button" onClick={() => onGo(p.tab)} className="min-h-9 shrink-0 rounded-lg border border-slate-300 bg-white px-2.5 text-xs font-semibold text-jrm-navy">{goLabel}</button>}
  </li>)}</ul>
}

export function SourcesWarning({ failed }: { failed: string[] }) {
  if (!failed.length) return null
  return <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">Parte del historial no está disponible por ahora ({failed.join(', ')}). Se muestra lo que sí está registrado.</p>
}

export const IconButton = ({ label, onClick, href, download, children, danger = false, disabled = false }: { label: string; onClick?: () => void; href?: string; download?: boolean; children: ReactNode; danger?: boolean; disabled?: boolean }) => {
  const cls = `grid h-9 w-9 shrink-0 place-items-center rounded-lg border bg-white ${danger ? 'border-rose-200 text-rose-600 hover:bg-rose-50' : 'border-slate-300 text-jrm-navy hover:bg-slate-50'} disabled:opacity-40`
  return href ? <a href={href} target={download ? undefined : '_blank'} rel="noreferrer" download={download || undefined} aria-label={label} title={label} className={cls}>{children}</a>
    : <button type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label} className={cls}>{children}</button>
}

/** Imagen de Storage con URL firmada (no pasa por el optimizador de Next). */
export function Img(props: React.ImgHTMLAttributes<HTMLImageElement> & { alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img {...props} />
}

/** Vista previa con URL firmada: imagen o PDF en la página; otros formatos solo se abren o descargan. */
export function FilePreview({ url, path, mime, title, height = 'h-[24rem]' }: { url: string | null | undefined; path: string; mime?: string | null; title: string; height?: string }) {
  if (!url) return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Archivo no disponible o sin permiso para verlo.</p>
  return <div className="space-y-2">
    <div className="relative overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
      {isImage(path, mime) ? <Img src={url} alt={title} className={`${height} w-full object-contain`} />
        : isPdfFile(path, mime) ? <iframe src={url} title={title} className={`${height} w-full bg-white`} />
        : <p className={`${height} grid place-items-center p-6 text-center text-sm text-slate-600`}>Este formato no tiene vista previa.</p>}
      <a href={url} target="_blank" rel="noreferrer" aria-label="Ampliar" title="Ampliar" className="absolute bottom-3 right-3 grid h-9 w-9 place-items-center rounded-lg bg-slate-900/80 text-white"><Maximize2 className="h-4 w-4" /></a>
    </div>
    <div className="flex flex-wrap gap-2">
      <a href={url} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy"><ExternalLink className="h-4 w-4" aria-hidden />Abrir</a>
      <a href={downloadUrl(url)} download className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy"><Download className="h-4 w-4" aria-hidden />Descargar</a>
    </div>
  </div>
}
