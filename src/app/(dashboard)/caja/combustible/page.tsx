'use client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, Download, Gauge, Loader2, Pencil, Plus, Receipt, Store } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { Modal } from '@/components/ui/modal'
import { EXPENSE_STATUS, daysAgo, errorMessage, exportXlsx, fmtDate, money, rpcOk, todayLima, type Row } from '@/lib/caja'
import { evidenceLink } from '@/components/evidence/EvidenceGallery'

// Control de combustible (Caja C3): cargas de la app y de Caja web (con o sin viaje), rendimiento por carga
// y por unidad, grifos con crédito y conciliación de sus facturas contra las cargas registradas.

const supabase = createClient()

export default function CombustiblePage() {
  const { canWrite } = usePermissions()
  const canManage = canWrite('caja-combustible')
  const [tab, setTab] = useState<'cargas' | 'rendimiento' | 'grifos' | 'facturas'>('cargas')
  return (
    <div className="space-y-3">
      <PageHeader showTitle title="Control de combustible" description={<>Cargas, rendimiento km/galón, grifos y conciliación de facturas de crédito. Para registrar una carga use <Link href="/caja/gastos" className="text-blue-600 hover:underline">Registro de gastos</Link> (categoría Combustible) o la app del conductor.</>} />
      <div className="flex bg-white border rounded-xl overflow-hidden text-sm font-semibold w-fit">
        {([['cargas', 'Cargas'], ['rendimiento', 'Rendimiento por unidad'], ['grifos', 'Grifos'], ['facturas', 'Facturas y conciliación']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`px-4 py-2.5 ${tab === k ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{l}</button>
        ))}
      </div>
      {tab === 'cargas' && <Loads />}
      {tab === 'rendimiento' && <Efficiency canManage={canManage} />}
      {tab === 'grifos' && <Stations canManage={canManage} />}
      {tab === 'facturas' && <Invoices canManage={canManage} />}
    </div>
  )
}

function Loads() {
  const [rows, setRows] = useState<Row[]>([])
  const [eff, setEff] = useState<Record<string, Row>>({})
  const [loading, setLoading] = useState(true)
  const [f, setF] = useState(() => ({ from: daysAgo(30), to: todayLima(), plate: '', onlyAlerts: false }))
  const load = useCallback(async () => {
    setLoading(true)
    let q = supabase.from('dispatch_expenses').select('*, dispatch:dispatches(dispatch_number), station:fuel_stations(name)')
      .eq('expense_type', 'COMBUSTIBLE').gte('expense_date', f.from).lte('expense_date', f.to).order('expense_date', { ascending: false }).limit(1000)
    if (f.plate) q = q.ilike('vehicle_plate', `%${f.plate}%`)
    const { data, error } = await q
    if (error) toast.error(error.message)
    setRows(data || [])
    const ids = (data || []).map(r => r.id)
    if (ids.length) {
      const { data: e } = await supabase.from('vw_fuel_efficiency').select('id, km_since_prev, km_per_gallon, expected_km_per_gallon').in('id', ids)
      setEff(Object.fromEntries((e || []).map(x => [x.id, x])))
    }
    setLoading(false)
  }, [f.from, f.to, f.plate])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const visible = rows.filter(r => !f.onlyAlerts || (r.alerts || []).length > 0)
  const tot = visible.filter(r => r.status !== 'RECHAZADO').reduce((a, r) => ({ amount: a.amount + Number(r.amount), gal: a.gal + Number(r.fuel_gallons || 0) }), { amount: 0, gal: 0 })
  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl p-3 flex flex-wrap items-end gap-3 text-sm">
        <label>Desde<input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} className="block border rounded-lg px-2 py-1.5" /></label>
        <label>Hasta<input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} className="block border rounded-lg px-2 py-1.5" /></label>
        <label>Placa<input value={f.plate} onChange={e => setF({ ...f, plate: e.target.value.toUpperCase() })} className="block border rounded-lg px-2 py-1.5 w-28" /></label>
        <label className="flex items-center gap-1.5 pb-2"><input type="checkbox" checked={f.onlyAlerts} onChange={e => setF({ ...f, onlyAlerts: e.target.checked })} />Solo con alertas</label>
        <div className="ml-auto text-right"><div className="font-bold">{money(tot.amount)} · {tot.gal.toFixed(2)} gal</div><div className="text-xs text-slate-500">Precio promedio {tot.gal ? money(tot.amount / tot.gal) : '—'}/gal</div></div>
        <button onClick={() => exportXlsx(`combustible_${f.from}_${f.to}.xlsx`, { Cargas: visible.map(r => ({
          Fecha: r.expense_date, Placa: r.vehicle_plate, Despacho: r.dispatch?.dispatch_number || '', Grifo: r.station?.name || r.provider_name || '',
          Galones: Number(r.fuel_gallons || 0), Importe: Number(r.amount), 'S/ por galón': r.fuel_gallons ? Number(r.amount) / Number(r.fuel_gallons) : '',
          Odómetro: Number(r.fuel_odometer || 0), 'Km recorridos': eff[r.id]?.km_since_prev ?? '', 'Km/gal': eff[r.id]?.km_per_gallon ?? '',
          'Pagado por': r.paid_by, Estado: r.status, Alertas: (r.alerts || []).map((a: Row) => a.message).join('; '),
          Comprobante: evidenceLink(r.receipt_url),
        })) })} className="px-3 py-2 border rounded-lg flex items-center gap-1.5"><Download className="w-4 h-4" />Excel</button>
      </div>
      <div className="bg-white border rounded-xl overflow-auto max-h-[calc(100vh-340px)]">
        {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin" /></div> : (
          <DataTable className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 sticky top-0"><tr>
              <th className="p-3 text-left">Fecha</th><th className="p-3 text-left">Unidad / viaje</th><th className="p-3 text-left">Grifo</th><th className="p-3 text-right">Galones</th>
              <th className="p-3 text-right">Importe</th><th className="p-3 text-right">S/ gal</th><th className="p-3 text-right">Odómetro</th><th className="p-3 text-right">Km/gal</th><th className="p-3 text-left">Pagó</th><th className="p-3 text-left">Estado</th>
            </tr></thead>
            <tbody className="divide-y">
              {visible.length === 0 && <tr><td colSpan={10} className="p-8 text-center text-slate-400">Sin cargas en el periodo</td></tr>}
              {visible.map(r => {
                const e = eff[r.id]
                const low = e?.km_per_gallon != null && e.expected_km_per_gallon && Math.abs(e.km_per_gallon - e.expected_km_per_gallon) / e.expected_km_per_gallon > 0.25
                return (
                  <tr key={r.id}>
                    <td className="p-3 whitespace-nowrap">{fmtDate(r.expense_date)}</td>
                    <td className="p-3 font-semibold">{r.vehicle_plate}<div className="text-xs text-slate-500 font-normal">{r.dispatch?.dispatch_number || 'Sin viaje'}</div></td>
                    <td className="p-3 text-xs">{r.station?.name || r.provider_name || '—'}</td>
                    <td className="p-3 text-right">{r.fuel_gallons ? Number(r.fuel_gallons).toFixed(2) : <span className="text-red-600">—</span>}</td>
                    <td className="p-3 text-right font-semibold">{money(r.amount)}</td>
                    <td className="p-3 text-right">{r.fuel_gallons ? money(Number(r.amount) / Number(r.fuel_gallons)) : '—'}</td>
                    <td className="p-3 text-right">{r.fuel_odometer ? Number(r.fuel_odometer).toLocaleString('es-PE') : '—'}</td>
                    <td className={`p-3 text-right font-semibold ${low ? 'text-red-600' : ''}`}>{e?.km_per_gallon ?? '—'}{e?.km_since_prev != null && <div className="text-[10px] text-slate-500 font-normal">{Number(e.km_since_prev)} km</div>}</td>
                    <td className="p-3 text-xs">{r.paid_by === 'CONDUCTOR' ? 'Conductor' : r.paid_by === 'CAJA' ? 'Caja' : 'Empresa'}</td>
                    <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${EXPENSE_STATUS[r.status]?.cls}`}>{EXPENSE_STATUS[r.status]?.label}</span>
                      {(r.alerts || []).length > 0 && <AlertTriangle className="inline w-3 h-3 ml-1 text-amber-600" />}</td>
                  </tr>
                )
              })}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  )
}

function Efficiency({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [units, setUnits] = useState<Record<string, Row>>({})
  const [edit, setEdit] = useState<Row | null>(null)
  const load = useCallback(async () => {
    const [s, u] = await Promise.all([
      supabase.from('vw_vehicle_fuel_summary').select('*').order('vehicle_plate'),
      supabase.from('vw_caja_units').select('plate, type, fuel_tank_capacity_gal, expected_km_per_gallon').order('plate'),
    ])
    setRows(s.data || []); setUnits(Object.fromEntries((u.data || []).map(x => [x.plate, x])))
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const plates = useMemo(() => [...new Set([...rows.map(r => r.vehicle_plate), ...Object.keys(units)])].sort(), [rows, units])
  const byPlate = useMemo(() => Object.fromEntries(rows.map(r => [r.vehicle_plate, r])), [rows])
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">Últimos 90 días. El rendimiento de cada tramo es km desde la carga anterior entre los galones repuestos; configure el rendimiento esperado y la capacidad del tanque por unidad para las alertas.</p>
      <div className="bg-white border rounded-xl overflow-auto">
        <DataTable className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr>
            <th className="p-3 text-left">Unidad</th><th className="p-3 text-right">Cargas</th><th className="p-3 text-right">Galones</th><th className="p-3 text-right">Importe</th>
            <th className="p-3 text-right">S/ por gal</th><th className="p-3 text-right">Km medidos</th><th className="p-3 text-right">Km/gal real</th><th className="p-3 text-right">Esperado</th>
            <th className="p-3 text-right">Combustible/km</th><th className="p-3 text-right">Tanque</th><th className="p-3" />
          </tr></thead>
          <tbody className="divide-y">
            {plates.map(p => {
              const r = byPlate[p] || {}
              const u = units[p] || {}
              const dev = r.km_per_gallon && r.expected_km_per_gallon ? (r.km_per_gallon - r.expected_km_per_gallon) / r.expected_km_per_gallon : null
              return (
                <tr key={p}>
                  <td className="p-3 font-semibold">{p}<div className="text-xs text-slate-500 font-normal">{u.type}</div></td>
                  <td className="p-3 text-right">{r.loads ?? 0}</td>
                  <td className="p-3 text-right">{r.gallons ? Number(r.gallons).toFixed(1) : '—'}</td>
                  <td className="p-3 text-right">{r.amount ? money(r.amount, 0) : '—'}</td>
                  <td className="p-3 text-right">{r.avg_price_per_gallon ? money(r.avg_price_per_gallon) : '—'}</td>
                  <td className="p-3 text-right">{r.km ? Number(r.km).toLocaleString('es-PE') : '—'}</td>
                  <td className={`p-3 text-right font-bold ${dev != null && Math.abs(dev) > 0.25 ? 'text-red-600' : ''}`}>{r.km_per_gallon ?? '—'}</td>
                  <td className="p-3 text-right">{u.expected_km_per_gallon ?? <span className="text-slate-400">defecto</span>}</td>
                  <td className="p-3 text-right">{r.fuel_cost_per_km ? `S/ ${r.fuel_cost_per_km}` : '—'}</td>
                  <td className="p-3 text-right">{u.fuel_tank_capacity_gal ? `${u.fuel_tank_capacity_gal} gal` : '—'}</td>
                  <td className="p-3">{canManage && units[p] && <button onClick={() => setEdit({ plate: p, tank: u.fuel_tank_capacity_gal ?? '', kmpg: u.expected_km_per_gallon ?? '' })}><Gauge className="w-4 h-4 text-blue-600" /></button>}</td>
                </tr>
              )
            })}
          </tbody>
        </DataTable>
      </div>
      {edit && (
        <Modal isOpen onClose={() => setEdit(null)} title={`Combustible de ${edit.plate}`}>
          <div className="space-y-3 text-sm">
            <label className="block"><span className="text-xs font-bold text-slate-600">Capacidad del tanque (gal)</span><input type="number" min="0" value={edit.tank} onChange={e => setEdit({ ...edit, tank: e.target.value })} className="caja-input" /></label>
            <label className="block"><span className="text-xs font-bold text-slate-600">Rendimiento esperado (km/gal)</span><input type="number" min="0" step="0.1" value={edit.kmpg} onChange={e => setEdit({ ...edit, kmpg: e.target.value })} className="caja-input" /></label>
            <div className="flex justify-end">
              <button onClick={async () => {
                try {
                  await rpcOk(supabase, 'set_vehicle_fuel_params', { p_plate: edit.plate, p_tank_capacity: edit.tank === '' ? null : Number(edit.tank), p_expected_km_per_gallon: edit.kmpg === '' ? null : Number(edit.kmpg) })
                  toast.success('Parámetros guardados'); setEdit(null); void load()
                } catch (e) { toast.error(errorMessage(e)) }
              }} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold">Guardar</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Stations({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [edit, setEdit] = useState<Row | null>(null)
  const load = useCallback(async () => { const { data } = await supabase.from('fuel_stations').select('*').order('name'); setRows(data || []) }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const save = async () => {
    if (!edit) return
    const payload = { name: String(edit.name).trim(), ruc: edit.ruc || null, address: edit.address || null, has_credit: !!edit.has_credit,
      credit_limit: edit.credit_limit ? Number(edit.credit_limit) : null, billing_cycle: edit.billing_cycle || 'MENSUAL', is_active: edit.is_active !== false }
    const { error } = edit.id ? await supabase.from('fuel_stations').update(payload).eq('id', edit.id) : await supabase.from('fuel_stations').insert([payload])
    if (error) return toast.error(error.message)
    toast.success('Grifo guardado'); setEdit(null); void load()
  }
  return (
    <div className="space-y-3">
      {canManage && <button onClick={() => setEdit({ name: '', ruc: '', has_credit: true, billing_cycle: 'MENSUAL', is_active: true })} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4" />Nuevo grifo</button>}
      <div className="bg-white border rounded-xl overflow-auto">
        <DataTable className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="p-3 text-left">Grifo</th><th className="p-3 text-left">RUC</th><th className="p-3 text-left">Crédito</th><th className="p-3 text-left">Facturación</th><th className="p-3 text-left">Estado</th><th className="p-3" /></tr></thead>
          <tbody className="divide-y">
            {rows.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-slate-400">Sin grifos registrados</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className={!r.is_active ? 'opacity-50' : ''}>
                <td className="p-3 font-semibold flex items-center gap-2"><Store className="w-4 h-4 text-slate-400" />{r.name}<span className="text-xs text-slate-500 font-normal">{r.address}</span></td>
                <td className="p-3">{r.ruc || '—'}</td>
                <td className="p-3">{r.has_credit ? `Sí${r.credit_limit ? ` · línea ${money(r.credit_limit, 0)}` : ''}` : 'Contado'}</td>
                <td className="p-3">{r.billing_cycle}</td>
                <td className="p-3 text-xs">{r.is_active ? 'Activo' : 'Inactivo'}</td>
                <td className="p-3">{canManage && <button onClick={() => setEdit(r)}><Pencil className="w-4 h-4 text-blue-600" /></button>}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      {edit && (
        <Modal isOpen onClose={() => setEdit(null)} title={edit.id ? 'Editar grifo' : 'Nuevo grifo'}>
          <div className="space-y-3 text-sm">
            <label className="block"><span className="text-xs font-bold text-slate-600">Nombre</span><input value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} className="caja-input" /></label>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="text-xs font-bold text-slate-600">RUC</span><input value={edit.ruc || ''} onChange={e => setEdit({ ...edit, ruc: e.target.value.replace(/\D/g, '').slice(0, 11) })} className="caja-input" /></label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Dirección</span><input value={edit.address || ''} onChange={e => setEdit({ ...edit, address: e.target.value })} className="caja-input" /></label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={!!edit.has_credit} onChange={e => setEdit({ ...edit, has_credit: e.target.checked })} />Línea de crédito</label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Límite de crédito</span><input type="number" min="0" value={edit.credit_limit || ''} onChange={e => setEdit({ ...edit, credit_limit: e.target.value })} className="caja-input" /></label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Facturación</span>
                <select value={edit.billing_cycle} onChange={e => setEdit({ ...edit, billing_cycle: e.target.value })} className="caja-input"><option>SEMANAL</option><option>QUINCENAL</option><option>MENSUAL</option></select>
              </label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={edit.is_active !== false} onChange={e => setEdit({ ...edit, is_active: e.target.checked })} />Activo</label>
            </div>
            <div className="flex justify-end"><button disabled={!String(edit.name).trim()} onClick={save} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50">Guardar</button></div>
          </div>
        </Modal>
      )}
    </div>
  )
}

function Invoices({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Row[]>([])
  const [stations, setStations] = useState<Row[]>([])
  const [form, setForm] = useState<Row | null>(null)
  const [recon, setRecon] = useState<Row | null>(null)
  const load = useCallback(async () => {
    const [i, s] = await Promise.all([
      supabase.from('fuel_station_invoices').select('*, station:fuel_stations(name)').order('issue_date', { ascending: false }).limit(200),
      supabase.from('fuel_stations').select('id, name').eq('is_active', true).order('name'),
    ])
    setRows(i.data || []); setStations(s.data || [])
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const create = async () => {
    if (!form) return
    const { error } = await supabase.from('fuel_station_invoices').insert([{ station_id: form.station_id, document_series: String(form.series).toUpperCase(), document_number: form.number,
      issue_date: form.issue_date, period_start: form.period_start, period_end: form.period_end, amount: Number(form.amount), gallons: form.gallons ? Number(form.gallons) : null }])
    if (error) return toast.error(error.message)
    toast.success('Factura registrada: concílela contra las cargas'); setForm(null); void load()
  }
  const reconcile = async (inv: Row, accept = false, notes = '') => {
    try {
      const r = await rpcOk<Row>(supabase, 'reconcile_fuel_invoice', { p_invoice_id: inv.id, p_accept_difference: accept, p_notes: notes || null })
      if (r.status === 'CONCILIADA') toast.success(`Conciliada: ${r.loads_count} cargas por ${money(r.loads_amount)}`)
      else toast.warning(`Diferencia de ${money(r.difference)} (${r.loads_count} cargas por ${money(r.loads_amount)})`)
      setRecon(null); void load()
    } catch (e) { toast.error(errorMessage(e)) }
  }
  return (
    <div className="space-y-3">
      {canManage && <button onClick={() => setForm({ station_id: stations[0]?.id || '', series: '', number: '', issue_date: todayLima(), period_start: '', period_end: todayLima(), amount: '', gallons: '' })}
        className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm font-semibold flex items-center gap-2"><Plus className="w-4 h-4" />Registrar factura de grifo</button>}
      <div className="bg-white border rounded-xl overflow-auto">
        <DataTable className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr>
            <th className="p-3 text-left">Grifo</th><th className="p-3 text-left">Factura</th><th className="p-3 text-left">Periodo</th><th className="p-3 text-right">Facturado</th>
            <th className="p-3 text-right">Cargas registradas</th><th className="p-3 text-right">Diferencia</th><th className="p-3 text-left">Estado</th><th className="p-3" />
          </tr></thead>
          <tbody className="divide-y">
            {rows.length === 0 && <tr><td colSpan={8} className="p-8 text-center text-slate-400">Sin facturas</td></tr>}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="p-3">{r.station?.name}</td>
                <td className="p-3 font-semibold">{r.document_series}-{r.document_number}<div className="text-xs text-slate-500 font-normal">{fmtDate(r.issue_date)}</div></td>
                <td className="p-3 text-xs">{fmtDate(r.period_start)} – {fmtDate(r.period_end)}</td>
                <td className="p-3 text-right">{money(r.amount)}{r.gallons && <div className="text-xs text-slate-500">{Number(r.gallons)} gal</div>}</td>
                <td className="p-3 text-right">{r.loads_amount != null ? <>{money(r.loads_amount)}<div className="text-xs text-slate-500">{r.loads_count} cargas · {Number(r.loads_gallons)} gal</div></> : '—'}</td>
                <td className={`p-3 text-right font-semibold ${Number(r.difference_amount) ? 'text-red-600' : ''}`}>{r.difference_amount != null ? money(r.difference_amount) : '—'}</td>
                <td className="p-3 text-xs">{r.status === 'CONCILIADA' ? <span className="text-emerald-700 font-semibold flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Conciliada</span>
                  : r.status === 'CON_DIFERENCIAS' ? <span className="text-red-700 font-semibold">Con diferencias</span> : 'Pendiente'}{r.notes && <div className="text-slate-500">{r.notes}</div>}</td>
                <td className="p-3">{canManage && r.status !== 'CONCILIADA' && (
                  <button onClick={() => r.status === 'CON_DIFERENCIAS' ? setRecon({ ...r, notes: '' }) : reconcile(r)} className="text-xs font-semibold text-blue-700 bg-blue-50 px-3 py-1.5 rounded-lg flex items-center gap-1"><Receipt className="w-3 h-3" />Conciliar</button>
                )}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </div>
      {form && (
        <Modal isOpen onClose={() => setForm(null)} title="Factura de grifo">
          <div className="space-y-3 text-sm">
            <label className="block"><span className="text-xs font-bold text-slate-600">Grifo</span>
              <select value={form.station_id} onChange={e => setForm({ ...form, station_id: e.target.value })} className="caja-input">{stations.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <div className="grid grid-cols-3 gap-3">
              <label className="block"><span className="text-xs font-bold text-slate-600">Serie</span><input value={form.series} onChange={e => setForm({ ...form, series: e.target.value })} className="caja-input uppercase" /></label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Número</span><input value={form.number} onChange={e => setForm({ ...form, number: e.target.value })} className="caja-input" /></label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Emisión</span><input type="date" value={form.issue_date} onChange={e => setForm({ ...form, issue_date: e.target.value })} className="caja-input" /></label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Periodo desde</span><input type="date" value={form.period_start} onChange={e => setForm({ ...form, period_start: e.target.value })} className="caja-input" /></label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Periodo hasta</span><input type="date" value={form.period_end} onChange={e => setForm({ ...form, period_end: e.target.value })} className="caja-input" /></label>
              <label className="block"><span className="text-xs font-bold text-slate-600">Galones</span><input type="number" min="0" step="0.01" value={form.gallons} onChange={e => setForm({ ...form, gallons: e.target.value })} className="caja-input" /></label>
              <label className="block col-span-3"><span className="text-xs font-bold text-slate-600">Importe total (S/)</span><input type="number" min="0" step="0.01" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className="caja-input font-bold" /></label>
            </div>
            <div className="flex justify-end"><button disabled={!form.station_id || !form.series || !form.number || !form.period_start || !(Number(form.amount) > 0)} onClick={create} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50">Registrar</button></div>
          </div>
        </Modal>
      )}
      {recon && (
        <Modal isOpen onClose={() => setRecon(null)} title={`Conciliar ${recon.document_series}-${recon.document_number}`}>
          <div className="space-y-3 text-sm">
            <p>La factura tiene una diferencia de <b>{money(recon.difference_amount)}</b> contra las cargas registradas. Puede volver a conciliar (si se registraron cargas faltantes) o aceptar la diferencia con una explicación.</p>
            <textarea value={recon.notes} onChange={e => setRecon({ ...recon, notes: e.target.value })} rows={2} className="caja-input" placeholder="Explicación de la diferencia" />
            <div className="flex justify-end gap-2">
              <button onClick={() => reconcile(recon)} className="px-3 py-2 border rounded-lg">Volver a conciliar</button>
              <button disabled={!recon.notes.trim()} onClick={() => reconcile(recon, true, recon.notes)} className="px-4 py-2 bg-[#002855] text-white rounded-lg font-semibold disabled:opacity-50">Aceptar diferencia</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
