'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { format } from 'date-fns'
import { Calculator, Loader2, Printer, Check, X, RefreshCw } from 'lucide-react'

// Liquidación de alquiler seco (Fase 11): cálculo con km/horas REALES del periodo y descuento por
// indisponibilidad; se registra en BORRADOR y la aprueba un usuario distinto (migración 20260928130000).

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const field = 'w-full border rounded-lg px-3 py-2 text-sm'

function loadAll() {
  return Promise.all([
    supabase.from('vehicle_lease_contracts').select('id, contract_code, rate_type, rate_amount, status, start_date, end_date, vehicles(plate), carriers(business_name)').in('status', ['ACTIVO', 'RENOVADO', 'TERMINADO']).order('start_date', { ascending: false }),
    supabase.from('lease_settlements').select('*, vehicle_lease_contracts(contract_code, rate_type, carriers(business_name)), vehicles(plate)').order('created_at', { ascending: false }).limit(100),
    supabase.from('system_settings').select('value').eq('key', 'admin_signature_url').maybeSingle(),
  ])
}

export default function LiquidacionesAlquilerPage() {
  const [contracts, setContracts] = useState<Row[]>([])
  const [settlements, setSettlements] = useState<Row[]>([])
  const [signature, setSignature] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ contract_id: '', period_start: '', period_end: '', other_discounts: '0', penalties: '0', consumptions: '0', additional_costs: '0', notes: '' })
  const [preview, setPreview] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [printing, setPrinting] = useState<Row | null>(null)

  const apply = useCallback(([c, s, sig]: Awaited<ReturnType<typeof loadAll>>) => {
    if (c.error) toast.error('Error al cargar contratos: ' + c.error.message)
    setContracts(c.data || []); setSettlements(s.data || []); setSignature(sig.data?.value || '')
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const args = useMemo(() => ({
    p_contract_id: form.contract_id, p_period_start: form.period_start, p_period_end: form.period_end,
    p_other_discounts: Number(form.other_discounts) || 0, p_penalties: Number(form.penalties) || 0,
    p_consumptions: Number(form.consumptions) || 0, p_additional_costs: Number(form.additional_costs) || 0,
  }), [form])

  const calculate = async () => {
    if (!form.contract_id || !form.period_start || !form.period_end) return toast.error('Seleccione contrato y periodo')
    setBusy(true)
    const { data, error } = await supabase.rpc('calculate_lease_settlement', args)
    setBusy(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    setPreview(data)
  }

  const register = async () => {
    setBusy(true)
    const { data, error } = await supabase.rpc('create_lease_settlement', { ...args, p_notes: form.notes || null })
    setBusy(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success('Liquidación registrada en BORRADOR; requiere aprobación')
    setPreview(null); refresh()
  }

  const decide = async (s: Row, decision: 'APROBADA' | 'ANULADA') => {
    const notes = decision === 'ANULADA' ? prompt('Motivo de la anulación:') : prompt('Comentario de aprobación (opcional):')
    if (decision === 'ANULADA' && !notes?.trim()) return
    const { data, error } = await supabase.rpc('decide_lease_settlement', { p_settlement_id: s.id, p_decision: decision, p_notes: notes || null })
    if (error || !data?.success) return toast.error(error?.message || data?.error)
    toast.success(`Liquidación ${decision.toLowerCase()}`); refresh()
  }

  if (printing) return <PrintView s={printing} signature={signature} onBack={() => setPrinting(null)} />

  return (
    <div className="p-6 space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><Calculator className="w-6 h-6" />Liquidación de alquiler seco</h1>
          <p className="text-sm text-slate-500">Km y horas reales del periodo, excesos, descuento por indisponibilidad, penalidades, consumos y costos adicionales. La aprueba un usuario distinto.</p>
        </div>
        <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
      </div>

      <div className="bg-white border rounded-xl p-4 space-y-3 text-sm">
        <div className="grid md:grid-cols-4 gap-3">
          <label className="md:col-span-2">Contrato<select className={field} value={form.contract_id} onChange={e => { setForm({ ...form, contract_id: e.target.value }); setPreview(null) }}>
            <option value="">Seleccionar…</option>{contracts.map(c => <option key={c.id} value={c.id}>{c.contract_code} · {c.vehicles?.plate} · {c.carriers?.business_name} · {c.rate_type} {money(c.rate_amount)}</option>)}</select></label>
          <label>Desde<input type="date" className={field} value={form.period_start} onChange={e => { setForm({ ...form, period_start: e.target.value }); setPreview(null) }} /></label>
          <label>Hasta<input type="date" className={field} value={form.period_end} onChange={e => { setForm({ ...form, period_end: e.target.value }); setPreview(null) }} /></label>
          <label>Otros descuentos<input type="number" min={0} step="0.01" className={field} value={form.other_discounts} onChange={e => setForm({ ...form, other_discounts: e.target.value })} /></label>
          <label>Penalidades<input type="number" min={0} step="0.01" className={field} value={form.penalties} onChange={e => setForm({ ...form, penalties: e.target.value })} /></label>
          <label>Consumos<input type="number" min={0} step="0.01" className={field} value={form.consumptions} onChange={e => setForm({ ...form, consumptions: e.target.value })} /></label>
          <label>Costos adicionales<input type="number" min={0} step="0.01" className={field} value={form.additional_costs} onChange={e => setForm({ ...form, additional_costs: e.target.value })} /></label>
          <label className="md:col-span-4">Sustento (obligatorio si hay descuentos, penalidades o adicionales)<input className={field} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} /></label>
        </div>
        <div className="flex gap-2">
          <button disabled={busy} onClick={calculate} className="px-4 py-2 border rounded-lg flex items-center gap-2">{busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Calculator className="w-4 h-4" />}Calcular</button>
          {preview && <button disabled={busy} onClick={register} className="px-4 py-2 bg-[#002855] text-white rounded-lg">Registrar liquidación</button>}
        </div>
        {preview && <Breakdown s={preview} />}
      </div>

      <div className="bg-white border rounded-xl overflow-x-auto">
        {loading ? <div className="p-8 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : settlements.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">Sin liquidaciones registradas.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="text-left p-3">Periodo</th><th className="text-left p-3">Contrato / unidad</th><th className="text-right p-3">Km</th><th className="text-right p-3">Horas</th>
              <th className="text-right p-3">Subtotal</th><th className="text-right p-3">Total</th><th className="text-left p-3">Estado</th><th className="p-3"></th>
            </tr></thead>
            <tbody className="divide-y">
              {settlements.map(s => (
                <tr key={s.id}>
                  <td className="p-3">{s.period_start} → {s.period_end}<div className="text-xs text-slate-500">{s.days} días</div></td>
                  <td className="p-3">{s.vehicle_lease_contracts?.contract_code} · {s.vehicles?.plate}<div className="text-xs text-slate-500">{s.vehicle_lease_contracts?.carriers?.business_name}</div></td>
                  <td className="p-3 text-right">{s.km_used}</td><td className="p-3 text-right">{s.hours_used}</td>
                  <td className="p-3 text-right">{money(s.subtotal)}</td><td className="p-3 text-right font-semibold">{money(s.total)}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${s.status === 'APROBADA' ? 'bg-emerald-100 text-emerald-700' : s.status === 'ANULADA' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{s.status}</span></td>
                  <td className="p-3"><div className="flex gap-1 justify-end">
                    {s.status === 'BORRADOR' && <>
                      <button title="Aprobar" onClick={() => decide(s, 'APROBADA')} className="p-1.5 border rounded-lg text-emerald-700"><Check className="w-4 h-4" /></button>
                      <button title="Anular" onClick={() => decide(s, 'ANULADA')} className="p-1.5 border rounded-lg text-red-600"><X className="w-4 h-4" /></button>
                    </>}
                    <button title="Imprimir" onClick={() => setPrinting(s)} className="p-1.5 border rounded-lg"><Printer className="w-4 h-4" /></button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function Breakdown({ s }: { s: Row }) {
  const rows: [string, React.ReactNode][] = [
    ['Periodo liquidado', `${s.period_start} → ${s.period_end} (${s.days} días)`],
    ['Uso real', `${s.km_used} km · ${s.hours_used} h`],
    [`Tarifa base (${s.rate_type})`, money(s.base_amount)],
    [`Exceso de km (${s.excess_km} km sobre ${s.included_km ?? '—'})`, money(s.excess_km_amount)],
    [`Exceso de horas (${s.excess_hours} h)`, money(s.excess_hours_amount)],
    [`Descuento por indisponibilidad (${s.downtime_days} días)`, `− ${money(s.downtime_discount)}`],
    ['Otros descuentos', `− ${money(s.other_discounts)}`], ['Penalidades', money(s.penalties)],
    ['Consumos', money(s.consumptions)], ['Costos adicionales', money(s.additional_costs)],
    ['Subtotal', money(s.subtotal)], ['IGV 18%', money(s.tax)], ['Total', <b key="t">{money(s.total)}</b>],
  ]
  return (
    <table className="w-full max-w-xl text-sm border rounded-lg">
      <tbody className="divide-y">{rows.map(([k, v]) => <tr key={k}><td className="p-2 text-slate-600">{k}</td><td className="p-2 text-right">{v}</td></tr>)}</tbody>
    </table>
  )
}

function PrintView({ s, signature, onBack }: { s: Row; signature: string; onBack: () => void }) {
  return (
    <div className="p-6 space-y-4">
      <div className="flex justify-between print:hidden">
        <button onClick={onBack} className="px-4 py-2 border rounded-lg text-sm">Volver</button>
        <button onClick={() => window.print()} className="px-4 py-2 bg-[#002855] text-white rounded-lg text-sm flex items-center gap-2"><Printer className="w-4 h-4" />Imprimir</button>
      </div>
      <div className="bg-white border mx-auto p-8 print:border-none print:p-0" style={{ maxWidth: '210mm' }}>
        <div className="bg-[#002855] text-white p-6 rounded-t-lg mb-6 print:rounded-none" style={{ WebkitPrintColorAdjust: 'exact', printColorAdjust: 'exact' }}>
          <div className="text-xl font-bold">Liquidación de alquiler seco</div>
          <div className="text-sm opacity-80">{s.vehicle_lease_contracts?.contract_code} · {s.vehicles?.plate} · {s.vehicle_lease_contracts?.carriers?.business_name}</div>
        </div>
        <Breakdown s={{ ...s, ...(s.detail || {}) }} />
        {s.notes && <p className="text-sm text-slate-600 mt-4 whitespace-pre-wrap">{s.notes}</p>}
        <div className="mt-10 flex justify-between items-end text-sm">
          <div>Estado: <b>{s.status}</b>{s.approved_at ? ` · ${format(new Date(s.approved_at), 'dd/MM/yyyy HH:mm')}` : ''}</div>
          {signature && s.status === 'APROBADA' && (
            <div className="text-center">{/* eslint-disable-next-line @next/next/no-img-element */}<img src={signature} alt="Firma" className="h-16 mx-auto" /><div className="border-t pt-1">Aprobado</div></div>
          )}
        </div>
      </div>
    </div>
  )
}
