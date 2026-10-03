'use client'

import { useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtInt, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, isAlmacen } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, type FlowSt } from '@/lib/apt/flowTypes'
import { traceHref } from '@/lib/apt/useFlowFilters'
import { ChartCard } from '@/components/apt/ui'
import { ExportButton, Segmented, SortTh } from '@/components/apt/PphShared'
import { fmtDiasSt } from './StCharts'

// Tablas de "ST VENTAS": material detenido (saldo actual en ST) y retornos ST → 647/540.

type Row = Record<string, unknown>
function sortBy<T extends Row>(rows: T[], k: string, desc: boolean) {
  return [...rows].sort((a, b) => {
    const x = a[k] as string | number | null | undefined, y = b[k] as string | number | null | undefined
    if (x === y) return 0
    if (x === null || x === undefined) return 1
    if (y === null || y === undefined) return -1
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es')
    return desc ? -c : c
  })
}
const matches = (q: string, ...vals: Array<string | null | undefined>) => !q || vals.some(v => v && v.toLowerCase().includes(q))
const hoy = () => new Date().toISOString().slice(0, 10)

function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
      <input value={value} onChange={e => onChange(e.target.value)} placeholder="Lote, producto, cliente…"
        className="h-8 w-48 rounded-lg border border-slate-200 pl-7 pr-2 text-xs outline-none focus:border-[#002855]" />
    </label>
  )
}

export function StAlmacenChip({ a }: { a: string | null }) {
  if (!a) return <span className="text-slate-400">—</span>
  const c = isAlmacen(a) ? ALMACEN_COLOR[a] : '#64748b'
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold"
      style={{ color: c, borderColor: `${c}55`, background: `${c}10` }}>
      {isAlmacen(a) ? ALMACEN_LABEL[a] : a}
    </span>
  )
}

const rowTone = (d: number | null) => (d === null ? '' : d > 3 ? 'bg-red-50/70 hover:bg-red-50' : d >= 1 ? 'bg-amber-50/70 hover:bg-amber-50' : 'hover:bg-slate-50')
const diasCls = (d: number | null) => (d === null ? 'border-slate-200 bg-slate-50 text-slate-400'
  : d > 3 ? 'border-red-200 bg-red-100 text-red-700' : d >= 1 ? 'border-amber-200 bg-amber-100 text-amber-800' : 'border-emerald-200 bg-emerald-50 text-emerald-700')

type Det = FlowSt['detenido'][number]
type Umbral = 'todo' | 'gt1' | 'gt3'

export function StDetenidoTable({ rows }: { rows: Det[] }) {
  const [sort, setSort] = useState('dias')
  const [desc, setDesc] = useState(true)
  const [search, setSearch] = useState('')
  const [umbral, setUmbral] = useState<Umbral>('todo')
  const onSort = (k: string) => { if (k === sort) setDesc(v => !v); else { setSort(k); setDesc(k === 'dias' || k === 'tn' || k === 'fecha_llegada') } }
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase()
    const f = rows.filter(r => matches(s, r.lote, r.producto, r.glosa, r.cliente, r.documento)
      && (umbral === 'todo' || (r.dias ?? 0) > (umbral === 'gt1' ? 1 : 3)))
    return sortBy(f as unknown as Row[], sort, desc) as unknown as Det[]
  }, [rows, search, umbral, sort, desc])
  const tn = shown.reduce((s, r) => s + r.tn, 0)
  const lotes = new Set(shown.map(r => r.lote)).size

  const exportar = () => exportAptXlsx(`APT_ST_detenido_${hoy()}`, {
    'Detenido en ST': shown.map(r => ({
      Lote: r.lote, Producto: r.producto, Glosa: r.glosa, Cliente: r.cliente, 'Llegó desde': r.desde, Tipo: r.tipo,
      'Fecha llegada': r.fecha_llegada, Días: r.dias, Documento: r.documento, TN: r.tn,
    })),
  })

  return (
    <ChartCard title="Material detenido en ST" bodyClassName="p-0"
      subtitle={`${fmtInt(shown.length)} productos · ${fmtInt(lotes)} lotes · ${fmtTn(tn)} TN`}
      info="Saldo actual en ST VENTAS. Todo lo que pasa de 1 día debería guiarse o devolverse a 647/540. Ámbar: 1–3 días; rojo: más de 3 días."
      actions={<>
        <Segmented value={umbral} onChange={setUmbral} options={[{ value: 'todo', label: 'Todo' }, { value: 'gt1', label: '> 1 d' }, { value: 'gt3', label: '> 3 d' }]} />
        <SearchBox value={search} onChange={setSearch} />
        <ExportButton onClick={exportar} disabled={!shown.length} />
      </>}>
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full min-w-[900px] text-xs">
          <thead>
            <tr>
              <SortTh label="Lote" k="lote" sort={sort} desc={desc} onSort={onSort} align="left" />
              <SortTh label="Producto" k="producto" sort={sort} desc={desc} onSort={onSort} align="left" />
              <SortTh label="Cliente" k="cliente" sort={sort} desc={desc} onSort={onSort} align="left" />
              <SortTh label="Llegó desde" k="desde" sort={sort} desc={desc} onSort={onSort} align="center" />
              <SortTh label="Fecha llegada" k="fecha_llegada" sort={sort} desc={desc} onSort={onSort} align="center" />
              <SortTh label="Días" k="dias" sort={sort} desc={desc} onSort={onSort} align="center" />
              <SortTh label="TN" k="tn" sort={sort} desc={desc} onSort={onSort} />
            </tr>
          </thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.layer_id} className={`border-b border-slate-100 ${rowTone(r.dias)}`}>
                <td className="whitespace-nowrap px-3 py-2">
                  <Link href={traceHref(r.lote)} className="font-bold text-[#002855] hover:text-[#cf152d] hover:underline">{r.lote}</Link>
                  {r.documento && <p className="text-[10px] text-slate-400">Doc. {r.documento}</p>}
                </td>
                <td className="max-w-[320px] px-3 py-2">
                  <p className="font-mono text-[11px] text-slate-700">{r.producto}</p>
                  <p className="truncate text-[11px] text-slate-500" title={r.glosa || ''}>{r.glosa || '—'}</p>
                </td>
                <td className="max-w-[200px] truncate px-3 py-2 text-slate-600" title={r.cliente || ''}>
                  {r.cliente || <span className="italic text-slate-400">Sin cliente</span>}
                </td>
                <td className="px-3 py-2 text-center">
                  {r.tipo === 'INICIAL' ? <span className="text-[10px] font-semibold text-slate-500">Stock previo</span> : <StAlmacenChip a={r.desde} />}
                </td>
                <td className="px-3 py-2 text-center tabular-nums">
                  {r.fecha_llegada ? fmtDate(r.fecha_llegada) : <span className="text-[10px] text-slate-400">Sin fecha</span>}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-flex min-w-[2.5rem] justify-center rounded-md border px-1.5 py-0.5 font-bold tabular-nums ${diasCls(r.dias)}`}>
                    {r.dias === null ? '—' : fmtInt(r.dias)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-bold tabular-nums text-[#002855]">{fmtTn(r.tn)}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Sin material detenido con estos criterios</td></tr>}
          </tbody>
          {shown.length > 0 && (
            <tfoot>
              <tr className="sticky bottom-0 border-t-2 border-slate-300 bg-slate-100 font-bold">
                <td className="px-3 py-2" colSpan={6}>Total</td>
                <td className="px-3 py-2 text-right tabular-nums text-[#002855]">{fmtTn(tn)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </ChartCard>
  )
}

type Ret = FlowSt['retornos'][number]

export function StRetornosTable({ rows, extra }: { rows: Ret[]; extra?: ReactNode }) {
  const [sort, setSort] = useState('fecha')
  const [desc, setDesc] = useState(true)
  const [search, setSearch] = useState('')
  const onSort = (k: string) => { if (k === sort) setDesc(v => !v); else { setSort(k); setDesc(k !== 'lote' && k !== 'hacia' && k !== 'documento') } }
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase()
    const f = rows.filter(r => matches(s, r.lote, r.lote_destino, r.producto, r.glosa, r.cliente, r.documento, r.hacia))
    return sortBy(f as unknown as Row[], sort, desc) as unknown as Ret[]
  }, [rows, search, sort, desc])
  const tn = shown.reduce((s, r) => s + r.tn, 0)

  const exportar = () => exportAptXlsx(`APT_ST_retornos_${hoy()}`, {
    'Retornos desde ST': shown.map(r => ({
      Fecha: r.fecha, Lote: r.lote, 'Lote destino': r.lote_destino, Producto: r.producto, Glosa: r.glosa, Cliente: r.cliente,
      Hacia: r.hacia, TN: r.tn, 'Días en ST': r.dias_st, Documento: r.documento,
    })),
  })

  return (
    <ChartCard title="Retornos de ST a almacén" bodyClassName="p-0"
      subtitle={`${fmtInt(shown.length)} movimientos · ${fmtTn(tn)} TN`}
      info="Material que se pasó a ST para guiar y volvió a 647/540 sin despacharse: doble manipuleo y señal de programación de despacho fallida."
      actions={<>{extra}<SearchBox value={search} onChange={setSearch} /><ExportButton onClick={exportar} disabled={!shown.length} /></>}>
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full min-w-[720px] text-xs">
          <thead>
            <tr>
              <SortTh label="Fecha" k="fecha" sort={sort} desc={desc} onSort={onSort} align="center" />
              <SortTh label="Lote" k="lote" sort={sort} desc={desc} onSort={onSort} align="left" />
              <SortTh label="Producto" k="producto" sort={sort} desc={desc} onSort={onSort} align="left" />
              <SortTh label="Hacia" k="hacia" sort={sort} desc={desc} onSort={onSort} align="center" />
              <SortTh label="TN" k="tn" sort={sort} desc={desc} onSort={onSort} />
              <SortTh label="Días en ST" k="dias_st" sort={sort} desc={desc} onSort={onSort} align="center" />
              <SortTh label="Documento" k="documento" sort={sort} desc={desc} onSort={onSort} align="left" />
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.fecha}|${r.lote}|${r.producto}|${r.documento}|${i}`} className={`border-b border-slate-100 ${rowTone(r.dias_st)}`}>
                <td className="whitespace-nowrap px-3 py-2 text-center tabular-nums">{fmtDate(r.fecha)}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <Link href={traceHref(r.lote)} className="font-bold text-[#002855] hover:text-[#cf152d] hover:underline">{r.lote}</Link>
                  {r.lote_destino && r.lote_destino !== r.lote && <p className="text-[10px] text-slate-500">→ {r.lote_destino}</p>}
                </td>
                <td className="max-w-[280px] px-3 py-2">
                  <p className="font-mono text-[11px] text-slate-700">{r.producto}</p>
                  <p className="truncate text-[11px] text-slate-500" title={[r.glosa, r.cliente].filter(Boolean).join(' · ')}>
                    {r.cliente ? <b className="font-semibold text-slate-600">{r.cliente} · </b> : null}{r.glosa || ''}
                  </p>
                </td>
                <td className="px-3 py-2 text-center"><StAlmacenChip a={r.hacia} /></td>
                <td className="px-3 py-2 text-right font-bold tabular-nums text-[#002855]">{fmtTn(r.tn)}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`inline-flex min-w-[2.5rem] justify-center rounded-md border px-1.5 py-0.5 font-bold tabular-nums ${diasCls(r.dias_st)}`}>
                    {fmtDiasSt(r.dias_st)}
                  </span>
                </td>
                <td className="px-3 py-2 tabular-nums text-slate-600">{r.documento || '—'}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Sin retornos en el periodo</td></tr>}
          </tbody>
        </table>
      </div>
    </ChartCard>
  )
}
