'use client'

import { X } from 'lucide-react'
import type { FilaDetalle, KpiResultado } from '@/lib/indicadores/api'
import { num, valorTxt } from '@/lib/indicadores/format'

export type Filtros = Record<string, string>
const sin = (f: Filtros, k: string) => Object.fromEntries(Object.entries(f).filter(([x]) => x !== k))

// Valor de un registro en una dimensión, como texto (solo dimensiones de categoría: texto o sí/no)
const valorDim = (f: FilaDetalle, k: string) => { const v = f.dims?.[k]; return typeof v === 'boolean' ? (v ? 'sí' : 'no') : typeof v === 'string' && !/^\d{4}-\d{2}-\d{2}/.test(v) ? v : null }
export const aplicarFiltros = (filas: FilaDetalle[], filtros: Filtros, salvo?: string) =>
  filas.filter(f => Object.entries(filtros).every(([k, v]) => k === salvo || valorDim(f, k) === v))

/** Factor del indicador (100 para %): se deduce del propio resultado; si no hay datos, por la unidad. */
const factorDe = (k: KpiResultado) => k.valor != null && k.num && k.den ? k.valor / (k.num / k.den) : k.unidad === '%' || k.unidad.startsWith('por 100') ? 100 : 1

/** Resultado de un subconjunto con las mismas reglas del tablero: sin registros, no calculable o valor con su cobertura. */
export function resumen(filas: FilaDetalle[], kpi: KpiResultado) {
  const vivas = filas.filter(f => f.origen !== 'EXCLUIDO'), con = vivas.filter(f => f.con_dato)
  const sn = con.reduce((s, f) => s + Number(f.num || 0), 0), sd = con.reduce((s, f) => s + Number(f.den || 0), 0)
  const estado = !vivas.length ? 'Sin registros' : !con.length || sd === 0 ? 'No calculable' : null
  return { n: vivas.length, nCon: con.length, valor: estado ? null : Math.round(factorDe(kpi) * sn / sd * 100) / 100, estado, cobertura: vivas.length ? Math.round(1000 * con.length / vivas.length) / 10 : null }
}

/** Desglose por dimensión con filtrado cruzado: tocar una barra filtra el detalle y los demás desgloses. Sin depender de hover. */
export function DesgloseKpi({ kpi, filas, filtros, onFiltros }: { kpi: KpiResultado; filas: FilaDetalle[]; filtros: Filtros; onFiltros: (f: Filtros) => void }) {
  const claves = [...new Set(filas.flatMap(f => Object.keys(f.dims || {}).filter(k => valorDim(f, k) != null)))]
    .filter(k => { const n = new Set(filas.map(f => valorDim(f, k)).filter(Boolean)).size; return n > 1 && n <= 25 })
  if (!claves.length && !Object.keys(filtros).length) return null
  const total = resumen(aplicarFiltros(filas, filtros), kpi)
  return <div className="space-y-3">
    {Object.keys(filtros).length > 0 && <div className="flex flex-wrap items-center gap-2" aria-label="Filtros activos">
      {Object.entries(filtros).map(([k, v]) => <button key={k} type="button" onClick={() => onFiltros(sin(filtros, k))}
        className="inline-flex min-h-9 items-center gap-1 rounded-full bg-[#002855] px-3 text-xs font-semibold text-white">{k.replace(/_/g, ' ')}: {v}<X className="h-3.5 w-3.5" aria-label="Quitar filtro" /></button>)}
      <button type="button" onClick={() => onFiltros({})} className="min-h-9 text-xs font-semibold text-[#002855] underline">Limpiar filtros</button>
      <span className="text-xs text-slate-600">Filtrado: {total.estado || valorTxt(total.valor, kpi.unidad)} · {total.n} registros · cobertura {total.cobertura == null ? '—' : `${num(total.cobertura)} %`}</span>
    </div>}
    <div className="grid gap-3 sm:grid-cols-2">{claves.map(k => {
      const base = aplicarFiltros(filas, filtros, k)
      const grupos = [...new Set(base.map(f => valorDim(f, k)).filter((v): v is string => !!v))]
        .map(v => ({ v, r: resumen(base.filter(f => valorDim(f, k) === v), kpi) })).sort((a, b) => b.r.n - a.r.n)
      const max = Math.max(1, ...grupos.map(g => g.r.n))
      return <section key={k} className="rounded-lg border p-2">
        <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Por {k.replace(/_/g, ' ')}</h4>
        <ul className="space-y-1">{grupos.map(g => <li key={g.v}>
          <button type="button" aria-pressed={filtros[k] === g.v} onClick={() => onFiltros(filtros[k] === g.v ? sin(filtros, k) : { ...filtros, [k]: g.v })}
            className={`grid min-h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded px-1 text-left text-xs ${filtros[k] === g.v ? 'bg-blue-50 ring-1 ring-[#002855]' : 'hover:bg-slate-50'}`}>
            <span className="min-w-0"><span className="block truncate">{g.v}</span><span className="mt-0.5 block h-1.5 rounded bg-[#002855]/70" style={{ width: `${Math.max(4, 100 * g.r.n / max)}%` }} aria-hidden /></span>
            <span className="whitespace-nowrap text-slate-700">{g.r.estado || valorTxt(g.r.valor, kpi.unidad)} · {g.r.n}</span>
          </button></li>)}</ul>
      </section>
    })}</div>
  </div>
}
