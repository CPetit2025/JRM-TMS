'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Building2, Plus, RefreshCw, Loader2, Edit2, Check, X } from 'lucide-react'

// Proveedores, talleres y garantías (Fase 10). Los KPI se calculan desde las OT reales
// (vw_provider_performance); no hay puntajes almacenados (migración 20260928110000).

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const TYPES = ['TALLER', 'REPUESTOS', 'SERVICIO_EXTERNO', 'LLANTERIA', 'GRUA', 'OTRO']
const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const pct = (n: unknown) => (n == null ? '—' : `${Number(n).toFixed(1)}%`)
const field = 'w-full border rounded-lg px-3 py-2 text-sm'

function loadAll() {
  return Promise.all([
    supabase.from('vw_provider_performance').select('*').order('business_name'),
    supabase.from('maintenance_providers').select('*').order('business_name'),
    supabase.from('provider_rates').select('*, maintenance_providers(business_name)').order('service_name'),
    supabase.from('service_quotes').select('*, maintenance_providers(business_name), maintenance_work_orders(ot_code, description, status)').order('created_at', { ascending: false }).limit(200),
    supabase.from('vw_active_warranties').select('*').order('expires_at'),
    supabase.from('vw_work_orders').select('id, ot_code, vehicle_plate, description, status').not('status', 'in', '(CERRADA,CANCELADA)').order('created_at', { ascending: false }).limit(200),
  ])
}

export default function ProveedoresPage() {
  const [tab, setTab] = useState<'desempeno' | 'tarifario' | 'cotizaciones' | 'garantias'>('desempeno')
  const [perf, setPerf] = useState<Row[]>([])
  const [providers, setProviders] = useState<Row[]>([])
  const [rates, setRates] = useState<Row[]>([])
  const [quotes, setQuotes] = useState<Row[]>([])
  const [warranties, setWarranties] = useState<Row[]>([])
  const [openWos, setOpenWos] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Row | 'new' | null>(null)
  const [modal, setModal] = useState<'rate' | 'quote' | null>(null)

  const apply = useCallback(([p, pr, r, q, w, wo]: Awaited<ReturnType<typeof loadAll>>) => {
    if (p.error) toast.error('Error al cargar proveedores: ' + p.error.message)
    setPerf(p.data || []); setProviders(pr.data || []); setRates(r.data || []); setQuotes(q.data || []); setWarranties(w.data || []); setOpenWos(wo.data || [])
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const filtered = useMemo(() => perf.filter(p => !search || `${p.business_name} ${p.ruc} ${p.specialty || ''}`.toLowerCase().includes(search.toLowerCase())), [perf, search])

  const decide = async (q: Row, decision: 'APROBADA' | 'RECHAZADA') => {
    const notes = decision === 'RECHAZADA' ? prompt('Motivo del rechazo:') : prompt('Comentario de la aprobación (opcional):')
    if (decision === 'RECHAZADA' && !notes?.trim()) return
    const { data, error } = await supabase.rpc('decide_service_quote', { p_quote_id: q.id, p_decision: decision, p_notes: notes || null })
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(decision === 'APROBADA' ? 'Cotización aprobada: el proveedor quedó asignado a la OT' : 'Cotización rechazada'); refresh()
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Building2 className="w-6 h-6" />Proveedores, talleres y garantías</h1>
          <p className="text-sm text-slate-500">Desempeño calculado desde las OT: tiempo de atención, cumplimiento de SLA, costo, retrabajos, reclamos de garantía y calificación.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing('new')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Nuevo proveedor</button>
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {([['desempeno', 'Proveedores y desempeño'], ['tarifario', 'Tarifario'], ['cotizaciones', 'Cotizaciones'], ['garantias', 'Garantías vigentes']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 text-sm border-b-2 -mb-px ${tab === k ? 'border-[#002855] text-[#002855] font-semibold' : 'border-transparent text-slate-500'}`}>{l}</button>
        ))}
      </div>

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          {tab === 'desempeno' && (
            <div className="space-y-3">
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar razón social, RUC o especialidad…" className="border rounded-lg px-3 py-2 text-sm w-80" />
              <Table rows={filtered} empty="Aún no hay proveedores registrados" cols={[
                ['Proveedor', r => <div><div className="font-semibold">{r.business_name}</div><div className="text-xs text-slate-500">RUC {r.ruc} · {r.provider_type}{r.specialty ? ` · ${r.specialty}` : ''}</div></div>],
                ['Estado', r => <span className={`px-2 py-0.5 rounded text-xs font-semibold ${r.status === 'ACTIVO' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{r.status}</span>],
                ['OT (cerradas)', r => `${r.work_orders} (${r.closed_work_orders})`], ['Atención prom.', r => r.avg_attention_hours != null ? `${r.avg_attention_hours} h` : '—'],
                ['SLA', r => r.sla_hours ? `${pct(r.sla_compliance_pct)} ≤${r.sla_hours} h` : 'sin SLA'], ['Gasto', r => money(r.total_spend)],
                ['Retrabajos / reclamos', r => `${r.reworks} / ${r.warranty_claims}`], ['Calificación', r => r.avg_score ?? '—'],
                ['Índice de calidad', r => r.quality_index != null ? <b className={Number(r.quality_index) >= 80 ? 'text-emerald-700' : Number(r.quality_index) >= 60 ? 'text-amber-600' : 'text-red-600'}>{r.quality_index}</b> : '—'],
                ['', r => <button onClick={() => setEditing(providers.find(p => p.id === r.provider_id) || null)} className="p-1.5 border rounded-lg"><Edit2 className="w-4 h-4" /></button>],
              ]} />
            </div>
          )}

          {tab === 'tarifario' && (
            <div className="space-y-3">
              <button onClick={() => setModal('rate')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Nueva tarifa</button>
              <Table rows={rates} empty="Sin tarifas registradas" cols={[
                ['Proveedor', r => r.maintenance_providers?.business_name], ['Servicio', r => r.service_name], ['Unidad', r => r.unit], ['Precio', r => money(r.price)],
                ['Vigencia', r => `${r.valid_from}${r.valid_to ? ` → ${r.valid_to}` : ''}`]]} />
            </div>
          )}

          {tab === 'cotizaciones' && (
            <div className="space-y-3">
              <button onClick={() => setModal('quote')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Registrar cotización</button>
              <Table rows={quotes} empty="Sin cotizaciones" cols={[
                ['Fecha', r => format(new Date(r.created_at), 'dd/MM/yyyy')], ['OT', r => `${r.maintenance_work_orders?.ot_code} · ${r.maintenance_work_orders?.description ?? ''}`],
                ['Proveedor', r => r.maintenance_providers?.business_name], ['Monto', r => money(r.amount)], ['Válida hasta', r => r.valid_until || '—'],
                ['Estado', r => r.status], ['', r => r.status === 'PENDIENTE' ? (
                  <div className="flex gap-1 justify-end">
                    <button title="Aprobar" onClick={() => decide(r, 'APROBADA')} className="p-1.5 border rounded-lg text-emerald-700"><Check className="w-4 h-4" /></button>
                    <button title="Rechazar" onClick={() => decide(r, 'RECHAZADA')} className="p-1.5 border rounded-lg text-red-600"><X className="w-4 h-4" /></button>
                  </div>) : <span className="text-xs text-slate-400">{r.decision_notes}</span>]]} />
            </div>
          )}

          {tab === 'garantias' && (
            <Table rows={warranties} empty="No hay garantías vigentes" cols={[
              ['Tipo', r => r.warranty_kind], ['Unidad', r => r.vehicle_plate], ['Alcance', r => r.scope], ['Proveedor', r => r.provider_name || '—'],
              ['Vence', r => r.expires_at || '—'], ['Km restantes', r => r.km_remaining ?? '—']]} />
          )}
        </>
      )}

      {editing && <ProviderModal provider={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
      {modal === 'rate' && <RateModal providers={providers.filter(p => p.status === 'ACTIVO')} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh() }} />}
      {modal === 'quote' && <QuoteModal providers={providers.filter(p => p.status === 'ACTIVO')} workOrders={openWos} onClose={() => setModal(null)} onSaved={() => { setModal(null); refresh() }} />}
    </div>
  )
}

function Table({ rows, cols, empty }: { rows: Row[]; cols: [string, (r: Row) => React.ReactNode][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-slate-500 p-4">{empty}</p>
  return (
    <div className="bg-white border rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>{cols.map(([h], i) => <th key={i} className="text-left p-3">{h}</th>)}</tr></thead>
        <tbody className="divide-y">{rows.map((r, i) => <tr key={r.id ?? r.provider_id ?? i}>{cols.map(([, fn], j) => <td key={j} className="p-3">{fn(r)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

function ProviderModal({ provider, onClose, onSaved }: { provider: Row | null; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    ruc: provider?.ruc || '', business_name: provider?.business_name || '', provider_type: provider?.provider_type || 'TALLER', specialty: provider?.specialty || '',
    address: provider?.address || '', contact_name: provider?.contact_name || '', contact_phone: provider?.contact_phone || '', email: provider?.email || '',
    sla_hours: provider?.sla_hours ?? '', default_warranty_days: provider?.default_warranty_days ?? '', default_warranty_km: provider?.default_warranty_km ?? '',
    payment_terms: provider?.payment_terms || '', status: provider?.status || 'ACTIVO', notes: provider?.notes || '',
  })
  const [saving, setSaving] = useState(false)
  const num = (v: unknown) => (v === '' || v == null ? null : Number(v))
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const payload = { ...f, sla_hours: num(f.sla_hours), default_warranty_days: num(f.default_warranty_days), default_warranty_km: num(f.default_warranty_km) }
    const { error } = provider ? await supabase.from('maintenance_providers').update(payload).eq('id', provider.id) : await supabase.from('maintenance_providers').insert(payload)
    setSaving(false)
    if (error) return toast.error(error.code === '23505' ? 'Ya existe un proveedor con ese RUC' : error.message)
    toast.success('Proveedor guardado'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title={provider ? `Editar ${provider.business_name}` : 'Nuevo proveedor'} maxWidth="max-w-2xl">
      <form onSubmit={save} className="grid md:grid-cols-2 gap-3 text-sm max-h-[75vh] overflow-y-auto pr-1">
        <label>RUC<input required className={field} value={f.ruc} onChange={e => setF({ ...f, ruc: e.target.value })} /></label>
        <label>Razón social<input required className={field} value={f.business_name} onChange={e => setF({ ...f, business_name: e.target.value })} /></label>
        <label>Tipo<select className={field} value={f.provider_type} onChange={e => setF({ ...f, provider_type: e.target.value })}>{TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</select></label>
        <label>Especialidad<input className={field} value={f.specialty} onChange={e => setF({ ...f, specialty: e.target.value })} /></label>
        <label className="md:col-span-2">Dirección<input className={field} value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></label>
        <label>Contacto<input className={field} value={f.contact_name} onChange={e => setF({ ...f, contact_name: e.target.value })} /></label>
        <label>Teléfono<input className={field} value={f.contact_phone} onChange={e => setF({ ...f, contact_phone: e.target.value })} /></label>
        <label>Correo<input type="email" className={field} value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></label>
        <label>Condiciones de pago<input className={field} value={f.payment_terms} onChange={e => setF({ ...f, payment_terms: e.target.value })} /></label>
        <label>SLA pactado (horas de atención)<input type="number" min={1} className={field} value={f.sla_hours} onChange={e => setF({ ...f, sla_hours: e.target.value })} /></label>
        <label>Estado<select className={field} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>{['ACTIVO', 'SUSPENDIDO', 'INACTIVO'].map(s => <option key={s}>{s}</option>)}</select></label>
        <label>Garantía del servicio (días)<input type="number" min={1} className={field} value={f.default_warranty_days} onChange={e => setF({ ...f, default_warranty_days: e.target.value })} /></label>
        <label>Garantía del servicio (km)<input type="number" min={1} className={field} value={f.default_warranty_km} onChange={e => setF({ ...f, default_warranty_km: e.target.value })} /></label>
        <label className="md:col-span-2">Notas<input className={field} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></label>
        <div className="md:col-span-2 flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">Guardar</button></div>
      </form>
    </Modal>
  )
}

function RateModal({ providers, onClose, onSaved }: { providers: Row[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ provider_id: '', service_name: '', unit: 'SERVICIO', price: '', valid_from: '', valid_to: '' })
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const { error } = await supabase.from('provider_rates').insert({ ...f, price: Number(f.price), valid_from: f.valid_from || undefined, valid_to: f.valid_to || null })
    if (error) return toast.error(error.message)
    toast.success('Tarifa registrada'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title="Nueva tarifa">
      <form onSubmit={save} className="space-y-3 text-sm">
        <label className="block">Proveedor<select required className={field} value={f.provider_id} onChange={e => setF({ ...f, provider_id: e.target.value })}><option value="">Seleccionar…</option>{providers.map(p => <option key={p.id} value={p.id}>{p.business_name}</option>)}</select></label>
        <label className="block">Servicio<input required className={field} value={f.service_name} onChange={e => setF({ ...f, service_name: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label>Unidad<input className={field} value={f.unit} onChange={e => setF({ ...f, unit: e.target.value.toUpperCase() })} /></label>
          <label>Precio (S/)<input required type="number" min={0} step="0.01" className={field} value={f.price} onChange={e => setF({ ...f, price: e.target.value })} /></label>
          <label>Desde<input type="date" className={field} value={f.valid_from} onChange={e => setF({ ...f, valid_from: e.target.value })} /></label>
          <label>Hasta<input type="date" className={field} value={f.valid_to} onChange={e => setF({ ...f, valid_to: e.target.value })} /></label>
        </div>
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button className="px-4 py-2 bg-[#002855] text-white rounded-lg">Guardar</button></div>
      </form>
    </Modal>
  )
}

function QuoteModal({ providers, workOrders, onClose, onSaved }: { providers: Row[]; workOrders: Row[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ work_order_id: '', provider_id: '', amount: '', estimated_hours: '', valid_until: '', description: '' })
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    const { error } = await supabase.from('service_quotes').insert({
      work_order_id: f.work_order_id, provider_id: f.provider_id, amount: Number(f.amount), estimated_hours: f.estimated_hours ? Number(f.estimated_hours) : null,
      valid_until: f.valid_until || null, description: f.description || null,
    })
    if (error) return toast.error(error.message)
    toast.success('Cotización registrada'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title="Registrar cotización">
      <form onSubmit={save} className="space-y-3 text-sm">
        <label className="block">OT<select required className={field} value={f.work_order_id} onChange={e => setF({ ...f, work_order_id: e.target.value })}><option value="">Seleccionar…</option>{workOrders.map(w => <option key={w.id} value={w.id}>{w.ot_code} · {w.vehicle_plate} · {w.description}</option>)}</select></label>
        <label className="block">Proveedor<select required className={field} value={f.provider_id} onChange={e => setF({ ...f, provider_id: e.target.value })}><option value="">Seleccionar…</option>{providers.map(p => <option key={p.id} value={p.id}>{p.business_name}</option>)}</select></label>
        <div className="grid grid-cols-3 gap-3">
          <label>Monto (S/)<input required type="number" min={0} step="0.01" className={field} value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></label>
          <label>Horas estimadas<input type="number" min={0} step="0.5" className={field} value={f.estimated_hours} onChange={e => setF({ ...f, estimated_hours: e.target.value })} /></label>
          <label>Válida hasta<input type="date" className={field} value={f.valid_until} onChange={e => setF({ ...f, valid_until: e.target.value })} /></label>
        </div>
        <label className="block">Detalle<input className={field} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></label>
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button className="px-4 py-2 bg-[#002855] text-white rounded-lg">Guardar</button></div>
      </form>
    </Modal>
  )
}
