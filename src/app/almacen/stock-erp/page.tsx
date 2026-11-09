'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Database, RefreshCw, Search, Upload } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'

type StockRow = { bodega: string; cod_producto: string; producto: string | null; lote: string | null; lote_raw: string | null; ot: string | null; cliente: string | null; unidad: string | null; stock: number; stock_falla: number; stock_comprometido: number | null; kg: number | null }
type StockResult = { import_id: string | null; cut_at: string | null; file_name?: string; bodegas: string[]; rows: StockRow[] }

const fmt = (n: number | null | undefined, d = 2) => n == null ? '—' : Number(n).toLocaleString('es-PE', { maximumFractionDigits: d })
const fmtDate = (v: string | null | undefined) => v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'

export default function WarehouseErpStockPage() {
  const { hasAccess } = usePermissions()
  const canLoad = hasAccess('almacen-carga') || hasAccess('almacen-supervisor')
  const [data, setData] = useState<StockResult | null>(null)
  const [bodega, setBodega] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (b: string, s: string) => {
    const stock = await createClient().rpc('erp_stock_query', { p_bodega: b || null, p_search: s.trim() || null })
    if (stock.error) setError(stock.error.message); else setData(stock.data as StockResult)
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load('', '') }, [load])

  const rows = data?.rows || []
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

    <section className="flex flex-wrap gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <select value={bodega} onChange={e => { setBodega(e.target.value); void load(e.target.value, search) }} aria-label="Bodega" className="rounded-lg border border-slate-300 px-3 py-2 text-sm">
        <option value="">Todas las bodegas</option>
        {(data?.bodegas || []).map(b => <option key={b} value={b}>{b}</option>)}
      </select>
      <form onSubmit={e => { e.preventDefault(); void load(bodega, search) }} className="relative min-w-64 flex-1">
        <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar OT, cliente, lote o producto y presionar Enter" className="w-full rounded-lg border border-slate-300 py-2 pl-9 pr-3 text-sm"/>
      </form>
      <button type="button" onClick={() => void load(bodega, search)} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button>
    </section>

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex items-center gap-2 border-b p-3"><Database size={16} className="text-blue-700"/><h2 className="font-bold text-[#002855]">Lotes · {fmt(rows.length, 0)}{rows.length >= 2000 ? ' (primeros 2.000: afine la búsqueda)' : ''}</h2></header>
      {loading ? <p className="p-8 text-center text-sm text-slate-500">Cargando stock…</p>
        : !data?.import_id ? <p className="p-8 text-center text-sm text-slate-500">Todavía no hay una carga del Stock Bodega Despacho.</p>
        : <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs font-bold uppercase text-slate-600"><tr>
            <th className="px-3 py-2">Bodega</th><th className="px-3 py-2">OT</th><th className="px-3 py-2">Cliente</th><th className="px-3 py-2">Lote</th><th className="px-3 py-2">Producto</th>
            <th className="px-3 py-2 text-right">Stock</th><th className="px-3 py-2 text-right">Falla</th><th className="px-3 py-2 text-right">Comprometido</th><th className="px-3 py-2 text-right">kg</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.map((r, i) => <tr key={`${r.bodega}-${r.lote_raw}-${r.cod_producto}-${i}`}>
            <td className="whitespace-nowrap px-3 py-1.5">{r.bodega}</td>
            <td className="px-3 py-1.5 font-semibold">{r.ot || '—'}</td>
            <td className="px-3 py-1.5">{r.cliente || '—'}</td>
            <td className="px-3 py-1.5">{r.lote || '—'}{r.lote_raw && r.lote_raw !== r.lote && <small className="block text-slate-400">{r.lote_raw}</small>}</td>
            <td className="px-3 py-1.5"><b>{r.cod_producto}</b> <span className="text-slate-600">{r.producto}</span></td>
            <td className="whitespace-nowrap px-3 py-1.5 text-right font-semibold">{fmt(r.stock, 3)} {r.unidad || ''}</td>
            <td className="px-3 py-1.5 text-right">{fmt(r.stock_falla, 3)}</td>
            <td className="px-3 py-1.5 text-right">{fmt(r.stock_comprometido, 3)}</td>
            <td className="px-3 py-1.5 text-right">{fmt(r.kg, 1)}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </div>
}
