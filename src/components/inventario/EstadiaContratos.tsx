'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { Download, Search } from 'lucide-react'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { SortTh } from '@/components/apt/PphShared'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { fmtN } from '@/lib/inventario/format'
import type { InvEstadiaContrato } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'

// Semáforo de la estadía (días): hasta 15 verde, hasta 30 amarillo, hasta 60 naranja, más rojo
export const SEMAFORO_ESTADIA = { verde: 15, amarillo: 30, naranja: 60 }
const nf = (d: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d })
const tn = nf(2), d1 = nf(1)

function tono(d: number) {
  const s = SEMAFORO_ESTADIA
  if (d <= s.verde) return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (d <= s.amarillo) return 'bg-yellow-50 text-yellow-700 border-yellow-300'
  if (d <= s.naranja) return 'bg-orange-50 text-orange-700 border-orange-200'
  return 'bg-red-50 text-red-700 border-red-200'
}

// Estadía ponderada; si parte del stock viene de un saldo inferido, es un mínimo («≥») o «No determinado» si es todo
function Estadia({ f }: { f: InvEstadiaContrato }) {
  if (f.estadia === null) return <span className="text-slate-400">—</span>
  const nd = f.pct_nd ?? 0
  if (nd >= 100) return <span title={`Saldo inicial inferido: al menos ${d1.format(f.estadia)} días`} className="inline-flex rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-semibold text-slate-500">No determinado</span>
  return <span title={nd > 0 ? `Mínimo: el ${d1.format(nd)} % del stock viene de un saldo inicial inferido sin fecha de ingreso exacta` : 'Promedio ponderado por kg del stock actual'}
    className={`inline-flex min-w-[3.5rem] justify-center rounded-md border px-1.5 py-0.5 text-xs font-bold tabular-nums ${tono(f.estadia)}`}>{nd > 0 ? '≥ ' : ''}{d1.format(f.estadia)}</span>
}

type Key = 'estadia' | 'stock_kg' | 'pct_60'

// Tabla principal de Estadía: una fila por contrato y bodega del APT con su stock actual y cuántos días lleva
export function EstadiaContratos() {
  const r = useInvQuery('estadia-contratos', () => invApi.estadiaContratos())
  const [q, setQ] = useState('')
  const [bodega, setBodega] = useState('')
  const [sort, setSort] = useState<{ k: Key; desc: boolean }>({ k: 'estadia', desc: true })
  const all = useMemo(() => r.data?.filas ?? [], [r.data])
  const bodegas = useMemo(() => [...new Set(all.map(f => f.bodega))].sort(), [all])
  const rows = useMemo(() => {
    const t = q.trim().toUpperCase()
    const out = all.filter(f => (!bodega || f.bodega === bodega) && (!t || [f.contrato, f.lote, f.ot, f.cliente].some(v => v?.toUpperCase().includes(t))))
    const dir = sort.desc ? -1 : 1
    return out.sort((a, b) => a[sort.k] === b[sort.k] ? b.stock_kg - a.stock_kg : a[sort.k] === null ? 1 : b[sort.k] === null ? -1 : dir * ((a[sort.k] as number) - (b[sort.k] as number)))
  }, [all, q, bodega, sort])
  const pg = usePagination(rows, 'apt-estadia-contratos')
  const onSort = (k: string) => { setSort(s => ({ k: k as Key, desc: s.k === k ? !s.desc : true })); pg.setPage(1) }
  const totalKg = rows.reduce((t, f) => t + f.stock_kg, 0)
  const exportar = () => exportAptXlsx(`estadia-contratos-${r.data?.corte ?? ''}`, { Estadía: rows.map(f => ({
    Contrato: f.contrato ?? 'Sin contrato', Lote: f.contrato ? '' : f.lote ?? '', OT: f.ot ?? '', Cliente: f.cliente ?? '', Bodega: f.bodega,
    'Stock (TN)': Math.round(f.stock_kg) / 1000, 'Estadía (días)': f.pct_nd !== null && f.pct_nd >= 100 ? 'No determinado' : f.estadia ?? '',
    '% stock sin fecha exacta': f.pct_nd ?? '', '% mayor a 60 días': f.pct_60 ?? '', 'Stock > 60 días (TN)': Math.round(f.kg_60) / 1000,
  })) })
  const th = 'sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide text-slate-500'
  const td = 'whitespace-nowrap px-3 py-1.5'
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="text-xs font-semibold text-slate-600">Buscar
          <span className="mt-1 flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-2"><Search className="h-4 w-4 text-slate-400" />
            <input value={q} onChange={e => { setQ(e.target.value); pg.setPage(1) }} placeholder="Contrato, OT o cliente" className="w-48 text-sm outline-none" /></span>
        </label>
        <label className="text-xs font-semibold text-slate-600">Bodega
          <select value={bodega} onChange={e => { setBodega(e.target.value); pg.setPage(1) }} className="mt-1 block min-h-10 max-w-64 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="">Todas</option>{bodegas.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <button type="button" onClick={exportar} disabled={!rows.length} className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" /> Excel</button>
        <p className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">Estadía:
          {([['0–15', 15], ['16–30', 30], ['31–60', 60], ['> 60', 61]] as const).map(([l, d]) => <span key={l} className={`rounded border px-1.5 py-0.5 font-semibold ${tono(d)}`}>{l} d</span>)}
        </p>
      </div>
      {r.loading ? <LoadingBlock label="Calculando la estadía…" /> : r.error ? <ErrorBlock message={r.error} onRetry={r.reload} /> : r.data && (
        <ChartCard title="Estadía por contrato"
          subtitle={`${fmtN(rows.length)} registros · ${tn.format(totalKg / 1000)} TN · APT 647 · 540 · ST · stock al ${fmtDate(r.data.corte)}`}
          info="Solo el stock que sigue en bodega. Estadía: promedio de días desde el ingreso, ponderado por kg de cada ingreso que queda; un traspaso entre bodegas del APT no reinicia la antigüedad. «≥»: parte del stock viene de un saldo inicial inferido y su fecha exacta no se conoce (es un mínimo). % mayor a 60 días: kg con más de 60 días ÷ stock total.">
          <div className="max-h-[70vh] overflow-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead><tr>
                <th className={th}>Contrato</th><th className={th}>OT</th><th className={th}>Cliente</th><th className={th}>Bodega</th>
                <SortTh label="Stock (TN)" k="stock_kg" sort={sort.k} desc={sort.desc} onSort={onSort} />
                <SortTh label="Estadía (días)" k="estadia" sort={sort.k} desc={sort.desc} onSort={onSort} />
                <SortTh label="% > 60 días" k="pct_60" sort={sort.k} desc={sort.desc} onSort={onSort} title="Stock con más de 60 días ÷ stock total" />
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {pg.pageRows.map(f => <tr key={`${f.bodega}|${f.lote}`} className="hover:bg-slate-50">
                  <td className={`${td} font-semibold text-slate-800`}>{f.contrato ?? <span className="font-normal text-slate-400" title={f.lote ? `Lote ${f.lote}` : 'Sin lote'}>Sin contrato</span>}</td>
                  <td className={td}>{f.ot ? <Link href={`/apt/contratos?ot=${encodeURIComponent(f.ot)}`} className="font-bold text-[#002855] underline">{f.ot}</Link> : <span className="text-slate-400">—</span>}</td>
                  <td className={td}><p className="max-w-64 truncate" title={f.cliente ?? ''}>{f.cliente ?? <span className="text-slate-400">Cliente no identificado</span>}</p></td>
                  <td className={`${td} text-slate-600`}>{f.bodega}</td>
                  <td className={`${td} text-right font-semibold tabular-nums`} title={f.kg_conocido ? undefined : 'Parte del stock no tiene peso en el ERP'}>
                    {f.stock_kg > 0 ? tn.format(f.stock_kg / 1000) : <span className="font-normal text-slate-400">Sin peso</span>}{!f.kg_conocido && f.stock_kg > 0 && <span className="text-amber-600">*</span>}</td>
                  <td className={`${td} text-right`}><Estadia f={f} /></td>
                  <td className={`${td} text-right tabular-nums ${(f.pct_60 ?? 0) > 0 ? 'font-semibold text-red-700' : 'text-slate-500'}`}>{f.pct_60 === null ? '—' : d1.format(f.pct_60)}</td>
                </tr>)}
              </tbody>
            </table>
            {!rows.length && <p className="py-6 text-center text-sm text-slate-400">Sin registros</p>}
          </div>
          {pg.total > 25 && <TablePagination compact total={pg.total} page={pg.page} pageSize={pg.pageSize} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="registros" />}
        </ChartCard>
      )}
    </div>
  )
}
