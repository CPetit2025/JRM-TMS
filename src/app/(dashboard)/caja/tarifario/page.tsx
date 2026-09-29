'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Calculator, Loader2, Pencil, Plus, Save, Settings2, Tags } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'
import { CHARGE_TO, errorMessage, loadAdvanceReasons, money, rpcOk, type AdvanceReason, type Row } from '@/lib/caja'

// Tarifario y reglas (Caja C3/C5): viáticos por ruta (presupuesto del viaje), motivos de anticipo (quién aprueba,
// tope, evidencia y plazo de rendición), categorías de gasto (tope, comprobante, cuenta contable) y parámetros de caja.

const supabase = createClient()
const LEDGER: Record<string, string> = { OPERACION: 'Operación', COMBUSTIBLE: 'Combustible', MANTENIMIENTO: 'Mantenimiento', NEUMATICOS: 'Neumáticos' }
const BUDGET: Record<string, string> = { COMBUSTIBLE: 'Combustible', PEAJE: 'Peajes', ALIMENTACION: 'Alimentación', HOSPEDAJE: 'Hospedaje', OTROS: 'Otros' }

export default function TarifarioPage() {
  const { canWrite, role } = usePermissions()
  const canEdit = canWrite('caja-tarifario')
  const isAdmin = role === 'admin'
  const [tab, setTab] = useState<'tarifas' | 'motivos' | 'categorias' | 'parametros'>('tarifas')
  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Calculator className="w-6 h-6" />Tarifario y reglas de caja</h1>
        <p className="text-sm text-slate-500">Viáticos por ruta para presupuestar anticipos, topes por categoría y parámetros de control. {!canEdit && 'Solo lectura: requiere el permiso Tarifario de caja.'}</p>
      </div>
      <div className="flex bg-white border rounded-xl overflow-hidden text-sm font-semibold w-fit">
        {([['tarifas', 'Tarifas por ruta'], ['motivos', 'Motivos de anticipo'], ['categorias', 'Categorías de gasto'], ['parametros', 'Parámetros']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2.5 ${tab === k ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{l}</button>
        ))}
      </div>
      {tab === 'tarifas' && <Rates canEdit={canEdit} />}
      {tab === 'motivos' && <Reasons canEdit={canEdit} />}
      {tab === 'categorias' && <Categories canEdit={canEdit} />}
      {tab === 'parametros' && <Params isAdmin={isAdmin} />}
    </div>
  )
}

const EMPTY_RATE = { code: '', name: '', origin: '', destination: '', distance_km: '', round_trip: true, days: '1', nights: '0', toll_amount: '0', toll_by_type: '', meal_per_day: '0', lodging_per_night: '0', other_amount: '0', fuel_price_per_gallon: '', is_active: true, notes: '' }

function Rates({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState<Row | null>(null)
  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('route_allowance_rates').select('*').order('is_active', { ascending: false }).order('name')
    setRows(data || []); setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  return (
    <div className="space-y-3">
      {canEdit && <button onClick={() => setEdit({ ...EMPTY_RATE })} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4" />Nueva tarifa</button>}
      <div className="bg-white border rounded-xl overflow-auto">
        {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="p-3 text-left">Ruta</th><th className="p-3 text-right">Km (ida)</th><th className="p-3 text-left">Duración</th><th className="p-3 text-right">Peajes</th>
              <th className="p-3 text-right">Alimentación/día</th><th className="p-3 text-right">Hospedaje/noche</th><th className="p-3 text-right">Otros</th><th className="p-3 text-left">Estado</th><th className="p-3" />
            </tr></thead>
            <tbody className="divide-y">
              {rows.length === 0 && <tr><td colSpan={9} className="p-8 text-center text-slate-400">Sin tarifas. Cree las rutas frecuentes para presupuestar anticipos.</td></tr>}
              {rows.map(r => (
                <tr key={r.id} className={!r.is_active ? 'opacity-50' : ''}>
                  <td className="p-3 font-semibold">{r.name}<div className="text-xs text-slate-500 font-normal">{r.code}{r.origin && ` · ${r.origin} → ${r.destination || ''}`}</div></td>
                  <td className="p-3 text-right">{Number(r.distance_km)}{r.round_trip && <div className="text-[10px] text-slate-500">ida y vuelta</div>}</td>
                  <td className="p-3">{r.days} día(s) / {r.nights} noche(s)</td>
                  <td className="p-3 text-right">{money(r.toll_amount)}{Object.keys(r.toll_by_type || {}).length > 0 && <div className="text-[10px] text-slate-500">{Object.entries(r.toll_by_type).map(([k, v]) => `${k} ${v}`).join(' · ')}</div>}</td>
                  <td className="p-3 text-right">{money(r.meal_per_day)}</td>
                  <td className="p-3 text-right">{money(r.lodging_per_night)}</td>
                  <td className="p-3 text-right">{money(r.other_amount)}</td>
                  <td className="p-3 text-xs">{r.is_active ? 'Activa' : 'Inactiva'}</td>
                  <td className="p-3">{canEdit && <button onClick={() => setEdit({ ...r, toll_by_type: Object.keys(r.toll_by_type || {}).length ? JSON.stringify(r.toll_by_type) : '' })}><Pencil className="w-4 h-4 text-blue-600" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <RateForm rate={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void load() }} />}
    </div>
  )
}

function RateForm({ rate, onClose, onDone }: { rate: Row; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState<Row>(Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, v === null ? '' : typeof v === 'number' ? String(v) : v])))
  const [busy, setBusy] = useState(false)
  const set = (patch: Row) => setF(x => ({ ...x, ...patch }))
  const save = async () => {
    let tolls: Row = {}
    try { tolls = f.toll_by_type ? JSON.parse(f.toll_by_type) : {} } catch { return toast.error('Peajes por tipo: use el formato {"TRACTO": 420, "CAMION": 250}') }
    setBusy(true)
    const payload = {
      code: String(f.code).trim().toUpperCase(), name: String(f.name).trim(), origin: f.origin || null, destination: f.destination || null,
      distance_km: Number(f.distance_km), round_trip: !!f.round_trip, days: Number(f.days), nights: Number(f.nights),
      toll_amount: Number(f.toll_amount || 0), toll_by_type: tolls, meal_per_day: Number(f.meal_per_day || 0), lodging_per_night: Number(f.lodging_per_night || 0),
      other_amount: Number(f.other_amount || 0), fuel_price_per_gallon: f.fuel_price_per_gallon ? Number(f.fuel_price_per_gallon) : null,
      is_active: !!f.is_active, notes: f.notes || null, updated_at: new Date().toISOString(),
    }
    const { error } = rate.id ? await supabase.from('route_allowance_rates').update(payload).eq('id', rate.id) : await supabase.from('route_allowance_rates').insert([payload])
    setBusy(false)
    if (error) return toast.error(error.message)
    toast.success('Tarifa guardada')
    onDone()
  }
  const num = (k: string, l: string) => (
    <label className="block"><span className="text-xs font-bold text-slate-600">{l}</span><input type="number" min="0" step="0.01" value={f[k]} onChange={e => set({ [k]: e.target.value })} className="caja-input" /></label>
  )
  return (
    <Modal isOpen onClose={onClose} title={rate.id ? `Editar tarifa ${rate.code}` : 'Nueva tarifa de ruta'} maxWidth="max-w-2xl">
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-3">
          <label className="block"><span className="text-xs font-bold text-slate-600">Código</span><input value={f.code} onChange={e => set({ code: e.target.value })} className="caja-input uppercase" placeholder="LIM-ARQ" /></label>
          <label className="block col-span-2"><span className="text-xs font-bold text-slate-600">Nombre</span><input value={f.name} onChange={e => set({ name: e.target.value })} className="caja-input" placeholder="Lima – Arequipa" /></label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Origen</span><input value={f.origin} onChange={e => set({ origin: e.target.value })} className="caja-input" /></label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Destino</span><input value={f.destination} onChange={e => set({ destination: e.target.value })} className="caja-input" /></label>
          {num('distance_km', 'Km (solo ida)')}
        </div>
        <div className="grid grid-cols-4 gap-3 items-end">
          <label className="flex items-center gap-2 pb-2"><input type="checkbox" checked={!!f.round_trip} onChange={e => set({ round_trip: e.target.checked })} />Ida y vuelta</label>
          {num('days', 'Días')}{num('nights', 'Noches')}{num('fuel_price_per_gallon', 'Precio gal. (opcional)')}
          {num('toll_amount', 'Peajes (total)')}{num('meal_per_day', 'Alimentación / día')}{num('lodging_per_night', 'Hospedaje / noche')}{num('other_amount', 'Otros')}
        </div>
        <label className="block"><span className="text-xs font-bold text-slate-600">Peajes por tipo de unidad (según ejes, opcional)</span>
          <input value={f.toll_by_type} onChange={e => set({ toll_by_type: e.target.value })} className="caja-input font-mono text-xs" placeholder='{"TRACTO": 420, "CAMION": 250}' /></label>
        <label className="block"><span className="text-xs font-bold text-slate-600">Notas</span><input value={f.notes} onChange={e => set({ notes: e.target.value })} className="caja-input" /></label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!f.is_active} onChange={e => set({ is_active: e.target.checked })} />Activa</label>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
          <button disabled={busy || !f.code || !f.name || !(Number(f.distance_km) > 0)} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2"><Save className="w-4 h-4" />Guardar</button>
        </div>
      </div>
    </Modal>
  )
}

function Categories({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [dirty, setDirty] = useState<Record<string, Row>>({})
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const { data } = await supabase.from('expense_categories').select('*').order('sort_order')
    setRows(data || []); setDirty({})
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const change = (code: string, patch: Row) => {
    setRows(rs => rs.map(r => r.code === code ? { ...r, ...patch } : r))
    setDirty(d => ({ ...d, [code]: { ...d[code], ...patch } }))
  }
  const save = async () => {
    setBusy(true)
    for (const [code, patch] of Object.entries(dirty)) {
      const p = { ...patch }
      if ('max_amount' in p) p.max_amount = p.max_amount === '' || p.max_amount === null ? null : Number(p.max_amount)
      const { error } = await supabase.from('expense_categories').update(p).eq('code', code)
      if (error) { toast.error(`${code}: ${error.message}`); setBusy(false); return }
    }
    setBusy(false)
    toast.success('Categorías actualizadas')
    void load()
  }
  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr>
            <th className="p-3 text-left">Categoría</th><th className="p-3 text-left">Costo en TCO</th><th className="p-3 text-left">Presupuesto</th>
            <th className="p-3 text-center">Comprobante obligatorio</th><th className="p-3 text-right">Tope por gasto (S/)</th><th className="p-3 text-left">Cuenta contable</th><th className="p-3 text-center">Activa</th>
          </tr></thead>
          <tbody className="divide-y">
            {rows.map(r => (
              <tr key={r.code}>
                <td className="p-3 font-semibold">{r.label}<div className="text-xs text-slate-500 font-normal">{r.code} · {r.group_label}</div></td>
                <td className="p-3">{LEDGER[r.ledger_category]}</td>
                <td className="p-3">{BUDGET[r.budget_key] || r.budget_key}</td>
                <td className="p-3 text-center"><input type="checkbox" disabled={!canEdit} checked={!!r.requires_receipt} onChange={e => change(r.code, { requires_receipt: e.target.checked })} /></td>
                <td className="p-3 text-right"><input type="number" min="0" disabled={!canEdit} value={r.max_amount ?? ''} onChange={e => change(r.code, { max_amount: e.target.value })} className="border rounded px-2 py-1 w-28 text-right" placeholder="Sin tope" /></td>
                <td className="p-3"><input disabled={!canEdit} value={r.account_code || ''} onChange={e => change(r.code, { account_code: e.target.value })} className="border rounded px-2 py-1 w-24" /></td>
                <td className="p-3 text-center"><input type="checkbox" disabled={!canEdit} checked={!!r.is_active} onChange={e => change(r.code, { is_active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && Object.keys(dirty).length > 0 && (
        <button disabled={busy} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50"><Save className="w-4 h-4" />Guardar cambios ({Object.keys(dirty).length})</button>
      )}
      <p className="text-xs text-slate-500 flex items-center gap-1"><Tags className="w-3 h-3" />Las cuentas sugeridas siguen el PCGE; ajústelas a su plan contable antes de exportar.</p>
    </div>
  )
}

function Params({ isAdmin }: { isAdmin: boolean }) {
  const [f, setF] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    supabase.from('caja_settings').select('*').maybeSingle().then(r => setF(r.data ? Object.fromEntries(Object.entries(r.data).map(([k, v]) => [k, v ?? ''])) : {}))
  }, [])
  if (!f) return <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div>
  const save = async () => {
    setBusy(true)
    try {
      await rpcOk(supabase, 'update_caja_settings', {
        p_double_approval_threshold: f.double_approval_threshold === '' ? null : Number(f.double_approval_threshold),
        p_settlement_due_hours: Number(f.settlement_due_hours), p_default_km_per_gallon: Number(f.default_km_per_gallon),
        p_fuel_efficiency_tolerance_pct: Number(f.fuel_efficiency_tolerance_pct), p_fuel_price_per_gallon: Number(f.fuel_price_per_gallon),
        p_budget_tolerance_pct: Number(f.budget_tolerance_pct),
      })
      toast.success('Parámetros guardados')
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const field = (k: string, l: string, hint: string) => (
    <label className="block"><span className="text-xs font-bold text-slate-600">{l}</span>
      <input type="number" min="0" step="0.01" disabled={!isAdmin} value={f[k]} onChange={e => setF({ ...f, [k]: e.target.value })} className="caja-input" />
      <span className="text-[11px] text-slate-500">{hint}</span></label>
  )
  return (
    <div className="bg-white border rounded-xl p-5 space-y-4 max-w-3xl">
      <div className="flex items-center gap-2 font-semibold text-slate-800"><Settings2 className="w-4 h-4" />Parámetros de control {!isAdmin && <span className="text-xs text-slate-500 font-normal">(solo el Administrador los modifica)</span>}</div>
      <div className="grid md:grid-cols-2 gap-4">
        {field('double_approval_threshold', 'Doble aprobación desde (S/)', 'Vacío = desactivada. Desde este monto aprueba el Jefe y confirma el Administrador.')}
        {field('settlement_due_hours', 'Plazo para rendir el viaje (horas)', 'Vencido, el conductor no recibe anticipos nuevos.')}
        {field('fuel_price_per_gallon', 'Precio de referencia del galón (S/)', 'Para presupuestar combustible si la tarifa no indica precio.')}
        {field('default_km_per_gallon', 'Rendimiento por defecto (km/gal)', 'Si la unidad no tiene rendimiento esperado configurado.')}
        {field('fuel_efficiency_tolerance_pct', 'Tolerancia de rendimiento (%)', 'Fuera de este rango la carga se marca como rendimiento anormal.')}
        {field('budget_tolerance_pct', 'Tolerancia sobre presupuesto (%)', 'Margen antes de marcar un gasto como sobre presupuesto.')}
      </div>
      {isAdmin && <button disabled={busy} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold flex items-center gap-2 disabled:opacity-50"><Save className="w-4 h-4" />Guardar parámetros</button>}
    </div>
  )
}

// Motivos de anticipo: reglas por evento (viáticos, neumático, mecánica, trámites, otros)
function Reasons({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<AdvanceReason[]>([])
  const [loading, setLoading] = useState(true)
  const [edit, setEdit] = useState<AdvanceReason | null>(null)
  const load = useCallback(async () => { setLoading(true); setRows(await loadAdvanceReasons(supabase, false)); setLoading(false) }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Cada motivo define si exige ruta, a qué se carga el costo, quién aprueba y en cuánto tiempo se rinde. Los montos mayores al tope pasan a aprobación del Jefe de Distribución.</p>
      <div className="bg-white border rounded-xl overflow-auto">
        {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div> : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="p-3 text-left">Motivo</th><th className="p-3 text-left">Requiere ruta</th><th className="p-3 text-left">Cargo</th><th className="p-3 text-left">Aprueba</th>
              <th className="p-3 text-right">Tope</th><th className="p-3 text-left">Rendir en</th><th className="p-3 text-left">Evidencia</th><th className="p-3 text-left">Emergencia</th><th className="p-3 text-left">Estado</th><th className="p-3" />
            </tr></thead>
            <tbody className="divide-y">
              {rows.map(r => (
                <tr key={r.code} className={r.is_active ? '' : 'opacity-50'}>
                  <td className="p-3"><div className="font-semibold">{r.label}</div><div className="text-xs text-slate-500">{r.description}</div></td>
                  <td className="p-3">{r.requires_trip ? 'Sí' : 'No'}</td>
                  <td className="p-3">{CHARGE_TO[r.charge_to]}</td>
                  <td className="p-3">{r.approval_by === 'JEFE' ? 'Jefe de Distribución' : 'Caja'}</td>
                  <td className="p-3 text-right">{r.max_amount ? money(r.max_amount, 0) : '—'}</td>
                  <td className="p-3">{r.settlement_due_hours ? `${r.settlement_due_hours} h` : 'Con el viaje'}</td>
                  <td className="p-3">{r.evidence_required ? 'Obligatoria' : 'Opcional'}</td>
                  <td className="p-3">{r.is_emergency ? 'Sí' : 'No'}</td>
                  <td className="p-3">{r.is_active ? 'Activo' : 'Inactivo'}</td>
                  <td className="p-3 text-right">{canEdit && <button onClick={() => setEdit({ ...r })} className="p-1.5 hover:bg-slate-100 rounded"><Pencil className="w-4 h-4" /></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <ReasonForm reason={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); void load() }} />}
    </div>
  )
}

function ReasonForm({ reason, onClose, onDone }: { reason: AdvanceReason; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ label: reason.label, description: reason.description || '', approval_by: reason.approval_by,
    max_amount: reason.max_amount == null ? '' : String(reason.max_amount), settlement_due_hours: reason.settlement_due_hours == null ? '' : String(reason.settlement_due_hours),
    evidence_required: reason.evidence_required, is_emergency: reason.is_emergency, is_active: reason.is_active })
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const { error } = await supabase.from('advance_reasons').update({
        label: f.label.trim(), description: f.description.trim() || null, approval_by: f.approval_by,
        max_amount: f.max_amount === '' ? null : Number(f.max_amount),
        settlement_due_hours: reason.requires_trip || f.settlement_due_hours === '' ? null : Number(f.settlement_due_hours),
        evidence_required: f.evidence_required, is_emergency: f.is_emergency, is_active: f.is_active,
      }).eq('code', reason.code)
      if (error) throw error
      toast.success('Motivo actualizado'); onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Motivo: ${reason.label}`}>
      <div className="space-y-3 text-sm">
        <label className="block"><span className="text-xs font-bold text-slate-600">Nombre</span><input value={f.label} onChange={e => setF({ ...f, label: e.target.value })} className="caja-input" /></label>
        <label className="block"><span className="text-xs font-bold text-slate-600">Descripción</span><input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} className="caja-input" /></label>
        <div className="grid grid-cols-3 gap-3">
          <label className="block"><span className="text-xs font-bold text-slate-600">Aprueba</span>
            <select value={f.approval_by} onChange={e => setF({ ...f, approval_by: e.target.value as 'CAJA' | 'JEFE' })} className="caja-input">
              <option value="CAJA">Caja</option><option value="JEFE">Jefe de Distribución</option></select></label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Tope sin aprobación (S/)</span>
            <input type="number" min="0" value={f.max_amount} onChange={e => setF({ ...f, max_amount: e.target.value })} placeholder="Sin tope" className="caja-input" /></label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Rendir en (horas)</span>
            <input type="number" min="1" disabled={reason.requires_trip} value={f.settlement_due_hours} onChange={e => setF({ ...f, settlement_due_hours: e.target.value })}
              placeholder={reason.requires_trip ? 'Con el viaje' : 'Por defecto'} className="caja-input" /></label>
        </div>
        <div className="flex flex-wrap gap-4">
          {([['evidence_required', 'Evidencia obligatoria'], ['is_emergency', 'Emergencia (pasa con rendiciones vencidas)'], ['is_active', 'Activo']] as const).map(([k, l]) => (
            <label key={k} className="flex items-center gap-2"><input type="checkbox" checked={f[k]} onChange={e => setF({ ...f, [k]: e.target.checked })} />{l}</label>
          ))}
        </div>
        <p className="text-xs text-slate-500">Cargo del costo: {CHARGE_TO[reason.charge_to]}{reason.creates_failure ? ' · reporta la falla a Mantenimiento' : ''} (fijos por motivo).</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
          <button disabled={busy || !f.label.trim()} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Guardar</button>
        </div>
      </div>
    </Modal>
  )
}
