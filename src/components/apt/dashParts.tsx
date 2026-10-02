'use client'

import type { ReactNode } from 'react'
import Link from 'next/link'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { fmtDate, fmtDec1, fmtDias, fmtPct, fmtTn } from '@/lib/apt/format'
import { loteHref } from '@/lib/apt/useAptFilters'
import type { AptAgingBucket, AptDashboard, AptFilters, AptGrain, AptLoteTop } from '@/lib/apt/types'
import { DiasBadge, EstadoBadge, InlineBar, TipoBadge } from './ui'
import { diasColor, periodoLabel, short } from './dashCharts'

// Piezas del dashboard APT: indicadores compactos, "Respuestas clave" y tabla "¿Qué liberar primero?"

export function MiniKpi({ label, value, hint, tone = 'default', onClick, active }: {
  label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'warn' | 'crit' | 'ok'; onClick?: () => void; active?: boolean
}) {
  const color = { default: 'text-slate-900', warn: 'text-amber-600', crit: 'text-red-600', ok: 'text-emerald-600' }[tone]
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} className={`rounded-lg border bg-white px-3 py-2 text-left shadow-sm transition-colors ${
      onClick ? 'cursor-pointer hover:border-[#002855]/40 hover:bg-slate-50' : ''} ${active ? 'border-[#002855] ring-2 ring-[#002855]/15' : 'border-slate-200'}`}>
      <p className="truncate text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-0.5 text-lg font-black tabular-nums tracking-tight ${color}`}>{value}</p>
      {hint && <p className="truncate text-[11px] text-slate-500">{hint}</p>}
    </Comp>
  )
}

const linkCls = 'font-bold text-[#002855] underline decoration-[#002855]/30 underline-offset-2 hover:decoration-[#002855]'

function Item({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2 py-1.5 text-[13px] leading-snug text-slate-600">
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#cf152d]" />
      <span>{children}</span>
    </li>
  )
}

// Frases generadas a partir de los datos del dashboard (sección 37 del requerimiento)
export function RespuestasClave({ d, filters, grain, onProducto }: {
  d: AptDashboard; filters: AptFilters; grain: AptGrain; onProducto: (producto: string) => void
}) {
  const k = d.kpis
  const lote = (l: string) => <Link href={loteHref(l, filters)} className={linkCls}>{l}</Link>
  const prod = (p: string, glosa: string | null) => (
    <button onClick={() => onProducto(p)} className={`${linkCls} text-left`} title={`Filtrar producto ${p}`}>{short(glosa || p, 60)}</button>
  )
  const t = d.trend
  const last = t[t.length - 1], prev = t[t.length - 2]
  const delta = last && prev ? last.saldo_tn - prev.saldo_tn : null
  const deltaPct = delta !== null && prev && prev.saldo_tn > 0 ? (delta / prev.saldo_tn) * 100 : null
  const unidad = { dia: 'día', semana: 'semana', mes: 'mes' }[grain]
  const p = d.pareto

  return (
    <ul className="divide-y divide-slate-100">
      <Item>
        Hay <b className="text-slate-900">{fmtTn(k.tn_saldo)} TN</b> en APT al {fmtDate(d.cutoff)}, repartidas en{' '}
        <b className="text-slate-900">{fmtDias(k.lotes_activos)}</b> NumRel y <b className="text-slate-900">{fmtDias(k.productos_apt)}</b> productos.
      </Item>
      {k.lote_mayor_tn && <Item>El lote con más material es {lote(k.lote_mayor_tn.lote)} con <b className="text-slate-900">{fmtTn(k.lote_mayor_tn.tn)} TN</b>.</Item>}
      {k.lote_mas_antiguo && (
        <Item>
          El lote más antiguo es {lote(k.lote_mas_antiguo.lote)}: <b className="text-red-600">{fmtDias(k.lote_mas_antiguo.dias)} días</b> en APT
          ({fmtTn(k.lote_mas_antiguo.tn)} TN de saldo).
        </Item>
      )}
      {k.lote_mayor_txd && (
        <Item>
          Mayor impacto (TN×Días): {lote(k.lote_mayor_txd.lote)} con <b className="text-slate-900">{fmtTn(k.lote_mayor_txd.tn_dias)}</b>;{' '}
          es el primero a liberar.
        </Item>
      )}
      {k.producto_mayor_tn && (
        <Item>Producto con más TN: {prod(k.producto_mayor_tn.producto, k.producto_mayor_tn.glosa)} ({fmtTn(k.producto_mayor_tn.tn)} TN).</Item>
      )}
      {k.producto_mas_antiguo && (
        <Item>
          Mayor permanencia: {prod(k.producto_mas_antiguo.producto, k.producto_mas_antiguo.glosa)} con{' '}
          <b className="text-red-600">{fmtDias(k.producto_mas_antiguo.dias)} días</b>.
        </Item>
      )}
      <Item>
        De las TN en APT, <b className="text-slate-900">{fmtPct(k.pct_gt7)}</b> supera 7 días, <b className="text-amber-600">{fmtPct(k.pct_gt15)}</b> supera 15 y{' '}
        <b className="text-red-600">{fmtPct(k.pct_gt30)}</b> supera 30 días.
      </Item>
      {p.lotes_80 !== null && (
        <Item>
          Concentración: <b className="text-slate-900">{fmtDias(p.lotes_80)}</b> lotes ({fmtPct(p.pct_lotes_80)} de {fmtDias(p.lotes_con_saldo)}) suman el 80 % de las TN;
          los 10 mayores concentran <b className="text-slate-900">{fmtPct(p.top10_pct)}</b>.
        </Item>
      )}
      {delta !== null && last && prev && (
        <Item>
          <span className="inline-flex items-center gap-1">
            La carga {Math.abs(delta) < 0.0005 ? 'se mantiene' : delta > 0 ? 'aumenta' : 'disminuye'}
            {delta > 0.0005 ? <ArrowUpRight className="h-4 w-4 text-red-600" /> : delta < -0.0005 ? <ArrowDownRight className="h-4 w-4 text-emerald-600" /> : <Minus className="h-4 w-4 text-slate-400" />}
          </span>{' '}
          respecto al {unidad} anterior: {fmtTn(prev.saldo_tn)} → <b className="text-slate-900">{fmtTn(last.saldo_tn)} TN</b>
          {deltaPct !== null && <> ({delta > 0 ? '+' : ''}{fmtDec1(deltaPct)} %)</>}; aging ponderado {fmtDec1(prev.aging_pond)} → {fmtDec1(last.aging_pond)} días
          {' '}<span className="text-slate-400">({periodoLabel(prev.periodo, grain)} vs {periodoLabel(last.periodo, grain)})</span>.
        </Item>
      )}
    </ul>
  )
}

// Tabla de prioridad de liberación (TOP por TN×Días)
export function LiberarTable({ rows, aging, alert, filters }: { rows: AptLoteTop[]; aging: AptAgingBucket[]; alert: number; filters: AptFilters }) {
  const sorted = [...rows].sort((a, b) => b.tn_dias - a.tn_dias)
  const max = sorted[0]?.tn_dias || 0
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-xs">
        <thead className="sticky top-0 bg-white">
          <tr className="border-b border-slate-200 text-[10px] uppercase tracking-wider text-slate-400">
            <th className="px-2 py-2 text-left font-semibold">#</th>
            <th className="px-2 py-2 text-left font-semibold">Lote</th>
            <th className="px-2 py-2 text-left font-semibold">Glosa principal</th>
            <th className="px-2 py-2 text-right font-semibold">Saldo TN</th>
            <th className="px-2 py-2 text-center font-semibold">Días</th>
            <th className="px-2 py-2 text-left font-semibold">TN×Días</th>
            <th className="px-2 py-2 text-left font-semibold">Estado</th>
            <th className="px-2 py-2 text-right font-semibold">F. Entrega</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => (
            <tr key={r.lote} className="border-b border-slate-100 hover:bg-slate-50">
              <td className="px-2 py-1.5 font-bold tabular-nums text-slate-400">{i + 1}</td>
              <td className="px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <Link href={loteHref(r.lote, filters)} className="font-bold text-[#002855] hover:underline">{r.lote}</Link>
                  {r.tipo !== 'CONTRATO' && <TipoBadge tipo={r.tipo} />}
                </div>
              </td>
              <td className="max-w-[220px] px-2 py-1.5 text-slate-600" title={r.glosa || ''}>
                <span className="line-clamp-1">{r.glosa || '—'}</span>
                {r.productos > 1 && <span className="text-[10px] text-slate-400">+{r.productos - 1} productos</span>}
              </td>
              <td className="px-2 py-1.5 text-right font-semibold tabular-nums text-slate-800">{fmtTn(r.tn_saldo)}</td>
              <td className="px-2 py-1.5 text-center"><DiasBadge dias={r.dias} alert={alert} /></td>
              <td className="px-2 py-1.5">
                <div className="flex min-w-[120px] items-center gap-2">
                  <span className="w-16 text-right font-bold tabular-nums text-slate-800">{fmtTn(r.tn_dias)}</span>
                  <div className="flex-1"><InlineBar value={r.tn_dias} max={max} color={diasColor(r.dias, aging)} /></div>
                </div>
              </td>
              <td className="px-2 py-1.5"><EstadoBadge estado={r.estado} /></td>
              <td className="px-2 py-1.5 text-right tabular-nums text-slate-600">{fmtDate(r.fecha_entrega)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
