'use client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Plus, RefreshCw, Loader2, Edit2, ArrowDownToLine, SlidersHorizontal, ShieldCheck } from 'lucide-react'

// Inventario CMMS (Fase 7). Stock y costo promedio solo cambian por movimientos del kardex
// (register_inventory_movement / consume_work_order_part); migración 20260927200000.

const supabase = createClient()

interface StockRow {
  id: string; internal_code: string; name: string; brand: string | null; category: string | null; compatibility: string | null
  unit: string; location: string | null; current_stock: number; reserved: number; available: number
  minimum_stock: number; maximum_stock: number | null; average_price_pen: number; unit_price: number | null; stock_value: number
  warranty_months: number | null; warranty_km: number | null; warranty_conditions: string | null; is_active: boolean
  stock_status: 'SIN_STOCK' | 'BAJO_MINIMO' | 'SOBRE_MAXIMO' | 'OK'; open_replenishment_id: string | null
  replenishment_quantity: number | null; last_movement_at: string | null; site_id: string
}
interface KardexRow { id: string; created_at: string; internal_code: string; part_name: string; type: string; quantity_signed: number; unit_cost: number; total_cost: number; balance_after: number; average_cost_after: number; reference_document: string | null; reason: string | null; ot_code: string | null; vehicle_plate: string | null; provider_name: string | null; created_by_name: string | null }
interface Replenishment { id: string; spare_part_id: string; suggested_quantity: number; available_at_request: number; status: string; notes: string | null; created_at: string; spare_parts: { internal_code: string; name: string } | null }
interface Warranty { id: string; internal_code: string; part_name: string; vehicle_plate: string; provider_name: string | null; installed_at: string; expires_at: string | null; km_remaining: number | null; conditions: string | null; warranty_status: string }
interface Consumption { id?: string; month: string; vehicle_plate: string; internal_code: string; part_name: string; quantity: number; cost: number; work_orders: number }

const STATUS_STYLE: Record<string, string> = { SIN_STOCK: 'bg-red-100 text-red-700', BAJO_MINIMO: 'bg-amber-100 text-amber-700', SOBRE_MAXIMO: 'bg-sky-100 text-sky-700', OK: 'bg-emerald-100 text-emerald-700' }
const money = (n: number | null | undefined) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const TABS = [['stock', 'Stock'], ['kardex', 'Kardex'], ['reposicion', 'Reposición'], ['garantias', 'Garantías'], ['consumo', 'Consumo']] as const

function loadAll() {
  return Promise.all([
    supabase.from('vw_spare_parts_stock').select('*').order('internal_code'),
    supabase.from('vw_inventory_kardex').select('*').order('created_at', { ascending: false }).limit(300),
    supabase.from('spare_part_replenishment_requests').select('*, spare_parts(internal_code, name)').order('created_at', { ascending: false }).limit(100),
    supabase.from('vw_part_warranties').select('*').order('installed_at', { ascending: false }).limit(200),
    supabase.from('vw_parts_consumption').select('*').order('month', { ascending: false }).limit(300),
    supabase.from('maintenance_providers').select('id, business_name').order('business_name'),
  ])
}

export default function InventarioPage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('stock')
  const [stock, setStock] = useState<StockRow[]>([])
  const [kardex, setKardex] = useState<KardexRow[]>([])
  const [repl, setRepl] = useState<Replenishment[]>([])
  const [warranties, setWarranties] = useState<Warranty[]>([])
  const [consumption, setConsumption] = useState<Consumption[]>([])
  const [providers, setProviders] = useState<{ id: string; business_name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('TODOS')
  const [editing, setEditing] = useState<StockRow | 'new' | null>(null)
  const [movement, setMovement] = useState<{ part: StockRow; type: 'INGRESO' | 'AJUSTE' } | null>(null)

  const apply = useCallback(([st, kx, rp, wr, cs, pv]: Awaited<ReturnType<typeof loadAll>>) => {
    if (st.error) toast.error('Error al cargar inventario: ' + st.error.message)
    setStock((st.data || []) as StockRow[]); setKardex((kx.data || []) as KardexRow[]); setRepl((rp.data || []) as Replenishment[])
    setWarranties((wr.data || []) as Warranty[]); setConsumption((cs.data || []) as Consumption[]); setProviders(pv.data || [])
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const filtered = useMemo(() => stock.filter(p =>
    (statusFilter === 'TODOS' || p.stock_status === statusFilter) &&
    (!search || `${p.internal_code} ${p.name} ${p.brand || ''} ${p.compatibility || ''}`.toLowerCase().includes(search.toLowerCase()))), [stock, search, statusFilter])

  const kpis = useMemo(() => ({
    value: stock.reduce((s, p) => s + Number(p.stock_value || 0), 0),
    below: stock.filter(p => p.stock_status === 'BAJO_MINIMO').length,
    empty: stock.filter(p => p.stock_status === 'SIN_STOCK').length,
    repl: repl.filter(r => r.status === 'PENDIENTE' || r.status === 'APROBADA').length,
    reserved: stock.reduce((s, p) => s + Number(p.reserved || 0) * Number(p.average_price_pen || 0), 0),
  }), [stock, repl])

  const setReplStatus = async (r: Replenishment, status: 'APROBADA' | 'ANULADA') => {
    const { error } = await supabase.from('spare_part_replenishment_requests').update({ status, resolved_at: status === 'ANULADA' ? new Date().toISOString() : null }).eq('id', r.id)
    if (error) return toast.error(error.message)
    toast.success(`Solicitud ${status.toLowerCase()}`); refresh()
  }

  const claimWarranty = async (w: Warranty) => {
    const notes = prompt('Detalle del reclamo de garantía:')
    if (!notes?.trim()) return
    const { error } = await supabase.from('part_warranties').update({ status: 'RECLAMADA', claimed_at: new Date().toISOString(), claim_notes: notes }).eq('id', w.id)
    if (error) return toast.error(error.message)
    toast.success('Garantía reclamada'); refresh()
  }

  return (
    <div className="space-y-3">
      <PageHeader showTitle title="Repuestos e inventario" description="Kardex con costo promedio ponderado, reservas por OT, reposición automática y garantías de repuestos instalados." actions={<>
<div className="flex gap-2">
          <button onClick={() => setEditing('new')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Nuevo repuesto</button>
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
</>} />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[['Valor del stock', money(kpis.value)], ['Valor reservado', money(kpis.reserved)], ['Sin stock', kpis.empty], ['Bajo mínimo', kpis.below], ['Reposiciones abiertas', kpis.repl]]
          .map(([l, v]) => <div key={l as string} className="bg-white border rounded-xl p-3"><div className="text-xs text-slate-500">{l}</div><div className="text-xl font-bold">{v}</div></div>)}
      </div>

      <div className="flex flex-wrap gap-1 border-b">
        {TABS.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? 'border-[#002855] text-[#002855] font-semibold' : 'border-transparent text-slate-500'}`}>{l}</button>)}
      </div>

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          {tab === 'stock' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar código, nombre, marca o compatibilidad…" className="border rounded-lg px-3 py-2 text-sm w-80" />
                <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
                  <option value="TODOS">Todos</option><option value="SIN_STOCK">Sin stock</option><option value="BAJO_MINIMO">Bajo mínimo</option><option value="SOBRE_MAXIMO">Sobre máximo</option><option value="OK">OK</option>
                </select>
              </div>
              <div className="bg-white border rounded-xl overflow-x-auto">
                <DataTable className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                    <th className="text-left p-3">Repuesto</th><th className="text-right p-3">Stock</th><th className="text-right p-3">Reservado</th><th className="text-right p-3">Disponible</th>
                    <th className="text-right p-3">Mín / Máx</th><th className="text-right p-3">Costo prom.</th><th className="text-left p-3">Estado</th><th className="p-3"></th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {filtered.map(p => (
                      <tr key={p.id} className={p.is_active ? '' : 'opacity-50'}>
                        <td className="p-3"><div className="font-semibold">{p.internal_code}</div><div className="text-xs text-slate-500">{p.name}{p.brand ? ` · ${p.brand}` : ''}{p.location ? ` · ${p.location}` : ''}</div></td>
                        <td className="p-3 text-right">{p.current_stock} <span className="text-xs text-slate-400">{p.unit}</span></td>
                        <td className="p-3 text-right">{p.reserved}</td>
                        <td className="p-3 text-right font-semibold">{p.available}</td>
                        <td className="p-3 text-right text-xs">{p.minimum_stock} / {p.maximum_stock ?? '—'}</td>
                        <td className="p-3 text-right">{money(p.average_price_pen)}</td>
                        <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${STATUS_STYLE[p.stock_status]}`}>{p.stock_status.replace('_', ' ')}</span>{p.open_replenishment_id && <div className="text-[11px] text-amber-700">Reposición: {p.replenishment_quantity}</div>}</td>
                        <td className="p-3">
                          <div className="flex gap-1 justify-end">
                            <button title="Ingreso" onClick={() => setMovement({ part: p, type: 'INGRESO' })} className="p-1.5 border rounded-lg"><ArrowDownToLine className="w-4 h-4" /></button>
                            <button title="Ajuste" onClick={() => setMovement({ part: p, type: 'AJUSTE' })} className="p-1.5 border rounded-lg"><SlidersHorizontal className="w-4 h-4" /></button>
                            <button title="Editar" onClick={() => setEditing(p)} className="p-1.5 border rounded-lg"><Edit2 className="w-4 h-4" /></button>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-slate-500">Sin repuestos con estos filtros.</td></tr>}
                  </tbody>
                </DataTable>
              </div>
            </div>
          )}

          {tab === 'kardex' && (
            <Table rows={kardex} empty="Sin movimientos" cols={[
              ['Fecha', r => format(new Date(r.created_at), 'dd/MM/yyyy HH:mm')], ['Repuesto', r => `${r.internal_code} · ${r.part_name}`], ['Tipo', r => r.type],
              ['Cantidad', r => <span className={r.quantity_signed < 0 ? 'text-red-600' : 'text-emerald-700'}>{r.quantity_signed > 0 ? '+' : ''}{r.quantity_signed}</span>],
              ['Costo unit.', r => money(r.unit_cost)], ['Total', r => money(r.total_cost)], ['Saldo', r => r.balance_after], ['Costo prom.', r => money(r.average_cost_after)],
              ['Referencia', r => [r.ot_code && `${r.ot_code} (${r.vehicle_plate})`, r.reference_document, r.reason, r.provider_name].filter(Boolean).join(' · ') || '—'],
              ['Usuario', r => r.created_by_name || '—'],
            ]} />
          )}

          {tab === 'reposicion' && (
            <Table rows={repl} empty="Sin solicitudes de reposición" cols={[
              ['Fecha', r => format(new Date(r.created_at), 'dd/MM/yyyy')], ['Repuesto', r => `${r.spare_parts?.internal_code} · ${r.spare_parts?.name}`],
              ['Disponible al generar', r => r.available_at_request], ['Cantidad sugerida', r => r.suggested_quantity], ['Estado', r => r.status],
              ['', r => (r.status === 'PENDIENTE' || r.status === 'APROBADA') ? (
                <div className="flex gap-1 justify-end">
                  {r.status === 'PENDIENTE' && <button onClick={() => setReplStatus(r, 'APROBADA')} className="px-2 py-1 border rounded text-xs">Aprobar</button>}
                  <button onClick={() => setReplStatus(r, 'ANULADA')} className="px-2 py-1 border rounded text-xs text-red-600">Anular</button>
                </div>) : <span className="text-xs text-slate-400">{r.notes}</span>],
            ]} />
          )}

          {tab === 'garantias' && (
            <Table rows={warranties} empty="Sin garantías registradas (configure meses/km de garantía en el repuesto)" cols={[
              ['Repuesto', r => `${r.internal_code} · ${r.part_name}`], ['Unidad', r => r.vehicle_plate], ['Proveedor', r => r.provider_name || '—'],
              ['Instalado', r => format(new Date(r.installed_at), 'dd/MM/yyyy')], ['Vence', r => r.expires_at || '—'], ['Km restantes', r => r.km_remaining ?? '—'],
              ['Estado', r => <span className={`px-2 py-0.5 rounded text-xs font-semibold ${r.warranty_status === 'VIGENTE' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{r.warranty_status}</span>],
              ['', r => r.warranty_status === 'VIGENTE' ? <button onClick={() => claimWarranty(r)} className="px-2 py-1 border rounded text-xs flex items-center gap-1"><ShieldCheck className="w-3.5 h-3.5" />Reclamar</button> : null],
            ]} />
          )}

          {tab === 'consumo' && (
            <Table rows={consumption} empty="Sin consumos registrados" cols={[
              ['Mes', r => format(new Date(`${r.month}T12:00:00`), 'MM/yyyy')], ['Unidad', r => r.vehicle_plate], ['Repuesto', r => `${r.internal_code} · ${r.part_name}`],
              ['Cantidad', r => r.quantity], ['Costo', r => money(r.cost)], ['OT', r => r.work_orders],
            ]} />
          )}
        </>
      )}

      {editing && <PartModal part={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
      {movement && <MovementModal {...movement} providers={providers} onClose={() => setMovement(null)} onSaved={() => { setMovement(null); refresh() }} />}
    </div>
  )
}

function Table<T extends { id?: string }>({ rows, cols, empty }: { rows: T[]; cols: [string, (r: T) => React.ReactNode][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500 p-4">{empty}</p>
  return (
    <div className="bg-white border rounded-xl overflow-x-auto">
      <DataTable className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{cols.map(([h], i) => <th key={i} className="text-left p-3">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{rows.map((r, i) => <tr key={r.id ?? i}>{cols.map(([, fn], j) => <td key={j} className="p-3">{fn(r)}</td>)}</tr>)}</tbody>
      </DataTable>
    </div>
  )
}

function PartModal({ part, onClose, onSaved }: { part: StockRow | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    internal_code: part?.internal_code || '', name: part?.name || '', brand: part?.brand || '', category: part?.category || '',
    compatibility: part?.compatibility || '', unit: part?.unit || 'UNIDAD', location: part?.location || '',
    minimum_stock: String(part?.minimum_stock ?? 0), maximum_stock: part?.maximum_stock != null ? String(part.maximum_stock) : '',
    warranty_months: part?.warranty_months != null ? String(part.warranty_months) : '', warranty_km: part?.warranty_km != null ? String(part.warranty_km) : '',
    warranty_conditions: part?.warranty_conditions || '', is_active: part?.is_active ?? true,
  })
  const [saving, setSaving] = useState(false)
  const num = (v: string) => (v.trim() === '' ? null : Number(v))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const payload = { ...form, minimum_stock: num(form.minimum_stock) ?? 0, maximum_stock: num(form.maximum_stock), warranty_months: num(form.warranty_months), warranty_km: num(form.warranty_km),
      brand: form.brand || null, category: form.category || null, compatibility: form.compatibility || null, location: form.location || null, warranty_conditions: form.warranty_conditions || null }
    const { error } = part ? await supabase.from('spare_parts').update(payload).eq('id', part.id) : await supabase.from('spare_parts').insert(payload)
    setSaving(false)
    if (error) return toast.error(error.code === '23505' ? 'Ya existe un repuesto con ese código en la sede' : error.message)
    toast.success(part ? 'Repuesto actualizado' : 'Repuesto creado; registre su stock inicial con un INGRESO')
    onSaved()
  }
  const field = 'w-full border rounded-lg px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title={part ? `Editar ${part.internal_code}` : 'Nuevo repuesto'} maxWidth="max-w-2xl">
      <form onSubmit={save} className="grid md:grid-cols-2 gap-3 text-sm">
        <label>Código<input required className={field} value={form.internal_code} onChange={e => setForm({ ...form, internal_code: e.target.value })} /></label>
        <label>Nombre<input required className={field} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label>Marca<input className={field} value={form.brand} onChange={e => setForm({ ...form, brand: e.target.value })} /></label>
        <label>Categoría<input className={field} value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} /></label>
        <label className="md:col-span-2">Compatibilidad<input className={field} value={form.compatibility} onChange={e => setForm({ ...form, compatibility: e.target.value })} /></label>
        <label>Unidad de medida<input className={field} value={form.unit} onChange={e => setForm({ ...form, unit: e.target.value.toUpperCase() })} /></label>
        <label>Ubicación en almacén<input className={field} value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} /></label>
        <label>Stock mínimo<input type="number" min={0} step="0.01" className={field} value={form.minimum_stock} onChange={e => setForm({ ...form, minimum_stock: e.target.value })} /></label>
        <label>Stock máximo<input type="number" min={0} step="0.01" className={field} value={form.maximum_stock} onChange={e => setForm({ ...form, maximum_stock: e.target.value })} /></label>
        <label>Garantía (meses)<input type="number" min={1} className={field} value={form.warranty_months} onChange={e => setForm({ ...form, warranty_months: e.target.value })} /></label>
        <label>Garantía (km)<input type="number" min={1} className={field} value={form.warranty_km} onChange={e => setForm({ ...form, warranty_km: e.target.value })} /></label>
        <label className="md:col-span-2">Condiciones de garantía<input className={field} value={form.warranty_conditions} onChange={e => setForm({ ...form, warranty_conditions: e.target.value })} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_active} onChange={e => setForm({ ...form, is_active: e.target.checked })} />Activo</label>
        <div className="md:col-span-2 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
          <button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">{saving ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </form>
    </Modal>
  )
}

function MovementModal({ part, type, providers, onClose, onSaved }: { part: StockRow; type: 'INGRESO' | 'AJUSTE'; providers: { id: string; business_name: string }[]; onClose: () => void; onSaved: () => void }) {
  const [quantity, setQuantity] = useState('')
  const [unitCost, setUnitCost] = useState(part.unit_price ? String(part.unit_price) : '')
  const [document, setDocument] = useState('')
  const [provider, setProvider] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    const { data, error } = await supabase.rpc('register_inventory_movement', {
      p_spare_part_id: part.id, p_type: type, p_quantity: Number(quantity),
      p_unit_cost: type === 'INGRESO' ? Number(unitCost) : null, p_document: document || null, p_provider_id: provider || null, p_reason: reason || null,
    })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(`${type === 'INGRESO' ? 'Ingreso' : 'Ajuste'} registrado. Saldo: ${data.balance_after}`)
    onSaved()
  }
  const field = 'w-full border rounded-lg px-3 py-2 text-sm'
  return (
    <Modal isOpen onClose={onClose} title={`${type === 'INGRESO' ? 'Ingreso' : 'Ajuste'} · ${part.internal_code}`}>
      <form onSubmit={save} className="space-y-3 text-sm">
        <p className="text-xs text-slate-500">Stock actual {part.current_stock} {part.unit} · costo promedio {money(part.average_price_pen)}</p>
        <label className="block">Cantidad {type === 'AJUSTE' && <span className="text-xs text-slate-400">(negativa para disminuir)</span>}
          <input required type="number" step="0.01" min={type === 'INGRESO' ? 0.01 : undefined} className={field} value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
        {type === 'INGRESO' && (
          <>
            <label className="block">Costo unitario (S/)<input required type="number" min={0} step="0.0001" className={field} value={unitCost} onChange={e => setUnitCost(e.target.value)} /></label>
            <label className="block">Proveedor<select className={field} value={provider} onChange={e => setProvider(e.target.value)}><option value="">—</option>{providers.map(p => <option key={p.id} value={p.id}>{p.business_name}</option>)}</select></label>
            <label className="block">Comprobante<input className={field} value={document} onChange={e => setDocument(e.target.value)} placeholder="Factura / guía" /></label>
          </>
        )}
        {type === 'AJUSTE' && <label className="block">Motivo (obligatorio)<input required className={field} value={reason} onChange={e => setReason(e.target.value)} placeholder="Conteo físico, merma…" /></label>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button>
          <button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">{saving ? 'Registrando…' : 'Registrar'}</button>
        </div>
      </form>
    </Modal>
  )
}
