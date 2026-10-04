'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Modal } from '@/components/ui/modal'
import { toast } from 'sonner'
import { FileSignature, Plus, RefreshCw, Loader2, RotateCw, Edit2 } from 'lucide-react'

// Contratos de alquiler (Fase 11): tarifa mensual/diaria/horaria/por km, km/horas incluidos, excesos,
// descuento por indisponibilidad, condiciones y renovación encadenada. Sin traslapes por unidad
// (migración 20260928130000). El maestro de la unidad refleja la propiedad ALQUILADO.
// Días base, garantía, km adicional con 4 decimales y km por rutas del sistema: migración 20261005120000.

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const field = 'w-full border rounded-lg px-3 py-2 text-sm'
const RATE_LABEL: Record<string, string> = { MENSUAL: 'por mes', DIARIA: 'por día', HORARIA: 'por hora', KM: 'por km' }

function loadAll() {
  return Promise.all([
    supabase.from('vehicle_lease_contracts').select('*, vehicles(plate, type), carriers(business_name)').order('start_date', { ascending: false }),
    supabase.from('vehicles').select('id, plate').order('plate'),
    supabase.from('carriers').select('id, business_name').neq('type', 'PROPIO').eq('is_active', true).order('business_name'),
  ])
}

export default function ContratosAlquilerPage() {
  const [contracts, setContracts] = useState<Row[]>([])
  const [vehicles, setVehicles] = useState<Row[]>([])
  const [lessors, setLessors] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<Row | 'new' | null>(null)

  const apply = useCallback(([c, v, l]: Awaited<ReturnType<typeof loadAll>>) => {
    if (c.error) toast.error('Error al cargar contratos: ' + c.error.message)
    setContracts(c.data || []); setVehicles(v.data || []); setLessors(l.data || [])
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const filtered = useMemo(() => contracts.filter(c => !search || `${c.contract_code} ${c.vehicles?.plate} ${c.carriers?.business_name}`.toLowerCase().includes(search.toLowerCase())), [contracts, search])

  const renew = async (c: Row) => {
    const end = prompt('Nueva fecha de término (AAAA-MM-DD):')
    if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return
    const rate = prompt(`Nueva tarifa (${RATE_LABEL[c.rate_type]}) — vacío mantiene ${c.rate_amount}:`)
    const { data, error } = await supabase.rpc('renew_lease_contract', { p_contract_id: c.id, p_new_end: end, p_rate_amount: rate ? Number(rate) : null, p_notes: null })
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success('Contrato renovado'); refresh()
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><FileSignature className="w-6 h-6" />Contratos de alquiler</h1>
          <p className="text-sm text-slate-500">Unidades alquiladas (alquiler seco) por arrendador, con tarifas, condiciones y renovaciones.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setEditing('new')} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Plus className="w-4 h-4" />Nuevo contrato</button>
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
      </div>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar código, placa o arrendador…" className="border rounded-lg px-3 py-2 text-sm w-72" />
      <div className="bg-white border rounded-xl overflow-x-auto">
        {loading ? <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : filtered.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">Sin contratos.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="text-left p-3">Contrato</th><th className="text-left p-3">Unidad / arrendador</th><th className="text-left p-3">Tarifa</th>
              <th className="text-left p-3">Incluido / excesos</th><th className="text-left p-3">Vigencia</th><th className="text-left p-3">Estado</th><th className="p-3"></th>
            </tr></thead>
            <tbody className="divide-y">
              {filtered.map(c => (
                <tr key={c.id}>
                  <td className="p-3 font-semibold">{c.contract_code}{c.parent_contract_id && <div className="text-[11px] text-slate-400">renovación</div>}</td>
                  <td className="p-3">{c.vehicles?.plate}<div className="text-xs text-slate-500">{c.carriers?.business_name}</div></td>
                  <td className="p-3">{money(c.rate_amount)} <span className="text-xs text-slate-500">{RATE_LABEL[c.rate_type]}</span></td>
                  <td className="p-3 text-xs">{c.included_km ? `${c.included_km} km (adicional S/ ${Number(c.excess_km_rate_exact ?? c.excess_km_rate ?? 0).toFixed(4)}/km)` : ''}{c.included_hours ? ` ${c.included_hours} h (exc. ${money(c.excess_hour_rate)}/h)` : ''}{c.discount_downtime ? <div className="text-slate-400">descuenta indisponibilidad</div> : null}{c.km_source === 'RUTA' ? <div className="text-slate-400">km por rutas del sistema</div> : null}{c.guarantee_amount ? <div className="text-slate-400">garantía {money(c.guarantee_amount)}</div> : null}</td>
                  <td className="p-3 text-xs">{c.start_date} → {c.end_date || 'indefinido'}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${c.status === 'ACTIVO' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{c.status}</span></td>
                  <td className="p-3"><div className="flex gap-1 justify-end">
                    {c.status === 'ACTIVO' && c.end_date && <button title="Renovar" onClick={() => renew(c)} className="p-1.5 border rounded-lg"><RotateCw className="w-4 h-4" /></button>}
                    {['ACTIVO', 'BORRADOR'].includes(c.status) && <button title="Editar" onClick={() => setEditing(c)} className="p-1.5 border rounded-lg"><Edit2 className="w-4 h-4" /></button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {editing && <ContractModal contract={editing === 'new' ? null : editing} vehicles={vehicles} lessors={lessors} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh() }} />}
    </div>
  )
}

function ContractModal({ contract, vehicles, lessors, onClose, onSaved }: { contract: Row | null; vehicles: Row[]; lessors: Row[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    vehicle_id: contract?.vehicle_id || '', provider_id: contract?.provider_id || '', rate_type: contract?.rate_type || 'MENSUAL', rate_amount: contract?.rate_amount ?? '',
    included_km: contract?.included_km ?? '', excess_km_rate: contract?.excess_km_rate_exact ?? contract?.excess_km_rate ?? '', guaranteed_km: contract?.guaranteed_km ?? '',
    included_hours: contract?.included_hours ?? '', excess_hour_rate: contract?.excess_hour_rate ?? '', discount_downtime: contract?.discount_downtime ?? true,
    start_date: contract?.start_date || '', end_date: contract?.end_date || '', conditions: contract?.conditions || '', penalty_terms: contract?.penalty_terms || '',
    status: contract?.status || 'ACTIVO', days_base: contract?.days_base ?? '', guarantee_amount: contract?.guarantee_amount ?? '', km_source: contract?.km_source || 'ODOMETRO',
  })
  const [saving, setSaving] = useState(false)
  const num = (v: unknown) => (v === '' || v == null ? null : Number(v))
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setSaving(true)
    const payload = { ...f, contract_type: 'ALQUILER_SECO', rate_amount: Number(f.rate_amount), included_km: num(f.included_km),
      excess_km_rate: f.excess_km_rate === '' ? null : Math.round(Number(f.excess_km_rate) * 100) / 100, excess_km_rate_exact: num(f.excess_km_rate),
      days_base: num(f.days_base), guarantee_amount: num(f.guarantee_amount),
      guaranteed_km: num(f.guaranteed_km), included_hours: num(f.included_hours), excess_hour_rate: num(f.excess_hour_rate), end_date: f.end_date || null }
    const { error } = contract ? await supabase.from('vehicle_lease_contracts').update(payload).eq('id', contract.id) : await supabase.from('vehicle_lease_contracts').insert(payload)
    setSaving(false)
    if (error) return toast.error(error.message)
    toast.success('Contrato guardado'); onSaved()
  }
  return (
    <Modal isOpen onClose={onClose} title={contract ? `Editar ${contract.contract_code}` : 'Nuevo contrato de alquiler'} maxWidth="max-w-2xl">
      <form onSubmit={save} className="grid md:grid-cols-2 gap-3 text-sm max-h-[75vh] overflow-y-auto pr-1">
        <label>Unidad<select required disabled={!!contract} className={field} value={f.vehicle_id} onChange={e => setF({ ...f, vehicle_id: e.target.value })}><option value="">Seleccionar…</option>{vehicles.map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}</select></label>
        <label>Arrendador<select required className={field} value={f.provider_id} onChange={e => setF({ ...f, provider_id: e.target.value })}><option value="">Seleccionar…</option>{lessors.map(l => <option key={l.id} value={l.id}>{l.business_name}</option>)}</select></label>
        <label>Tipo de tarifa<select className={field} value={f.rate_type} onChange={e => setF({ ...f, rate_type: e.target.value })}>{Object.entries(RATE_LABEL).map(([k, l]) => <option key={k} value={k}>{k} ({l})</option>)}</select></label>
        <label>Tarifa (S/)<input required type="number" min={0} step="0.01" className={field} value={f.rate_amount} onChange={e => setF({ ...f, rate_amount: e.target.value })} /></label>
        <label>Km incluidos<input type="number" min={0} className={field} value={f.included_km} onChange={e => setF({ ...f, included_km: e.target.value })} /></label>
        <label>Km adicional (S/, hasta 4 decimales)<input type="number" min={0} step="0.0001" className={field} value={f.excess_km_rate} onChange={e => setF({ ...f, excess_km_rate: e.target.value })} /></label>
        <label>Horas incluidas<input type="number" min={0} className={field} value={f.included_hours} onChange={e => setF({ ...f, included_hours: e.target.value })} /></label>
        <label>Exceso por hora (S/)<input type="number" min={0} step="0.01" className={field} value={f.excess_hour_rate} onChange={e => setF({ ...f, excess_hour_rate: e.target.value })} /></label>
        <label>Inicio<input required type="date" className={field} value={f.start_date} onChange={e => setF({ ...f, start_date: e.target.value })} /></label>
        <label>Término<input type="date" className={field} value={f.end_date} onChange={e => setF({ ...f, end_date: e.target.value })} /></label>
        <label>Días base del mes<input type="number" min={1} max={31} placeholder="días del mes" className={field} value={f.days_base} onChange={e => setF({ ...f, days_base: e.target.value })} /><span className="text-[11px] text-slate-400">Costo diario = tarifa mensual / días base (p. ej. 26)</span></label>
        <label>Garantía (S/)<input type="number" min={0} step="0.01" className={field} value={f.guarantee_amount} onChange={e => setF({ ...f, guarantee_amount: e.target.value })} /></label>
        <label className="md:col-span-2">Km a liquidar<select className={field} value={f.km_source} onChange={e => setF({ ...f, km_source: e.target.value })}>
          <option value="RUTA">Rutas del sistema (odómetro del checklist o GPS de la app por viaje)</option>
          <option value="ODOMETRO">Lecturas de odómetro del periodo</option>
        </select></label>
        <label className="md:col-span-2">Condiciones<textarea className={field} rows={2} value={f.conditions} onChange={e => setF({ ...f, conditions: e.target.value })} /></label>
        <label className="md:col-span-2">Penalidades pactadas<input className={field} value={f.penalty_terms} onChange={e => setF({ ...f, penalty_terms: e.target.value })} /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.discount_downtime} onChange={e => setF({ ...f, discount_downtime: e.target.checked })} />Descontar días fuera de servicio por mantenimiento</label>
        <label>Estado<select className={field} value={f.status} onChange={e => setF({ ...f, status: e.target.value })}>{['BORRADOR', 'ACTIVO', 'TERMINADO'].map(s => <option key={s}>{s}</option>)}</select></label>
        <div className="md:col-span-2 flex justify-end gap-2"><button type="button" onClick={onClose} className="px-4 py-2 border rounded-lg">Cancelar</button><button disabled={saving} className="px-4 py-2 bg-[#002855] text-white rounded-lg">Guardar</button></div>
      </form>
    </Modal>
  )
}
