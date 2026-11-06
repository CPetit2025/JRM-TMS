'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PackageCheck, RefreshCw, Search } from 'lucide-react'

type PrintedLabel = {
  package_code: string
  source_document_no: string
  source_contract_code: string | null
  source_lot: string
  source_product_code: string
  source_warehouse: string
  description: string
  quantity: number
  unit: string | null
  weight_kg: number | null
  sequence_no: number
  sequence_total: number
  label_print_count: number
  created_at: string
}

export default function PrintedAptLabelsPage() {
  const [rows, setRows] = useState<PrintedLabel[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    setError('')
    const { data, error: queryError } = await createClient()
      .from('wh_packages')
      .select('package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,description,quantity,unit,weight_kg,sequence_no,sequence_total,label_print_count,created_at')
      .gt('label_print_count', 0)
      .neq('status', 'VOID')
      .order('created_at', { ascending: false })
      .limit(1000)

    if (queryError) setError(queryError.message)
    else {
      setRows((data || []) as PrintedLabel[])
      setLastUpdated(new Date())
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30000)
    return () => window.clearInterval(timer)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return rows
    return rows.filter(row => [
      row.package_code, row.source_document_no, row.source_contract_code, row.source_lot,
      row.source_product_code, row.source_warehouse, row.description,
    ].some(value => String(value || '').toLocaleLowerCase().includes(q)))
  }, [query, rows])

  return <div className="mx-auto max-w-7xl space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">APT · Recepción WMS</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">Etiquetas impresas</h1>
        <p className="mt-1 text-sm text-slate-600">Registro de bultos cuya impresión fue registrada. Se actualiza automáticamente cada 30 segundos.</p>
      </div>
      <button type="button" disabled={refreshing} onClick={() => void load(true)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-[#002855] disabled:opacity-50">
        <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''}/>Actualizar
      </button>
    </header>

    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">No se pudieron cargar las etiquetas: {error}</p>}

    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-50 text-blue-800"><PackageCheck size={22}/></span>
          <div><h2 className="font-bold text-[#002855]">Archivo de etiquetas</h2><p className="text-xs text-slate-500">{filtered.length} de {rows.length} bultos impresos</p></div>
        </div>
        <p className="text-xs text-slate-400">{lastUpdated ? `Actualizado: ${lastUpdated.toLocaleTimeString('es-PE')}` : 'Consultando…'}</p>
      </div>

      <label className="relative mb-4 block">
        <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por etiqueta, IPT, contrato, lote o producto" className="w-full rounded-lg border border-slate-300 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-blue-500"/>
      </label>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-600"><tr>
            <th className="p-3">Etiqueta / Paquete</th><th className="p-3">IPT · Contrato</th><th className="p-3">Producto</th>
            <th className="p-3">Lote · Bodega</th><th className="p-3 text-right">Cantidad</th><th className="p-3">Impresión</th><th className="p-3">Fecha</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-200">
            {filtered.map(row => <tr key={row.package_code} className="hover:bg-blue-50/60">
              <td className="p-3"><span className="font-mono font-bold text-[#002855]">{row.package_code}</span><small className="block text-slate-500">Bulto {row.sequence_no}/{row.sequence_total}</small></td>
              <td className="p-3 font-medium">{row.source_document_no}<small className="block text-slate-500">{row.source_contract_code || 'Sin contrato'}</small></td>
              <td className="p-3">{row.source_product_code}<small className="block max-w-xs truncate text-slate-500" title={row.description}>{row.description}</small></td>
              <td className="p-3">{row.source_lot || '—'}<small className="block text-slate-500">{row.source_warehouse}</small></td>
              <td className="p-3 text-right tabular-nums">{row.quantity} {row.unit || ''}{row.weight_kg !== null && <small className="block text-slate-500">{row.weight_kg} kg</small>}</td>
              <td className="p-3"><span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800">Impresa</span>{row.label_print_count > 1 && <small className="mt-1 block text-slate-500">{row.label_print_count - 1} reimpresión(es)</small>}</td>
              <td className="p-3 text-xs text-slate-600">{new Date(row.created_at).toLocaleDateString('es-PE')}</td>
            </tr>)}
            {!loading && filtered.length === 0 && <tr><td colSpan={7} className="p-10 text-center text-sm text-slate-500">{query ? 'No hay etiquetas impresas que coincidan con la búsqueda.' : 'Todavía no hay etiquetas impresas registradas.'}</td></tr>}
            {loading && <tr><td colSpan={7} className="p-10 text-center text-sm text-slate-500">Cargando etiquetas…</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">Las etiquetas que quedan pendientes siguen en «02 · Recepción por IPT» hasta registrar su impresión.</p>
    </section>
  </div>
}
