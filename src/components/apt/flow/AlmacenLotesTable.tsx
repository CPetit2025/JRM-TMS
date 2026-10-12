'use client'
import { DataTable } from '@/components/ui/data-table'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowDown, ArrowUp, ChevronLeft, ChevronRight, FileSpreadsheet, Search } from 'lucide-react'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtDec1, fmtInt, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, type FlowAlmacen, type FlowGlosaSaldo, type FlowLoteSaldo } from '@/lib/apt/flowTypes'
import { traceHref } from '@/lib/apt/useFlowFilters'
import { InlineBar } from '@/components/apt/ui'

// Saldo por almacén, por lote o por glosa: búsqueda, orden, paginación de 25 y exportación a Excel.

export type StockView = 'lote' | 'glosa'
type Row = {
  key: string; almacen: FlowAlmacen; nombre: string; detalle: string; cliente: string | null; lotes: number; tn: number
  edad_pond: number | null; dias_almacen_pond: number | null; tn_dias: number | null; inicial_tn: number | null; alerta: boolean | null
  excel: Record<string, unknown>
}
type SortKey = 'almacen' | 'nombre' | 'cliente' | 'lotes' | 'tn' | 'edad_pond' | 'dias_almacen_pond' | 'tn_dias' | 'inicial_tn'
const PAGE = 25
const MEASURES: Array<{ k: SortKey; label: string; num?: boolean; title?: string }> = [
  { k: 'tn', label: 'TN', num: true },
  { k: 'edad_pond', label: 'Edad pond.', num: true, title: 'Días desde la producción, ponderados por TN' },
  { k: 'dias_almacen_pond', label: 'Días en almacén', num: true, title: 'Días desde que llegó a este almacén, ponderados por TN' },
  { k: 'tn_dias', label: 'TN×Días', num: true, title: 'Saldo × días: prioriza lotes grandes y antiguos' },
  { k: 'inicial_tn', label: 'Stock previo', num: true, title: 'TN que existía antes del primer día cargado (antigüedad real desconocida)' },
]

function loteRow(r: FlowLoteSaldo): Row {
  return { key: `${r.almacen}|${r.lote}`, almacen: r.almacen, nombre: r.lote, detalle: `${fmtInt(r.productos)} prod. · desde ${fmtDate(r.fecha_llegada_min)}`,
    cliente: r.cliente, lotes: 1, tn: r.tn, edad_pond: r.edad_pond, dias_almacen_pond: r.dias_almacen_pond, tn_dias: r.tn_dias,
    inicial_tn: r.inicial_tn, alerta: r.alerta,
    excel: { Lote: r.lote, Cliente: r.cliente ?? '', TN: r.tn, Productos: r.productos, Capas: r.capas } }
}
function glosaRow(r: FlowGlosaSaldo): Row {
  return { key: `${r.almacen}|${r.glosa}`, almacen: r.almacen, nombre: r.glosa,
    detalle: `${fmtInt(r.productos)} prod. · ${fmtInt(r.clientes)} cliente${r.clientes === 1 ? '' : 's'} · desde ${fmtDate(r.fecha_llegada_min)}`,
    cliente: null, lotes: r.lotes, tn: r.tn, edad_pond: r.edad_pond, dias_almacen_pond: r.dias_almacen_pond, tn_dias: r.tn_dias,
    inicial_tn: r.inicial_tn, alerta: r.alerta,
    excel: { Glosa: r.glosa, Lotes: r.lotes, Productos: r.productos, Clientes: r.clientes, TN: r.tn } }
}

export function AlmacenLotesTable({ rows: source, view = 'lote', alertDays, cutoff }:
  { rows: FlowLoteSaldo[] | FlowGlosaSaldo[]; view?: StockView; alertDays: number; cutoff: string }) {
  const rows = useMemo(() => view === 'glosa' ? (source as FlowGlosaSaldo[]).map(glosaRow) : (source as FlowLoteSaldo[]).map(loteRow), [source, view])
  const cols: Array<{ k: SortKey; label: string; num?: boolean; title?: string }> = [
    { k: 'almacen', label: 'Almacén' },
    { k: 'nombre', label: view === 'glosa' ? 'Glosa' : 'Lote' },
    view === 'glosa' ? { k: 'lotes', label: 'Lotes', num: true } : { k: 'cliente', label: 'Cliente' },
    ...MEASURES,
  ]
  const unit = view === 'glosa' ? 'glosas' : 'lotes'
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'tn_dias', desc: true })
  const [page, setPage] = useState(0)

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = s ? rows.filter(r => `${r.nombre} ${r.cliente ?? ''} ${r.almacen}`.toLowerCase().includes(s)) : rows
    const dir = sort.desc ? -1 : 1
    return [...list].sort((a, b) => {
      const va = a[sort.k], vb = b[sort.k]
      if (va === null || va === undefined) return 1
      if (vb === null || vb === undefined) return -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb), 'es') * dir
    })
  }, [rows, q, sort])

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE))
  const cur = Math.min(page, pages - 1)
  const slice = filtered.slice(cur * PAGE, cur * PAGE + PAGE)
  const maxTxd = Math.max(0, ...filtered.map(r => Number(r.tn_dias || 0)))
  const totTn = filtered.reduce((s, r) => s + Number(r.tn), 0)
  const alertas = filtered.filter(r => r.alerta).length

  const toggleSort = (k: SortKey) => { setSort(s => (s.k === k ? { k, desc: !s.desc } : { k, desc: k !== 'almacen' && k !== 'nombre' && k !== 'cliente' })); setPage(0) }
  const exportXlsx = () => exportAptXlsx(`APT_flujo_${unit}_con_saldo_${cutoff}`, {
    [view === 'glosa' ? 'Saldo por glosa' : 'Lotes con saldo']: filtered.map(r => ({
      Almacén: ALMACEN_LABEL[r.almacen], ...r.excel,
      'Edad pond. (d)': r.edad_pond, 'Días en almacén pond.': r.dias_almacen_pond, 'TN×Días': r.tn_dias,
      'Stock previo TN': r.inicial_tn, [`Alerta > ${alertDays} d`]: r.alerta ? 'Sí' : '',
    })),
  })

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1 sm:px-1">
        <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={e => { setQ(e.target.value); setPage(0) }} placeholder={view === 'glosa' ? 'Buscar glosa o almacén…' : 'Buscar lote, cliente o almacén…'}
            className="h-9 w-full rounded-lg border border-slate-200 pl-8 pr-2 text-xs outline-none focus:border-[#002855]" />
        </div>
        <p className="text-xs text-slate-500">
          <b className="tabular-nums text-slate-700">{fmtInt(filtered.length)}</b> {unit} · <b className="tabular-nums text-slate-700">{fmtTn(totTn)}</b> TN
          {alertas > 0 && <> · <span className="font-semibold text-red-600">{fmtInt(alertas)} con alerta</span></>}
        </p>
        <button onClick={exportXlsx} className="ml-auto flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50">
          <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" /> Exportar Excel
        </button>
      </div>
      <div className="overflow-x-auto">
        <DataTable className="w-full min-w-[860px] text-xs">
          <thead>
            <tr className="border-y border-slate-100 bg-slate-50 text-[10px] uppercase tracking-wider text-slate-500">
              {cols.map(c => (
                <th key={c.k} title={c.title} className={`px-3 py-2 font-bold ${c.num ? 'text-right' : 'text-left'}`}>
                  <button onClick={() => toggleSort(c.k)} className={`inline-flex items-center gap-1 hover:text-slate-800 ${sort.k === c.k ? 'text-[#002855]' : ''}`}>
                    {c.label}{sort.k === c.k && (sort.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                  </button>
                </th>
              ))}
              <th className="px-3 py-2 text-left font-bold">Alerta</th>
            </tr>
          </thead>
          <tbody>
            {slice.map(r => (
              <tr key={r.key} className={`border-b border-slate-50 hover:bg-slate-50/80 ${r.alerta ? 'bg-red-50/30' : ''}`}>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-bold" style={{ color: ALMACEN_COLOR[r.almacen] }}>
                    <span className="h-2 w-2 rounded-full" style={{ background: ALMACEN_COLOR[r.almacen] }} />{r.almacen}
                  </span>
                </td>
                <td className="max-w-[24rem] px-3 py-2">
                  {view === 'glosa'
                    ? <p className="truncate font-bold text-slate-800" title={r.nombre}>{r.nombre}</p>
                    : <Link href={traceHref(r.nombre)} className="font-bold text-[#002855] underline decoration-[#002855]/30 underline-offset-2 hover:decoration-[#002855]"
                        title="Ver trazabilidad del lote">{r.nombre}</Link>}
                  <p className="text-[10px] text-slate-400">{r.detalle}</p>
                </td>
                {view === 'glosa'
                  ? <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtInt(r.lotes)}</td>
                  : <td className="max-w-[14rem] truncate px-3 py-2 text-slate-600" title={r.cliente ?? ''}>{r.cliente || <span className="text-slate-400">Sin cliente</span>}</td>}
                <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{fmtTn(r.tn)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.edad_pond === null ? '—' : `${fmtDec1(r.edad_pond)} d`}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${(r.dias_almacen_pond ?? 0) > alertDays ? 'font-bold text-red-600' : ''}`}>
                  {r.dias_almacen_pond === null ? '—' : `${fmtDec1(r.dias_almacen_pond)} d`}
                </td>
                <td className="px-3 py-2 text-right">
                  <span className="font-semibold tabular-nums">{fmtTn(r.tn_dias)}</span>
                  <div className="ml-auto mt-1 w-20"><InlineBar value={Number(r.tn_dias || 0)} max={maxTxd} color={ALMACEN_COLOR[r.almacen]} /></div>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-500">{r.inicial_tn ? fmtTn(r.inicial_tn) : '—'}</td>
                <td className="px-3 py-2">
                  {r.alerta && (
                    <span title={`Supera ${alertDays} días`} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[10px] font-bold text-red-700">
                      <AlertTriangle className="h-3 w-3" /> &gt; {alertDays} d
                    </span>
                  )}
                </td>
              </tr>
            ))}
            {!slice.length && (
              <tr><td colSpan={cols.length + 1} className="px-3 py-10 text-center text-sm text-slate-400">{view === 'glosa' ? 'Ninguna glosa' : 'Ningún lote'} coincide con la búsqueda.</td></tr>
            )}
          </tbody>
        </DataTable>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between gap-2 px-3 pt-3 text-xs text-slate-500 sm:px-1">
          <span>Página {cur + 1} de {pages} · {fmtInt(cur * PAGE + 1)}–{fmtInt(Math.min(filtered.length, cur * PAGE + PAGE))} de {fmtInt(filtered.length)}</span>
          <div className="flex gap-1">
            <button disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label="Anterior"
              className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50 disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" /></button>
            <button disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label="Siguiente"
              className="rounded-lg border border-slate-200 p-1.5 hover:bg-slate-50 disabled:opacity-40"><ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      )}
    </div>
  )
}
