'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, Info, Loader2, PackageOpen } from 'lucide-react'
import { ESTADO_STYLE, TIPO_LABEL, TONE_CLASS, diasTone, fmtDias } from '@/lib/apt/format'
import type { AptEstado, AptTipoLote } from '@/lib/apt/types'

// Piezas visuales comunes del módulo APT (tarjetas KPI, contenedor de gráficos, insignias y estados vacíos)

export function KpiCard({ label, value, unit, hint, tone = 'default', icon, onClick, active }: {
  label: string; value: ReactNode; unit?: string; hint?: ReactNode; tone?: 'default' | 'navy' | 'warn' | 'crit' | 'ok'
  icon?: ReactNode; onClick?: () => void; active?: boolean
}) {
  const accent = { default: 'text-slate-900', navy: 'text-[#002855]', warn: 'text-amber-600', crit: 'text-red-600', ok: 'text-emerald-600' }[tone]
  const bar = { default: 'bg-slate-300', navy: 'bg-[#002855]', warn: 'bg-amber-500', crit: 'bg-red-600', ok: 'bg-emerald-500' }[tone]
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} className={`group relative overflow-hidden rounded-xl border bg-white p-4 text-left shadow-sm transition-all ${
      onClick ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md' : ''} ${active ? 'border-[#002855] ring-2 ring-[#002855]/15' : 'border-slate-200'}`}>
      <span className={`absolute inset-x-0 top-0 h-1 ${bar} opacity-80`} />
      <div className="flex items-start justify-between gap-2">
        <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
        {icon && <span className="text-slate-400 transition-colors group-hover:text-[#002855]">{icon}</span>}
      </div>
      <p className={`mt-2 text-2xl font-black tabular-nums tracking-tight ${accent}`}>
        {value}{unit && <span className="ml-1 text-sm font-semibold text-slate-400">{unit}</span>}
      </p>
      {hint && <div className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</div>}
    </Comp>
  )
}

export function ChartCard({ title, subtitle, info, actions, children, className = '', bodyClassName = '' }: {
  title: ReactNode; subtitle?: ReactNode; info?: string; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string
}) {
  return (
    <section className={`flex flex-col rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
            {title}
            {info && (
              <span className="group relative inline-flex">
                <Info className="h-3.5 w-3.5 cursor-help text-slate-400" />
                <span className="pointer-events-none absolute left-1/2 top-5 z-30 hidden w-64 -translate-x-1/2 rounded-lg bg-slate-900 p-2 text-[11px] font-normal leading-snug text-white shadow-lg group-hover:block">
                  {info}
                </span>
              </span>
            )}
          </h3>
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      <div className={`flex-1 p-4 ${bodyClassName}`}>{children}</div>
    </section>
  )
}

export function EstadoBadge({ estado }: { estado: AptEstado | string | null | undefined }) {
  if (!estado) return <span className="text-slate-400">—</span>
  const s = ESTADO_STYLE[estado as AptEstado]
  return (
    <span title={s?.help} className={`inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${s?.cls || 'border-slate-200 bg-slate-50 text-slate-600'}`}>
      {estado}
    </span>
  )
}

export function TipoBadge({ tipo }: { tipo: AptTipoLote | string | null | undefined }) {
  if (!tipo) return null
  const cls = tipo === 'SUBCONTRATO' ? 'bg-sky-50 text-sky-700 border-sky-200' : tipo === 'ERROR' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-700 border-slate-200'
  return <span className={`inline-flex whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase ${cls}`}>{TIPO_LABEL[tipo as AptTipoLote] || tipo}</span>
}

export function DiasBadge({ dias, alert = 60 }: { dias: number | null | undefined; alert?: number }) {
  const tone = diasTone(dias, alert)
  return <span className={`inline-flex min-w-[2.5rem] justify-center rounded-md border px-1.5 py-0.5 text-xs font-bold tabular-nums ${TONE_CLASS[tone]}`}>{fmtDias(dias)}</span>
}

export function LoadingBlock({ label = 'Calculando…', className = 'h-64' }: { label?: string; className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-2 text-sm text-slate-400 ${className}`}>
      <Loader2 className="h-4 w-4 animate-spin" /> {label}
    </div>
  )
}

export function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">
      <AlertTriangle className="h-5 w-5" />
      <p>{message}</p>
      {onRetry && <button onClick={onRetry} className="rounded-lg border border-red-300 bg-white px-3 py-1 text-xs font-semibold hover:bg-red-100">Reintentar</button>}
    </div>
  )
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
      <PackageOpen className="h-8 w-8 text-slate-300" />
      <p className="font-semibold text-slate-700">{title}</p>
      {children && <div className="max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  )
}

// Barra horizontal mínima para tablas (proporción de un valor contra el máximo)
export function InlineBar({ value, max, color = '#002855' }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.max(2, Math.min(100, (value / max) * 100)) : 0
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-100">
      <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}
