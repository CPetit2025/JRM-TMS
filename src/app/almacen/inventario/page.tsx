'use client'

import Link from 'next/link'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { ClipboardCheck, Plus } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { CAMPAIGN_STATE, INVENTORY_TYPE, fmtDate, type Campaign, type InventoryType } from '@/lib/warehouse/inventory'


export default function WarehouseInventoryPage() {
  const router = useRouter()
  const { hasAccess } = usePermissions()
  const isSupervisor = hasAccess('almacen-supervisor')
  const [rows, setRows] = useState<Campaign[]>([])
  const [bodegas, setBodegas] = useState<string[]>([])
  const [form, setForm] = useState({ bodega: '', zones: '', notes: '', tipo: 'BARRIDO' as InventoryType, productos: '' })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    const db = createClient()
    const [board, stock] = await Promise.all([db.rpc('wh_count_board'), db.rpc('erp_stock_query', { p_bodega: null, p_search: '__sin_filas__' })])
    if (board.error) setError(board.error.message); else setRows((board.data || []) as Campaign[])
    if (!stock.error) setBodegas((stock.data?.bodegas || []) as string[])
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  const open = async (e: FormEvent) => {
    e.preventDefault()
    if (!window.confirm(`¿Abrir inventario ${INVENTORY_TYPE[form.tipo].label.toLowerCase()} de ${form.bodega}? ${INVENTORY_TYPE[form.tipo].blocks}`)) return
    setBusy(true); setError('')
    const zones = form.zones.split(',').map(z => z.trim()).filter(Boolean)
    const productos = form.productos.split(/[s,;]+/).map(z => z.trim()).filter(Boolean)
    const { data, error } = await createClient().rpc('wh_count_open', { p_bodega: form.bodega, p_zones: zones, p_notes: form.notes || null, p_tipo: form.tipo, p_productos: productos })
    setBusy(false)
    if (error) { setError(error.message); return }
    router.push(`/almacen/inventario/${data.id}`)
  }

  const field = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-normal'
  return <div className="w-full space-y-5">
    <header>
      <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Control</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Inventario</h1>
      <p className="mt-1 text-sm text-slate-600">Barrido por bodega: se cuentan los bultos etiquetados y se etiquetan los que solo tienen rótulo. El cuadre es contra el stock ERP del corte de la campaña.</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}

    {isSupervisor && <form onSubmit={open} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_1fr_1.2fr_auto] lg:items-end">
      <label className="text-sm font-semibold">Tipo de inventario
        <select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value as InventoryType })} className={field}>
          {(Object.keys(INVENTORY_TYPE) as InventoryType[]).map(t => <option key={t} value={t}>{INVENTORY_TYPE[t].label}</option>)}
        </select></label>
      <label className="text-sm font-semibold">Bodega
        <select required value={form.bodega} onChange={e => setForm({ ...form, bodega: e.target.value })} className={field}>
          <option value="">Seleccione</option>{bodegas.map(b => <option key={b} value={b}>{b}</option>)}
        </select></label>
      <label className="text-sm font-semibold">Zonas del recorrido<input value={form.zones} onChange={e => setForm({ ...form, zones: e.target.value })} placeholder="A, B, C (opcional)" className={field}/></label>
      {form.tipo === 'CICLICO' && <label className="text-sm font-semibold">SKU a contar<input required value={form.productos} onChange={e => setForm({ ...form, productos: e.target.value })} placeholder="Códigos separados por coma" className={field}/></label>}
      <label className="text-sm font-semibold">Nota<input value={form.notes} maxLength={200} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Piloto, turno…" className={field}/></label>
      <button disabled={busy || !form.bodega} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"><Plus size={16}/>Abrir inventario</button>
      <p className={`text-xs sm:col-span-2 lg:col-span-5 ${form.tipo === 'GENERAL' ? 'font-semibold text-amber-800' : 'text-slate-500'}`}>{INVENTORY_TYPE[form.tipo].scope}. {INVENTORY_TYPE[form.tipo].blocks}</p>
    </form>}

    <section className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <header className="flex items-center gap-2 border-b p-3"><ClipboardCheck size={16} className="text-blue-700"/><h2 className="font-bold text-[#002855]">Campañas</h2></header>
      {loading ? <p className="p-8 text-center text-sm text-slate-500">Cargando…</p> : rows.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">Todavía no hay inventarios.</p>
        : <div className="divide-y">{rows.map(c => {
          const s = CAMPAIGN_STATE[c.status] || CAMPAIGN_STATE.ANULADA
          return <Link key={c.id} href={`/almacen/inventario/${c.id}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-3 text-sm hover:bg-blue-50/40">
            <b className="text-[#002855]">{c.code}</b>
            <span>{c.bodega}</span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{INVENTORY_TYPE[c.tipo]?.label || c.tipo}{c.tipo === 'CICLICO' && c.productos.length ? ` · ${c.productos.length} SKU` : ''}</span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${s.style}`}>{s.label}</span>
            <span className="text-slate-600">{c.counted_lines} bultos contados · {c.labeled} etiquetados · {c.expected_lines} lotes ERP</span>
            <span className="basis-full text-xs text-slate-600 sm:basis-auto">{c.status === 'EN_CONTEO' ? 'Siguiente: barrido y conteo' : c.status === 'EN_REVISION' ? 'Siguiente: abrir Cuadre para recontar, cerrar o anular' : c.status === 'ANULADA' ? (c.close_note || 'Anulada') : `Cerrada ${fmtDate(c.closed_at)}`}</span>
            <span className="ml-auto text-xs text-slate-500">corte ERP {fmtDate(c.erp_cut_at)} · {c.created_by_name || '—'} · {fmtDate(c.created_at)}</span>
            <span className="rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-bold text-white">Abrir</span>
          </Link>
        })}</div>}
    </section>
  </div>
}
