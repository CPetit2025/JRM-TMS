'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Banknote, Calculator, CheckCircle2, FileCheck2, ImageIcon, Loader2, Plus, RefreshCw, Search, Send, Wrench, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'
import { CHARGE_TO, PAYMENT_METHODS, errorMessage, fmtDate, loadAdvanceReasons, money, receiptUrl, rpcOk, type AdvanceReason, type Row } from '@/lib/caja'

// Anticipos (Caja C2–C5): viáticos del viaje (presupuesto según el tarifario) o anticipos por motivo sin viaje
// (neumático, mecánica, trámites…): solicitud → aprobación del Jefe cuando el motivo lo exige → entrega desde
// una caja → rendición → liquidación (la del viaje, o la propia del anticipo sin viaje).
// Un conductor con rendiciones vencidas no recibe anticipos nuevos salvo emergencias aprobadas o autorización del Administrador.

const supabase = createClient()
const BUDGET_KEYS = [['COMBUSTIBLE', 'Combustible'], ['PEAJE', 'Peajes'], ['ALIMENTACION', 'Alimentación'], ['HOSPEDAJE', 'Hospedaje'], ['OTROS', 'Otros']] as const
const STATUS: Record<string, string> = {
  SOLICITADO: 'bg-amber-100 text-amber-800', ENTREGADO: 'bg-blue-100 text-blue-800', RENDIDO: 'bg-emerald-100 text-emerald-700', ANULADO: 'bg-slate-100 text-slate-500',
}

export default function AnticiposPage() {
  const { canWrite, role } = usePermissions()
  const canManage = canWrite('caja-anticipos')
  const canApprove = canWrite('caja-aprobacion')
  const canSettle = canWrite('caja-liquidaciones')
  const [rows, setRows] = useState<Row[]>([])
  const [reasons, setReasons] = useState<AdvanceReason[]>([])
  const [accounts, setAccounts] = useState<Record<string, Row>>({})
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('ABIERTOS')
  const [reason, setReason] = useState('')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  const [delivering, setDelivering] = useState<Row | null>(null)
  const [settling, setSettling] = useState<Row | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.from('vw_caja_advances').select('*').order('requested_at', { ascending: false }).limit(500)
    if (error) toast.error(error.message)
    setRows(data || [])
    const ids = [...new Set((data || []).map(r => r.driver_id))]
    if (ids.length) {
      const { data: acc } = await supabase.from('vw_driver_cash_account').select('driver_id, balance, overdue_trips, overdue_advances').in('driver_id', ids)
      setAccounts(Object.fromEntries((acc || []).map(a => [a.driver_id, a])))
    }
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); void loadAdvanceReasons(supabase, false).then(setReasons) }, [load])

  const overdueOf = (driverId: string) => {
    const a = accounts[driverId]
    return a ? Number(a.overdue_trips || 0) + Number(a.overdue_advances || 0) : 0
  }
  const visible = useMemo(() => rows.filter(r => {
    if (status === 'ABIERTOS' && !['SOLICITADO', 'ENTREGADO'].includes(r.status)) return false
    if (status === 'APP' && !(r.source === 'APP' && r.status === 'SOLICITADO')) return false
    if (status === 'POR_APROBAR' && !r.awaiting_approval) return false
    if (status === 'POR_LIQUIDAR' && !(r.dispatch_id === null && r.status === 'ENTREGADO')) return false
    if (!['ABIERTOS', 'APP', 'POR_APROBAR', 'POR_LIQUIDAR', 'TODOS'].includes(status) && r.status !== status) return false
    if (reason && r.reason_code !== reason) return false
    const s = q.trim().toLowerCase()
    return !s || [r.code, r.dispatch_number, r.vehicle_plate, r.driver_name, r.reason_label].some(v => String(v || '').toLowerCase().includes(s))
  }), [rows, status, reason, q])
  const appPending = rows.filter(r => r.source === 'APP' && r.status === 'SOLICITADO').length
  const toApprove = rows.filter(r => r.awaiting_approval).length
  const toSettle = rows.filter(r => r.dispatch_id === null && r.status === 'ENTREGADO').length
  const totals = useMemo(() => ({
    requested: rows.filter(r => r.status === 'SOLICITADO').reduce((s, r) => s + Number(r.amount), 0),
    delivered: rows.filter(r => r.status === 'ENTREGADO').reduce((s, r) => s + Number(r.amount), 0),
  }), [rows])

  const cancel = async (r: Row) => {
    const why = prompt(`Motivo de anulación del anticipo ${r.code}:`)
    if (!why?.trim()) return
    try { await rpcOk(supabase, 'cancel_trip_advance', { p_advance_id: r.id, p_reason: why }); toast.success('Anticipo anulado'); void load() }
    catch (e) { toast.error(errorMessage(e)) }
  }
  const review = async (r: Row, decision: 'APROBAR' | 'RECHAZAR') => {
    const comment = decision === 'RECHAZAR' ? prompt(`Motivo del rechazo de ${r.code}:`) : null
    if (decision === 'RECHAZAR' && !comment?.trim()) return
    try { await rpcOk(supabase, 'review_advance_request', { p_advance_id: r.id, p_decision: decision, p_comment: comment }); toast.success(decision === 'APROBAR' ? 'Anticipo aprobado: Caja puede entregarlo' : 'Solicitud rechazada'); void load() }
    catch (e) { toast.error(errorMessage(e)) }
  }
  const openEvidence = async (r: Row) => {
    const url = await receiptUrl(supabase, r.evidence_url)
    if (url) window.open(url, '_blank', 'noopener'); else toast.error('No se pudo abrir la evidencia')
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Banknote className="w-6 h-6" />Anticipos</h1>
          <p className="text-sm text-slate-500">Dinero entregado al conductor a rendir: viáticos del viaje o anticipos por la unidad u otro motivo (neumático, mecánica, trámites), con sus propias reglas de aprobación y rendición.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2 hover:bg-slate-50"><RefreshCw className="w-4 h-4" />Actualizar</button>
          {canManage && <button onClick={() => setCreating(true)} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4" />Nuevo anticipo</button>}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Solicitados por entregar" value={money(totals.requested)} />
        <Stat label="Entregados por rendir" value={money(totals.delivered)} />
        <Stat label="Por aprobar (Jefe)" value={String(toApprove)} tone="red" />
        <Stat label="Pedidos del app por atender" value={String(appPending)} tone="red" />
        <Stat label="Conductores con rendición vencida" value={String(Object.keys(accounts).filter(id => overdueOf(id) > 0).length)} tone="red" />
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {['ABIERTOS', 'POR_APROBAR', 'APP', 'POR_LIQUIDAR', 'SOLICITADO', 'ENTREGADO', 'RENDIDO', 'ANULADO', 'TODOS'].map(s => (
          <button key={s} onClick={() => setStatus(s)} className={`px-3 py-1.5 rounded-full text-sm border ${status === s ? 'bg-[#002855] text-white' : 'bg-white'}`}>
            {s === 'APP' ? `Pedidos del app (${appPending})` : s === 'POR_APROBAR' ? `Por aprobar (${toApprove})` : s === 'POR_LIQUIDAR' ? `Sin viaje por liquidar (${toSettle})` : s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
        <select value={reason} onChange={e => setReason(e.target.value)} className="border rounded-lg px-2 py-2 text-sm">
          <option value="">Todos los motivos</option>
          {reasons.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
        </select>
        <div className="relative ml-auto">
          <Search className="w-4 h-4 absolute left-2 top-2.5 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Código, despacho, placa, conductor o motivo" className="border rounded-lg pl-7 pr-2 py-2 text-sm w-72" />
        </div>
      </div>

      <div className="bg-white border rounded-xl overflow-auto">
        {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
          <DataTable className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500"><tr>
              <th className="p-3 text-left">Código</th><th className="p-3 text-left">Motivo</th><th className="p-3 text-left">Viaje / unidad</th><th className="p-3 text-left">Conductor</th>
              <th className="p-3 text-right">Monto</th><th className="p-3 text-left">Estado</th><th className="p-3 text-left">Entrega / rendición</th><th className="p-3" />
            </tr></thead>
            <tbody className="divide-y">
              {visible.length === 0 && <tr><td colSpan={8} className="p-10 text-center text-slate-400">Sin anticipos</td></tr>}
              {visible.map(r => {
                const overdue = overdueOf(r.driver_id)
                return (
                  <tr key={r.id} className={r.is_emergency && r.status === 'SOLICITADO' ? 'bg-red-50/40' : ''}>
                    <td className="p-3 font-semibold">
                      {r.code}
                      {r.source === 'APP' && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-violet-100 text-violet-800 text-[10px] font-bold align-middle">App conductor</span>}
                      <div className="text-xs text-slate-500 font-normal">{fmtDate(r.requested_at, true)}</div>
                      {r.reason && <div className="text-xs text-slate-700 font-normal max-w-56">“{r.reason}”</div>}
                    </td>
                    <td className="p-3 text-xs">
                      <div className="font-semibold text-slate-800">{r.reason_label}</div>
                      <div className="text-slate-500">Cargo: {CHARGE_TO[r.charge_to] || r.charge_to}</div>
                      {r.is_emergency && <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-red-100 text-red-700 text-[10px] font-bold">Emergencia</span>}
                      {r.charge_to === 'VIAJE' && Object.entries(r.breakdown || {}).filter(([, v]) => Number(v) > 0).length > 0 && (
                        <div className="text-slate-600">{Object.entries(r.breakdown || {}).filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k.charAt(0) + k.slice(1).toLowerCase()} ${money(v, 0)}`).join(' · ')}</div>
                      )}
                      {r.evidence_url && <button onClick={() => openEvidence(r)} className="mt-0.5 text-blue-700 flex items-center gap-1"><ImageIcon className="w-3 h-3" />Ver evidencia</button>}
                      {r.maintenance_request_id && <div className="text-slate-500 flex items-center gap-1"><Wrench className="w-3 h-3" />Falla reportada a Mantenimiento</div>}
                    </td>
                    <td className="p-3">{r.dispatch_id ? <>{r.dispatch_number}<div className="text-xs text-slate-500">{r.vehicle_plate} · {r.dispatch_status}</div></>
                      : <>{r.vehicle_plate || '—'}<div className="text-xs text-slate-500">Sin viaje{r.dispatch_number ? ` (en ruta ${r.dispatch_number})` : ''}</div></>}</td>
                    <td className="p-3">{r.driver_name || '—'}{overdue > 0 && <div className="text-xs text-red-700 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />{overdue} rendición(es) vencida(s)</div>}</td>
                    <td className="p-3 text-right font-bold">{money(r.amount)}</td>
                    <td className="p-3">
                      <span className={`px-2 py-0.5 rounded text-xs font-semibold ${r.awaiting_approval ? 'bg-orange-100 text-orange-800' : STATUS[r.status]}`}>{r.awaiting_approval ? 'POR APROBAR' : r.status}</span>
                      {r.approved_at && <div className="text-[11px] text-emerald-700 mt-0.5">Aprobado {fmtDate(r.approved_at, true)}</div>}
                      {r.overdue_flag && r.status === 'SOLICITADO' && <div className="text-[11px] text-red-700 mt-0.5">Con vencidos: {r.overdue_flag}</div>}
                    </td>
                    <td className="p-3 text-xs">{r.delivered_at ? <>{fmtDate(r.delivered_at, true)}<div className="text-slate-500">{r.payment_method}{r.reference ? ` · ${r.reference}` : ''}</div></> : '—'}
                      {!r.dispatch_id && r.status === 'ENTREGADO' && <div className={r.overdue ? 'text-red-700 font-semibold' : 'text-slate-500'}>Rendido {money(r.rendered)} · vence {fmtDate(r.due_at, true)}</div>}
                      {r.settlement_code && <div className="text-slate-500">Liquidación {r.settlement_code}</div>}
                      {r.override_reason && <div className="text-red-700">Autorizado: {r.override_reason}</div>}
                      {r.status === 'ANULADO' && r.cancel_reason && <div className="text-slate-500">Anulado: {r.cancel_reason}</div>}</td>
                    <td className="p-3 whitespace-nowrap text-right">
                      {canApprove && r.awaiting_approval && <>
                        <button onClick={() => review(r, 'APROBAR')} className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg mr-1 inline-flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Aprobar</button>
                        <button onClick={() => review(r, 'RECHAZAR')} className="text-xs font-semibold text-red-700 bg-red-50 px-3 py-1.5 rounded-lg mr-1">Rechazar</button>
                      </>}
                      {canManage && r.status === 'SOLICITADO' && !r.awaiting_approval && <button onClick={() => setDelivering(r)} className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-lg mr-1 inline-flex items-center gap-1"><Send className="w-3 h-3" />Entregar</button>}
                      {canSettle && !r.dispatch_id && r.status === 'ENTREGADO' && <button onClick={() => setSettling(r)} className="text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg mr-1 inline-flex items-center gap-1"><FileCheck2 className="w-3 h-3" />Liquidar</button>}
                      {canManage && (r.status === 'SOLICITADO' || (r.status === 'ENTREGADO' && role === 'admin')) && <button onClick={() => cancel(r)} title="Anular" className="p-1.5 hover:bg-slate-100 rounded"><XCircle className="w-4 h-4 text-red-600" /></button>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
      </div>

      {creating && <NewAdvance reasons={reasons} onClose={() => setCreating(false)} onDone={() => { setCreating(false); void load() }} />}
      {delivering && <Deliver advance={delivering} driverName={delivering.driver_name}
        overdue={overdueOf(delivering.driver_id) > 0 && !(delivering.is_emergency && delivering.approved_at)} isAdmin={role === 'admin'}
        onClose={() => setDelivering(null)} onDone={() => { setDelivering(null); void load() }} />}
      {settling && <SettleAdvance advance={settling} onClose={() => setSettling(null)} onDone={() => { setSettling(null); void load() }} />}
    </div>
  )
}

function NewAdvance({ reasons, onClose, onDone }: { reasons: AdvanceReason[]; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<'VIAJE' | 'MOTIVO'>('VIAJE')
  const [trips, setTrips] = useState<Row[]>([])
  const [rates, setRates] = useState<Row[]>([])
  const [tripId, setTripId] = useState('')
  const [rateId, setRateId] = useState('')
  const [calc, setCalc] = useState<Row | null>(null)
  const [breakdown, setBreakdown] = useState<Record<string, string>>({})
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('vw_caja_trips').select('id, dispatch_number, vehicle_plate, status, driver_id')
      .in('status', ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'RETORNO']).order('created_at', { ascending: false }).limit(200)
      .then(r => setTrips((r.data || []).filter(t => t.driver_id)))
    supabase.from('route_allowance_rates').select('id, name, distance_km, days, nights').eq('is_active', true).order('name').then(r => setRates(r.data || []))
  }, [])

  const trip = trips.find(t => t.id === tripId)
  const total = BUDGET_KEYS.reduce((s, [k]) => s + Number(breakdown[k] || 0), 0)

  const compute = async (rid: string) => {
    setRateId(rid)
    if (!rid) { setCalc(null); return }
    const { data } = await supabase.rpc('calculate_trip_budget', { p_rate_id: rid, p_vehicle_plate: trip?.vehicle_plate || null })
    if (!data?.success) return toast.error(data?.error || 'No se pudo calcular')
    setCalc(data)
    setBreakdown(Object.fromEntries(BUDGET_KEYS.map(([k]) => [k, String(data.breakdown[k] ?? 0)])))
    setAmount(String(data.total))
  }

  const submit = async () => {
    setBusy(true)
    try {
      const b = Object.fromEntries(BUDGET_KEYS.map(([k]) => [k, Number(breakdown[k] || 0)]))
      if (total > 0) await rpcOk(supabase, 'set_trip_budget', { p_dispatch_id: tripId, p_rate_id: rateId || null, p_breakdown: b })
      await rpcOk(supabase, 'request_trip_advance', { p_dispatch_id: tripId, p_amount: Number(amount), p_breakdown: b, p_notes: notes || null })
      toast.success('Anticipo solicitado: falta registrar la entrega')
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title="Nuevo anticipo" maxWidth="max-w-2xl">
      <div className="flex gap-2 mb-4 text-sm">
        {([['VIAJE', 'Viáticos de un viaje'], ['MOTIVO', 'Por la unidad u otro motivo (sin viaje)']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)} className={`px-3 py-1.5 rounded-full border ${mode === k ? 'bg-[#002855] text-white' : 'bg-white'}`}>{l}</button>
        ))}
      </div>
      {mode === 'MOTIVO' ? <UnitAdvanceBody reasons={reasons.filter(r => r.is_active && !r.requires_trip)} onClose={onClose} onDone={onDone} /> :
      <div className="space-y-4 text-sm">
        <label className="block"><span className="text-xs font-bold text-slate-600">Despacho (con conductor asignado)</span>
          <select value={tripId} onChange={e => { setTripId(e.target.value); setCalc(null); setRateId('') }} className="caja-input">
            <option value="">Seleccione…</option>
            {trips.map(t => <option key={t.id} value={t.id}>{t.dispatch_number} · {t.vehicle_plate} · {t.status}</option>)}
          </select>
        </label>
        <label className="block"><span className="text-xs font-bold text-slate-600 flex items-center gap-1"><Calculator className="w-3 h-3" />Tarifa de viáticos (opcional)</span>
          <select disabled={!tripId} value={rateId} onChange={e => compute(e.target.value)} className="caja-input">
            <option value="">Sin tarifa: ingresar montos</option>
            {rates.map(r => <option key={r.id} value={r.id}>{r.name} · {Number(r.distance_km)} km · {r.days} día(s) / {r.nights} noche(s)</option>)}
          </select>
        </label>
        {calc && <p className="text-xs text-slate-500">{calc.km} km · {calc.gallons} gal a {calc.km_per_gallon} km/gal · {money(calc.fuel_price)}/gal</p>}
        <div className="grid grid-cols-5 gap-2">
          {BUDGET_KEYS.map(([k, l]) => (
            <label key={k} className="block"><span className="text-[11px] font-bold text-slate-600">{l}</span>
              <input type="number" min="0" step="0.01" value={breakdown[k] || ''} onChange={e => setBreakdown(b => ({ ...b, [k]: e.target.value }))} className="caja-input" />
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <label className="block"><span className="text-xs font-bold text-slate-600">Monto del anticipo (S/)</span>
            <input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="caja-input text-lg font-bold" />
          </label>
          <div className="text-xs text-slate-500">Presupuesto del viaje: <b>{money(total)}</b>. El anticipo puede ser menor si parte se paga con crédito (p. ej. combustible en grifo).</div>
        </div>
        <label className="block"><span className="text-xs font-bold text-slate-600">Notas</span><input value={notes} onChange={e => setNotes(e.target.value)} className="caja-input" /></label>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
          <button disabled={busy || !tripId || !(Number(amount) > 0)} onClick={submit} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}Solicitar anticipo
          </button>
        </div>
      </div>}
    </Modal>
  )
}

function UnitAdvanceBody({ reasons, onClose, onDone }: { reasons: AdvanceReason[]; onClose: () => void; onDone: () => void }) {
  const [drivers, setDrivers] = useState<Row[]>([])
  const [units, setUnits] = useState<Row[]>([])
  const [form, setForm] = useState({ driver_id: '', reason_code: '', plate: '', amount: '', reason: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    supabase.from('vw_caja_people').select('id, full_name').eq('kind', 'CONDUCTOR').order('full_name').then(r => setDrivers(r.data || []))
    supabase.from('vw_caja_units').select('plate').order('plate').then(r => setUnits(r.data || []))
  }, [])
  const r = reasons.find(x => x.code === form.reason_code)
  const submit = async () => {
    setBusy(true)
    try {
      const res = await rpcOk<Row>(supabase, 'request_unit_advance', { p_driver_id: form.driver_id, p_reason_code: form.reason_code,
        p_amount: Number(form.amount), p_reason: form.reason, p_vehicle_plate: r?.charge_to === 'UNIDAD' ? form.plate : null })
      toast.success(`Anticipo ${res.code} registrado${r?.approval_by === 'JEFE' ? ': falta la aprobación del Jefe' : ''}`)
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <label className="block"><span className="text-xs font-bold text-slate-600">Conductor</span>
          <select value={form.driver_id} onChange={e => setForm({ ...form, driver_id: e.target.value })} className="caja-input">
            <option value="">Seleccione…</option>{drivers.map(d => <option key={d.id} value={d.id}>{d.full_name}</option>)}
          </select></label>
        <label className="block"><span className="text-xs font-bold text-slate-600">Motivo</span>
          <select value={form.reason_code} onChange={e => setForm({ ...form, reason_code: e.target.value })} className="caja-input">
            <option value="">Seleccione…</option>{reasons.map(x => <option key={x.code} value={x.code}>{x.label}</option>)}
          </select></label>
      </div>
      {r && <p className="text-xs text-slate-500">Cargo: {CHARGE_TO[r.charge_to]} · {r.approval_by === 'JEFE' ? 'aprueba el Jefe de Distribución' : 'lo atiende Caja'}
        {r.max_amount ? ` · hasta ${money(r.max_amount)} sin aprobación extra` : ''}{r.settlement_due_hours ? ` · rendir en ${r.settlement_due_hours} h` : ''}</p>}
      <div className="grid grid-cols-2 gap-3">
        {r?.charge_to === 'UNIDAD' && <label className="block"><span className="text-xs font-bold text-slate-600">Unidad</span>
          <select value={form.plate} onChange={e => setForm({ ...form, plate: e.target.value })} className="caja-input">
            <option value="">Seleccione…</option>{units.map(u => <option key={u.plate} value={u.plate}>{u.plate}</option>)}
          </select></label>}
        <label className="block"><span className="text-xs font-bold text-slate-600">Monto (S/)</span>
          <input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="caja-input font-bold" /></label>
      </div>
      <label className="block"><span className="text-xs font-bold text-slate-600">Para qué es</span>
        <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} className="caja-input" /></label>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
        <button disabled={busy || !form.driver_id || !r || !(Number(form.amount) > 0) || !form.reason.trim() || (r.charge_to === 'UNIDAD' && !form.plate)} onClick={submit}
          className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Registrar anticipo</button>
      </div>
    </div>
  )
}

function SettleAdvance({ advance, onClose, onDone }: { advance: Row; onClose: () => void; onDone: () => void }) {
  const [preview, setPreview] = useState<Row | null>(null)
  const [boxes, setBoxes] = useState<Row[]>([])
  const [form, setForm] = useState({ resolution: '', box_id: '', method: 'EFECTIVO', reference: '', notes: '' })
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    supabase.rpc('preview_advance_settlement', { p_advance_id: advance.id }).then(({ data }) => {
      setPreview(data || null)
      if (data?.suggested_resolution) setForm(f => ({ ...f, resolution: data.suggested_resolution }))
    })
    supabase.from('vw_cash_box_balances').select('box_id, name, box_type, balance').eq('is_active', true).order('name').then(r => setBoxes(r.data || []))
  }, [advance.id])
  const bal = Number(preview?.balance || 0)
  const needsBox = ['DEVOLUCION', 'REEMBOLSO'].includes(form.resolution)
  const blocking: string[] = preview?.blocking || []
  const submit = async () => {
    setBusy(true)
    try {
      await rpcOk(supabase, 'close_advance_settlement', { p_advance_id: advance.id, p_resolution: form.resolution, p_box_id: needsBox ? form.box_id : null,
        p_payment_method: needsBox ? form.method : null, p_reference: form.reference || null, p_notes: form.notes || null })
      toast.success('Anticipo liquidado')
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title={`Liquidar ${advance.code} · ${advance.reason_label}`}>
      {!preview ? <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div> : (
        <div className="space-y-3 text-sm">
          <p>{advance.driver_name || '—'}{advance.vehicle_plate ? ` · ${advance.vehicle_plate}` : ''}</p>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="bg-slate-50 rounded-lg p-2"><div className="text-xs text-slate-500">Entregado</div><div className="font-bold">{money(preview.advances_total)}</div></div>
            <div className="bg-slate-50 rounded-lg p-2"><div className="text-xs text-slate-500">Gastos aprobados</div><div className="font-bold">{money(preview.driver_expenses)}</div></div>
            <div className="bg-slate-50 rounded-lg p-2"><div className="text-xs text-slate-500">{bal > 0 ? 'Debe devolver' : bal < 0 ? 'Se le reembolsa' : 'Saldo'}</div><div className={`font-bold ${bal > 0 ? 'text-red-700' : bal < 0 ? 'text-blue-700' : ''}`}>{money(Math.abs(bal))}</div></div>
          </div>
          {blocking.length > 0 && <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg p-3 text-xs">{blocking.map(b => <div key={b}>• {b}</div>)}</div>}
          {bal !== 0 && (
            <label className="block"><span className="text-xs font-bold text-slate-600">Resolución</span>
              <select value={form.resolution} onChange={e => setForm({ ...form, resolution: e.target.value })} className="caja-input">
                {bal > 0 ? <><option value="DEVOLUCION">Devolución a caja</option><option value="DESCUENTO_PLANILLA">Descuento por planilla</option></> : <option value="REEMBOLSO">Reembolso al conductor</option>}
              </select></label>
          )}
          {needsBox && <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="text-xs font-bold text-slate-600">Caja</span>
              <select value={form.box_id} onChange={e => setForm({ ...form, box_id: e.target.value })} className="caja-input">
                <option value="">Seleccione…</option>{boxes.map(b => <option key={b.box_id} value={b.box_id}>{b.name} · saldo {money(b.balance)}</option>)}
              </select></label>
            <label className="block"><span className="text-xs font-bold text-slate-600">Forma de pago</span>
              <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="caja-input">
                {PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select></label>
          </div>}
          <label className="block"><span className="text-xs font-bold text-slate-600">{form.resolution === 'DESCUENTO_PLANILLA' ? 'Autorización del descuento' : 'Notas'}</span>
            <input value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} className="caja-input" /></label>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
            <button disabled={busy || blocking.length > 0 || (needsBox && !form.box_id) || (form.resolution === 'DESCUENTO_PLANILLA' && !form.notes.trim())} onClick={submit}
              className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Cerrar liquidación</button>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Deliver({ advance, driverName, overdue, isAdmin, onClose, onDone }: {
  advance: Row; driverName?: string; overdue: boolean; isAdmin: boolean; onClose: () => void; onDone: () => void
}) {
  const [boxes, setBoxes] = useState<Row[]>([])
  const [form, setForm] = useState({ box_id: '', method: 'EFECTIVO', reference: '', override: '' })
  const [busy, setBusy] = useState(false)
  const [trip, setTrip] = useState<Row | null>(null)
  useEffect(() => {
    supabase.from('vw_cash_box_balances').select('box_id, name, box_type, balance, allow_negative').eq('is_active', true).order('name').then(r => setBoxes(r.data || []))
    if (!advance.dispatch_id) return
    Promise.all([
      supabase.from('trip_budgets').select('total').eq('dispatch_id', advance.dispatch_id).maybeSingle(),
      supabase.from('trip_advances').select('amount, status').eq('dispatch_id', advance.dispatch_id),
    ]).then(([b, a]) => setTrip({
      budget: b.data?.total ?? null,
      delivered: (a.data || []).filter(x => ['ENTREGADO', 'RENDIDO'].includes(x.status)).reduce((s, x) => s + Number(x.amount), 0),
    }))
  }, [advance.dispatch_id])
  const box = boxes.find(b => b.box_id === form.box_id)
  const short = box && !box.allow_negative && Number(box.balance) < Number(advance.amount)

  const submit = async () => {
    setBusy(true)
    try {
      await rpcOk(supabase, 'deliver_trip_advance', { p_advance_id: advance.id, p_box_id: form.box_id, p_payment_method: form.method,
        p_reference: form.reference || null, p_override_reason: form.override || null })
      toast.success('Anticipo entregado y registrado en caja')
      onDone()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Entregar ${advance.code} · ${money(advance.amount)}`}>
      <div className="space-y-3 text-sm">
        <p>Conductor: <b>{driverName || '—'}</b> · {advance.dispatch_id ? `Despacho ${advance.dispatch_number}` : `${advance.reason_label}${advance.vehicle_plate ? ` · ${advance.vehicle_plate}` : ''}`}</p>
        {advance.approved_at && <p className="text-xs text-emerald-700">Aprobado por el Jefe el {fmtDate(advance.approved_at, true)}{advance.approval_comment ? ` · “${advance.approval_comment}”` : ''}</p>}
        {advance.source === 'APP' && (
          <div className="bg-violet-50 border border-violet-200 rounded-lg p-3 text-xs space-y-1">
            <div className="font-semibold text-violet-900">Solicitado por el conductor desde la app</div>
            {advance.reason && <div>“{advance.reason}”</div>}
            {Object.keys(advance.breakdown || {}).length > 0 && (
              <div className="text-slate-600">{Object.entries(advance.breakdown).map(([k, v]) => `${k.charAt(0) + k.slice(1).toLowerCase()} ${money(v)}`).join(' · ')}</div>
            )}
          </div>
        )}
        {trip && (
          <p className="text-xs text-slate-600">
            Ya entregado en este viaje: <b>{money(trip.delivered)}</b>
            {trip.budget != null && <> · Presupuesto del viaje: <b>{money(trip.budget)}</b>
              {trip.delivered + Number(advance.amount) > Number(trip.budget) && <span className="text-red-700"> (con este anticipo lo supera)</span>}</>}
          </p>
        )}
        {overdue && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded-lg p-3 text-xs flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0" />
            El conductor tiene rendiciones vencidas. {isAdmin ? 'Como Administrador puede autorizar la entrega indicando el motivo.' : 'Solo el Administrador puede autorizar la entrega.'}</div>
        )}
        <label className="block"><span className="text-xs font-bold text-slate-600">Caja de salida</span>
          <select value={form.box_id} onChange={e => setForm({ ...form, box_id: e.target.value })} className="caja-input">
            <option value="">Seleccione…</option>{boxes.map(b => <option key={b.box_id} value={b.box_id}>{b.name} ({b.box_type}) · saldo {money(b.balance)}</option>)}
          </select>
        </label>
        {short && <p className="text-xs text-red-700">Saldo insuficiente en esta caja.</p>}
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-xs font-bold text-slate-600">Forma de entrega</span>
            <select value={form.method} onChange={e => setForm({ ...form, method: e.target.value })} className="caja-input">
              {PAYMENT_METHODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label className="block"><span className="text-xs font-bold text-slate-600">Referencia</span>
            <input value={form.reference} onChange={e => setForm({ ...form, reference: e.target.value })} placeholder="N° operación / recibo" className="caja-input" />
          </label>
        </div>
        {overdue && isAdmin && <label className="block"><span className="text-xs font-bold text-slate-600">Motivo de la autorización</span>
          <input value={form.override} onChange={e => setForm({ ...form, override: e.target.value })} className="caja-input" /></label>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-lg hover:bg-slate-100">Cancelar</button>
          <button disabled={busy || !form.box_id || !!short || (overdue && (!isAdmin || !form.override.trim()))} onClick={submit}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg font-semibold disabled:opacity-50 flex items-center gap-2">{busy && <Loader2 className="w-4 h-4 animate-spin" />}Registrar entrega</button>
        </div>
      </div>
    </Modal>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'red' }) {
  return <div className="bg-white border rounded-xl p-4"><div className="text-xs text-slate-500">{label}</div><div className={`text-2xl font-bold ${tone === 'red' && value !== '0' ? 'text-red-600' : 'text-slate-900'}`}>{value}</div></div>
}
