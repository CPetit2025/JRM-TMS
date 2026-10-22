'use client'

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowRight, Clock, History, Layers, Timer } from 'lucide-react'
import { fmtDec1, fmtInt, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, ALMACEN_ROL, type FlowAlmacenCard } from '@/lib/apt/flowTypes'

// Piezas comunes de las pantallas "Resumen del flujo" y "Stock por almacén".

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
export const mesLabel = (m: string) => {
  const [y, mm] = m.slice(0, 10).split('-')
  return `${MESES[Number(mm) - 1] ?? mm} ${y?.slice(2) ?? ''}`
}
export const semanaLabel = (f: string) => {
  const [, m, d] = f.slice(0, 10).split('-')
  return `${d}/${m}`
}

export const AXIS_TICK = { fontSize: 11, fill: '#64748b' }

// Carga de datos con clave: recarga cuando cambia `key` (filtros) o al reintentar; conserva los datos previos mientras carga.
export function useFlowQuery<T>(key: string, fetcher: () => Promise<T>) {
  const [nonce, setNonce] = useState(0)
  const reqKey = `${key}|${nonce}`
  const [res, setRes] = useState<{ key: string; data: T | null; error: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    fetcher()
      .then(data => { if (alive) setRes({ key: reqKey, data, error: null }) })
      .catch((e: Error) => { if (alive) setRes(prev => ({ key: reqKey, data: prev?.data ?? null, error: e.message })) })
    return () => { alive = false }
  }, [fetcher, reqKey])
  const loading = res?.key !== reqKey
  return { data: res?.data ?? null, error: !loading ? res?.error ?? null : null, loading, retry: () => setNonce(n => n + 1) }
}

// Tooltip común de los gráficos del flujo
export function FlowTip({ title, subtitle, rows }: { title: ReactNode; subtitle?: ReactNode; rows: Array<[string, ReactNode, string?]> }) {
  return (
    <div className="max-w-xs rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="font-bold text-slate-800">{title}</p>
      {subtitle && <p className="mt-0.5 leading-snug text-slate-500">{subtitle}</p>}
      <div className="mt-1.5 space-y-0.5">
        {rows.map(([k, v, color], i) => (
          <div key={`${k}-${i}`} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-slate-500">
              {color && <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />}{k}
            </span>
            <span className="font-semibold tabular-nums text-slate-800">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export function LegendDot({ color, label, line, hatch }: { color: string; label: string; line?: boolean; hatch?: boolean }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      <span className={line ? 'h-0.5 w-3' : 'h-2 w-2 rounded-sm'}
        style={hatch ? { background: `repeating-linear-gradient(45deg, ${color} 0 2px, #f1f5f9 2px 4px)` } : { background: color }} />
      {label}
    </span>
  )
}

// Tarjeta de almacén: saldo, edad, días en el almacén y stock previo
export function ResumenAlmacenCard({ card, href, active, onClick, total }: {
  card: FlowAlmacenCard; href?: string; active?: boolean; onClick?: () => void; total?: number
}) {
  const color = ALMACEN_COLOR[card.almacen]
  const inicialPct = card.saldo_tn > 0 && card.inicial_tn ? (card.inicial_tn / card.saldo_tn) * 100 : 0
  const share = total && total > 0 ? (card.saldo_tn / total) * 100 : null
  const body = (
    <>
      <span className="absolute inset-y-0 left-0 w-1.5" style={{ background: color }} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-black uppercase tracking-wider" style={{ color }}>{ALMACEN_LABEL[card.almacen]}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">{ALMACEN_ROL[card.almacen]}</p>
        </div>
        {href && <ArrowRight className="h-4 w-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-600" />}
      </div>
      <p className="mt-2 text-2xl font-black tabular-nums tracking-tight text-slate-900">
        {fmtTn(card.saldo_tn)}<span className="ml-1 text-sm font-semibold text-slate-400">TN</span>
        {share !== null && <span className="ml-2 text-xs font-semibold text-slate-400">{fmtDec1(share)} % del saldo</span>}
      </p>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
        <div title="Edad ponderada por TN: días desde la producción">
          <p className="flex items-center gap-1 text-slate-400"><Timer className="h-3 w-3" />Edad pond.</p>
          <p className="font-bold tabular-nums text-slate-800">{card.edad_pond === null ? '—' : `${fmtDec1(card.edad_pond)} d`}</p>
        </div>
        <div title="Días ponderados desde que el material llegó a este almacén">
          <p className="flex items-center gap-1 text-slate-400"><Clock className="h-3 w-3" />En almacén</p>
          <p className="font-bold tabular-nums text-slate-800">{card.dias_almacen_pond === null ? '—' : `${fmtDec1(card.dias_almacen_pond)} d`}</p>
        </div>
        <div title="Lotes y capas con saldo">
          <p className="flex items-center gap-1 text-slate-400"><Layers className="h-3 w-3" />Lotes</p>
          <p className="font-bold tabular-nums text-slate-800">{fmtInt(card.lotes)} <span className="font-normal text-slate-400">· {fmtInt(card.capas)} capas</span></p>
        </div>
      </div>
      <div className="mt-2 border-t border-slate-100 pt-2" title="Stock previo: existía antes del primer día cargado; su antigüedad real es desconocida">
        <div className="flex items-center justify-between text-[11px]">
          <span className="flex items-center gap-1 text-slate-500"><History className="h-3 w-3" />Stock previo (sin fecha)</span>
          <span className="font-semibold tabular-nums text-slate-700">{fmtTn(card.inicial_tn ?? 0)} TN · {fmtDec1(inicialPct)} %</span>
        </div>
        <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-slate-100">
          <div style={{ width: `${100 - inicialPct}%`, background: color }} />
          <div style={{ width: `${inicialPct}%`, background: 'repeating-linear-gradient(45deg,#94a3b8 0 2px,#e2e8f0 2px 4px)' }} />
        </div>
      </div>
    </>
  )
  const cls = `group relative block overflow-hidden rounded-xl border bg-white p-4 pl-5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md ${
    active ? '' : 'border-slate-200'}`
  const style = active ? { borderColor: color, boxShadow: `0 0 0 2px ${color}33` } : undefined
  if (href) return <Link href={href} className={cls} style={style}>{body}</Link>
  if (onClick) return <button type="button" onClick={onClick} className={`w-full ${cls}`} style={style}>{body}</button>
  return <div className={cls} style={style}>{body}</div>
}
