'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { readCache, writeCache } from '@/lib/use-cached'
import { ArrowDown, ArrowUp, ArrowUpDown, Database, RefreshCw, Search, Upload, X } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'

type StockRow = { bodega: string; cod_producto: string; producto: string | null; lote: string | null; lote_raw: string | null; ot: string | null; cliente: string | null; unidad: string | null; stock: number; stock_falla: number; stock_comprometido: number | null; kg: number | null }
type StockResult = { import_id: string | null; cut_at: string | null; file_name?: string; bodegas: string[]; rows: StockRow[] }
type SortKey = 'bodega' | 'ot' | 'cliente' | 'lote' | 'cod_producto' | 'stock' | 'stock_falla' | 'stock_comprometido' | 'kg'

const LIMIT = 2000 // erp_stock_query devuelve hasta 2.000 lotes; por encima, la búsqueda vuelve al servidor
const fmt = (n: number | null | undefined, d = 2) => n == null ? '—' : Number(n).toLocaleString('es-PE', { maximumFractionDigits: d })
const fmtDate = (v: string | null | undefined) => v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'
const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const COLUMNS: Array<{ key: SortKey; label: string; num?: boolean }> = [
  { key: 'bodega', label: 'Bodega' }, { key: 'ot', label: 'OT' }, { key: 'cliente', label: 'Cliente' }, { key: 'lote', label: 'Lote' },
  { key: 'cod_producto', label: 'Producto' }, { key: 'stock', label: 'Stock', num: true }, { key: 'stock_falla', label: 'Falla', num: true },
  { key: 'stock_comprometido', label: 'Comprometido', num: true }, { key: 'kg', label: 'kg', num: true },
]

export default function WarehouseErpStockPage() {
  const { hasAccess } = usePermissions()
  const canLoad = hasAccess('almacen-carga') || hasAccess('almacen-supervisor')
  const [data, setData] = useState<StockResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [bodega, setBodega] = useState('')
  const [cliente, setCliente] = useState('')
  const [onlyCommitted, setOnlyCommitted] = useState(false)
  const [onlyFault, setOnlyFault] = useState(false)
  const [noClient, setNoClient] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'ot', dir: 1 })

  const load = useCallback(async (s = '') => {
    setLoading(true)
    if (!s.trim()) { const cached = await readCache<StockResult>('stock-erp'); if (cached) { setData(d => d ?? cached); setLoading(false) } }
    const stock = await createClient().rpc('erp_stock_query', { p_bodega: null, p_search: s.trim() || null })
    if (stock.error) setError(stock.error.message)
    else { setError(''); setData(stock.data as StockResult); if (!s.trim()) void writeCache('stock-erp', stock.data) }
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const all = useMemo(() => data?.rows || [], [data])
  const truncated = all.length >= LIMIT
  const clientes = useMemo(() => [...new Set(all.map(r => r.cliente).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b, 'es')), [all])
  const rows = useMemo(() => {
    const q = norm(search.trim())
    const out = all.filter(r => (!bodega || r.bodega === bodega) && (!cliente || r.cliente === cliente)
      && (!onlyCommitted || Number(r.stock_comprometido || 0) > 0) && (!onlyFault || Number(r.stock_falla || 0) > 0) && (!noClient || !r.cliente)
      && (!q || norm([r.ot, r.cliente, r.lote, r.lote_raw, r.cod_producto, r.producto, r.bodega].join(' ')).includes(q)))
    const { key, dir } = sort
    return out.sort((a, b) => {
      const x = a[key], y = b[key]
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true })) * dir
    })
  }, [all, search, bodega, cliente, onlyCommitted, onlyFault, noClient, sort])
  const pager = usePagination(rows, 'almacen-stock-erp')
  const totals = useMemo(() => ({ stock: rows.reduce((s, r) => s + Number(r.stock || 0), 0), kg: rows.reduce((s, r) => s + Number(r.kg || 0), 0), ots: new Set(rows.map(r => r.ot).filter(Boolean)).size }), [rows])
  const filtered = !!(search || bodega || cliente || onlyCommitted || onlyFault || noClient)
  const clear = () => { setSearch(''); setBodega(''); setCliente(''); setOnlyCommitted(false); setOnlyFault(false); setNoClient(false) }
  const toggleSort = (key: SortKey) => setSort(s => s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: COLUMNS.find(c => c.key === key)?.num ? -1 : 1 })

  const check = 'inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm'
  return <div className="w-full space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Control</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">Stock ERP</h1>
        <p className="mt-1 text-sm text-slate-600">Stock Bodega Despacho del ERP por bodega, OT, lote y producto. Es la referencia del inventario físico.</p>
      </div>
      <div className="text-right text-sm">
        <p className="text-slate-500">Corte del ERP</p>
        <p className="font-bold text-[#002855]">{fmtDate(data?.cut_at)}</p>
        {canLoad && <Link href="/almacen/actualizaciones" className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-blue-800 underline"><Upload size={12}/>Cargar datos del ERP</Link>}
      </div>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}

    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap gap-3">
        <label className="relative min-w-64 flex-1">
          <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
          <input value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && truncated) void load(search) }}
            placeholder="Buscar OT, cliente, lote o producto" aria-label="Buscar" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"/>
        </label>
        <select value={bodega} onChange={e => setBodega(e.target.value)} aria-label="Bodega" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">Todas las bodegas</option>
          {(data?.bodegas || []).map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={cliente} onChange={e => setCliente(e.target.value)} aria-label="Cliente" className="max-w-72 rounded-lg border border-slate-300 px-3 py-2 text-sm">
          <option value="">Todos los clientes</option>
          {clientes.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button type="button" onClick={() => void load(truncated ? search : '')} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className={check}><input type="checkbox" checked={onlyCommitted} onChange={e => setOnlyCommitted(e.target.checked)}/>Con comprometido</label>
        <label className={check}><input type="checkbox" checked={onlyFault} onChange={e => setOnlyFault(e.target.checked)}/>Con falla</label>
        <label className={check}><input type="checkbox" checked={noClient} onChange={e => setNoClient(e.target.checked)}/>Sin cliente</label>
        {filtered && <button type="button" onClick={clear} className="inline-flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-semibold text-blue-800"><X size={14}/>Limpiar filtros</button>}
        <span className="ml-auto text-sm text-slate-600">{fmt(rows.length, 0)} lotes · {fmt(totals.ots, 0)} OT · stock {fmt(totals.stock, 3)} · {fmt(totals.kg, 1)} kg</span>
      </div>
      {truncated && <p className="text-xs text-amber-800">Se muestran los primeros 2.000 lotes: escriba la búsqueda y presione Enter para consultar al servidor.</p>}
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex items-center gap-2 border-b p-3"><Database size={16} className="text-blue-700"/><h2 className="font-bold text-[#002855]">Lotes · {fmt(rows.length, 0)}{filtered ? ` de ${fmt(all.length, 0)}` : ''}</h2></header>
      {loading ? <p className="p-8 text-center text-sm text-slate-500">Cargando stock…</p>
        : !data?.import_id ? <p className="p-8 text-center text-sm text-slate-500">Todavía no hay una carga del Stock Bodega Despacho.</p>
        : rows.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">Ningún lote coincide con los filtros.</p>
        : <div className="overflow-x-auto"><table className="min-w-[860px] lg:min-w-0 w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase text-slate-600"><tr>
            {COLUMNS.map(c => {
              const active = sort.key === c.key
              const Icon = !active ? ArrowUpDown : sort.dir === 1 ? ArrowUp : ArrowDown
              return <th key={c.key} className="px-3 py-2" aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                <button type="button" onClick={() => toggleSort(c.key)} className={`inline-flex items-center gap-1 uppercase ${c.num ? 'ml-auto w-full justify-end' : ''} ${active ? 'text-[#002855]' : ''}`}>
                  {c.label}<Icon size={12} className={active ? '' : 'opacity-40'}/>
                </button>
              </th>
            })}
          </tr></thead>
          <tbody className="divide-y divide-slate-100">{pager.pageRows.map((r, i) => <tr key={`${r.bodega}-${r.lote_raw}-${r.cod_producto}-${i}`} className="hover:bg-blue-50/40">
            <td className="whitespace-nowrap px-3 py-1.5">{r.bodega}</td>
            <td className="px-3 py-1.5 font-semibold">{r.ot
              ? <Link href={`/almacen/apt/contratos?ot=${encodeURIComponent(r.ot)}`} className="text-blue-800 underline-offset-2 hover:underline" title="Ver ficha de la OT">{r.ot}</Link>
              : '—'}</td>
            <td className="px-3 py-1.5">{r.cliente || '—'}</td>
            <td className="px-3 py-1.5">{r.lote || '—'}{r.lote_raw && r.lote_raw !== r.lote && <small className="block text-slate-400">{r.lote_raw}</small>}</td>
            <td className="px-3 py-1.5"><b>{r.cod_producto}</b> <span className="text-slate-600">{r.producto}</span></td>
            <td className="whitespace-nowrap px-3 py-1.5 text-right font-semibold">{fmt(r.stock, 3)} {r.unidad || ''}</td>
            <td className="px-3 py-1.5 text-right">{fmt(r.stock_falla, 3)}</td>
            <td className="px-3 py-1.5 text-right">{fmt(r.stock_comprometido, 3)}</td>
            <td className="px-3 py-1.5 text-right">{fmt(r.kg, 1)}</td>
          </tr>)}</tbody>
        </table></div>}
      {!loading && rows.length > 0 && <TablePagination total={pager.total} page={pager.page} pageSize={pager.pageSize} onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} itemLabel="lotes" compact />}
    </section>
  </div>
}
