'use client'

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Calculator, CheckCircle2, ChevronDown, CircleHelp, CircleSlash, FlaskConical, Info, Search, X } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import type { Kpi, KpiStatus } from '@/lib/apt-analitica/types'
import type { Severity } from '@/lib/apt-analitica/quality'
import { useAnalitica } from './context'

// Piezas visuales de la analítica. Colores con significado: entradas azul, salidas naranja; el estado de un indicador
// (calculado, estimado, no disponible) siempre va con ícono y texto, nunca solo con color.

export const COLORS = { entradas: '#2a78d6', salidas: '#eb6834', neta: '#334155', grid: '#e2e8f0', axis: '#64748b', seq: ['#dbeafe', '#93c5fd', '#3b82f6', '#1d4ed8', '#1e3a8a'] }
export const CATEGORICAL = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']

export const fmtNum = (n: number | null | undefined, d = 2) => n === null || n === undefined || !Number.isFinite(n) ? '—'
  : n.toLocaleString('es-PE', { maximumFractionDigits: d, minimumFractionDigits: 0 })
export const fmtPct = (n: number | null | undefined, d = 1) => n === null || n === undefined || !Number.isFinite(n) ? '—' : `${(n * 100).toLocaleString('es-PE', { maximumFractionDigits: d, minimumFractionDigits: d })} %`
export const fmtDate = (d: string | null | undefined) => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '—'
export const fmtDateTime = (d: string | null | undefined) => d ? new Date(d).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export function fmtKpi(k: Pick<Kpi, 'value' | 'unit'>) {
  if (k.value === null) return 'No disponible'
  if (k.unit === '%') return fmtPct(k.value)
  if (k.unit === 'días') return `${fmtNum(k.value, 2)} d`
  return fmtNum(k.value)
}

const STATUS: Record<KpiStatus, { label: string; cls: string; icon: ReactNode }> = {
  CALCULADO: { label: 'Calculado', cls: 'border-emerald-200 bg-emerald-50 text-emerald-800', icon: <Calculator className="h-3 w-3" aria-hidden /> },
  ESTIMADO: { label: 'Estimado', cls: 'border-amber-200 bg-amber-50 text-amber-800', icon: <FlaskConical className="h-3 w-3" aria-hidden /> },
  NO_DISPONIBLE: { label: 'No disponible', cls: 'border-slate-200 bg-slate-100 text-slate-600', icon: <CircleSlash className="h-3 w-3" aria-hidden /> },
}
export function StatusBadge({ status }: { status: KpiStatus }) {
  const s = STATUS[status]
  return <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${s.cls}`}>{s.icon}{s.label}</span>
}

const SEV: Record<Severity, { label: string; cls: string; icon: ReactNode }> = {
  ALTA: { label: 'Alta', cls: 'border-red-200 bg-red-50 text-red-800', icon: <AlertTriangle className="h-3 w-3" aria-hidden /> },
  MEDIA: { label: 'Media', cls: 'border-amber-200 bg-amber-50 text-amber-800', icon: <AlertTriangle className="h-3 w-3" aria-hidden /> },
  BAJA: { label: 'Baja', cls: 'border-sky-200 bg-sky-50 text-sky-800', icon: <Info className="h-3 w-3" aria-hidden /> },
  INFO: { label: 'Decisión pendiente', cls: 'border-violet-200 bg-violet-50 text-violet-800', icon: <CircleHelp className="h-3 w-3" aria-hidden /> },
}
export function SeverityBadge({ severity }: { severity: Severity }) {
  const s = SEV[severity]
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-bold uppercase ${s.cls}`}>{s.icon}{s.label}</span>
}

/** Tarjeta de indicador: valor, unidad, estado, período/cobertura y acceso a la definición y los registros */
export function KpiTile({ kpi, extra }: { kpi: Kpi; extra?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`${kpi.label}: ${fmtKpi(kpi)}. Ver definición y registros`}
        className="group flex min-h-[8.5rem] flex-col rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-[#002855]/40 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[#002855]">
        <div className="flex w-full items-start justify-between gap-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-slate-600">{kpi.label}</p>
          <StatusBadge status={kpi.status} />
        </div>
        <p className={`mt-2 break-words font-black tabular-nums tracking-tight ${kpi.value === null ? 'text-base text-slate-500' : 'text-2xl text-slate-900'}`}>
          {fmtKpi(kpi)}{kpi.value !== null && kpi.unit && kpi.unit !== '%' && kpi.unit !== 'días' && <span className="ml-1 text-sm font-semibold text-slate-500">{kpi.unit}</span>}
        </p>
        <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-slate-600">{kpi.value === null ? kpi.missing : kpi.hint}</p>
        {extra}
        <span className="mt-auto pt-2 text-[11px] font-semibold text-[#002855] opacity-80 group-hover:opacity-100">Definición y registros →</span>
      </button>
      {open && <KpiDrawer kpi={kpi} onClose={() => setOpen(false)} />}
    </>
  )
}

export function KpiDrawer({ kpi, onClose }: { kpi: Kpi; onClose: () => void }) {
  const { openDrill, analysis } = useAnalitica()
  const issues = analysis.issues.filter(i => kpi.issues.includes(i.code))
  return (
    <Modal isOpen onClose={onClose} title={kpi.label} maxWidth="max-w-2xl"
      footer={<div className="flex flex-wrap justify-end gap-2">
        {kpi.recordIds.length > 0 && <button type="button" onClick={() => { onClose(); openDrill(kpi.label, kpi.recordIds) }}
          className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white">Ver {kpi.recordIds.length.toLocaleString('es-PE')} registro(s)</button>}
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm">Cerrar</button>
      </div>}>
      <div className="space-y-4 text-sm text-slate-700">
        <div className="flex flex-wrap items-center gap-2"><StatusBadge status={kpi.status} /><span className="text-xl font-black text-slate-900">{fmtKpi(kpi)}</span>
          {kpi.unit && kpi.unit !== '%' && kpi.value !== null && <span className="text-slate-500">{kpi.unit}</span>}</div>
        {kpi.missing && <p className="rounded-lg border border-slate-200 bg-slate-50 p-3"><b>Falta información:</b> {kpi.missing}</p>}
        <section><h4 className="text-xs font-bold uppercase text-slate-500">Definición</h4><p className="mt-1">{kpi.definition}</p></section>
        <section><h4 className="text-xs font-bold uppercase text-slate-500">Fórmula</h4><p className="mt-1 font-mono text-[13px]">{kpi.formula}</p></section>
        {(kpi.numerator || kpi.denominator) && <dl className="grid gap-2 sm:grid-cols-2">
          {kpi.numerator && <div className="rounded-lg border border-slate-200 p-2"><dt className="text-xs text-slate-500">Numerador · {kpi.numerator.label}</dt><dd className="font-bold tabular-nums">{fmtNum(kpi.numerator.value)}</dd></div>}
          {kpi.denominator && <div className="rounded-lg border border-slate-200 p-2"><dt className="text-xs text-slate-500">Denominador · {kpi.denominator.label}</dt><dd className="font-bold tabular-nums">{fmtNum(kpi.denominator.value)}</dd></div>}
        </dl>}
        {kpi.coverage !== undefined && <p><b>Cobertura:</b> {fmtPct(kpi.coverage)}</p>}
        {kpi.exclusions.length > 0 && <section><h4 className="text-xs font-bold uppercase text-slate-500">Exclusiones</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{kpi.exclusions.map(x => <li key={x}>{x}</li>)}</ul></section>}
        {issues.length > 0 && <section><h4 className="text-xs font-bold uppercase text-slate-500">Problemas de datos que afectan el resultado</h4>
          <ul className="mt-1 space-y-1">{issues.map(i => <li key={i.code} className="flex flex-wrap items-center gap-2"><SeverityBadge severity={i.severity} />{i.title}
            {i.count > 0 && <span className="text-xs text-slate-500">({i.count.toLocaleString('es-PE')} filas)</span>}</li>)}</ul></section>}
      </div>
    </Modal>
  )
}

export function Card({ title, subtitle, actions, children, className = '', id }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`flex min-w-0 flex-col rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0"><h3 className="text-sm font-bold text-slate-800">{title}</h3>{subtitle && <p className="mt-0.5 text-xs text-slate-600">{subtitle}</p>}</div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="min-w-0 flex-1 p-4">{children}</div>
    </section>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-slate-300 p-6 text-center">
    <CircleSlash className="h-5 w-5 text-slate-400" aria-hidden /><p className="text-sm font-semibold text-slate-700">{title}</p>
    {children && <div className="max-w-md text-xs text-slate-600">{children}</div>}
  </div>
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'ok'; children: ReactNode }) {
  const cls = tone === 'warn' ? 'border-amber-200 bg-amber-50 text-amber-900' : tone === 'ok' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-sky-200 bg-sky-50 text-sky-900'
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'ok' ? CheckCircle2 : Info
  return <div role="note" className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${cls}`}><Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /><div>{children}</div></div>
}

/** Selector múltiple con búsqueda, accesible por teclado */
export function MultiSelect({ label, options, value, onChange, placeholder = 'Todos', render }: {
  label: string; options: string[]; value: string[]; onChange: (v: string[]) => void; placeholder?: string; render?: (v: string) => string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open])
  const shown = useMemo(() => {
    const t = q.trim().toUpperCase()
    const list = t ? options.filter(o => (render ? render(o) : o).toUpperCase().includes(t)) : options
    return list.slice(0, 200)
  }, [options, q, render])
  const toggle = (o: string) => onChange(value.includes(o) ? value.filter(x => x !== o) : [...value, o])
  const text = value.length === 0 ? placeholder : value.length === 1 ? (render ? render(value[0]) : value[0]) : `${value.length} seleccionados`
  return (
    <div ref={ref} className="relative min-w-0">
      <span id={`${id}-l`} className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}</span>
      <button type="button" aria-labelledby={`${id}-l`} aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
        className={`flex h-9 w-full min-w-0 items-center justify-between gap-1 rounded-lg border px-2 text-left text-xs ${value.length ? 'border-[#002855] bg-[#002855]/5 font-semibold text-[#002855]' : 'border-slate-300 bg-white text-slate-700'}`}>
        <span className="min-w-0 truncate">{text}</span><ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
      </button>
      {open && <div className="absolute left-0 z-40 mt-1 w-72 max-w-[85vw] rounded-lg border border-slate-200 bg-white p-2 shadow-xl">
        <label className="flex items-center gap-1 rounded-md border border-slate-300 px-2"><Search className="h-3.5 w-3.5 text-slate-400" aria-hidden />
          <input autoFocus value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }}
            placeholder="Buscar…" aria-label={`Buscar en ${label}`} className="h-8 min-w-0 flex-1 text-xs outline-none" /></label>
        <div role="listbox" aria-multiselectable aria-label={label} className="mt-1 max-h-64 overflow-y-auto">
          {shown.length === 0 && <p className="p-2 text-xs text-slate-500">Sin opciones</p>}
          {shown.map(o => <label key={o} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs hover:bg-slate-50">
            <input type="checkbox" checked={value.includes(o)} onChange={() => toggle(o)} className="mt-0.5" />
            <span className="break-all">{render ? render(o) : o}</span></label>)}
          {options.length > shown.length && <p className="p-1 text-[11px] text-slate-500">Mostrando {shown.length} de {options.length.toLocaleString('es-PE')}: escriba para buscar.</p>}
        </div>
        {value.length > 0 && <button type="button" onClick={() => onChange([])} className="mt-1 flex items-center gap-1 text-xs font-semibold text-[#cf152d]"><X className="h-3 w-3" aria-hidden />Quitar selección</button>}
      </div>}
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return <div role="radiogroup" aria-label={label} className="inline-flex flex-wrap rounded-lg border border-slate-300 bg-white p-0.5">
    {options.map(o => <button key={o.id} type="button" role="radio" aria-checked={value === o.id} onClick={() => onChange(o.id)}
      className={`rounded-md px-2.5 py-1 text-xs font-semibold ${value === o.id ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-100'}`}>{o.label}</button>)}
  </div>
}

/** Tooltip común de recharts: valores en texto (no en el color de la serie) */
export function ChartTip({ active, payload, label, unit, labelFmt }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string | number; unit?: string | null; labelFmt?: (l: string) => string }) {
  if (!active || !payload?.length) return null
  return <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
    <p className="mb-1 font-bold text-slate-800">{labelFmt ? labelFmt(String(label)) : label}</p>
    {payload.map(p => <p key={p.name} className="flex items-center gap-2 text-slate-700"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} aria-hidden />
      {p.name}: <b className="tabular-nums">{fmtNum(p.value)}</b> {unit}</p>)}
  </div>
}
