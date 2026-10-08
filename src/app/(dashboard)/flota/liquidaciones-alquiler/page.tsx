'use client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Calculator, Loader2, FileText, Check, X, RefreshCw, Mail, BellRing } from 'lucide-react'
import { LiquidacionAlquilerView, mesDe } from '@/components/flota/LiquidacionAlquilerDoc'

// Liquidación de alquiler seco (Fase 11): cálculo con km/horas REALES del periodo y descuento por
// indisponibilidad; se registra en BORRADOR y la aprueba un usuario distinto (migración 20260928130000).
// Los km salen de la valorización importada (ago–set 2026), de las rutas del sistema o del odómetro (20261005120000).

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const field = 'w-full border rounded-lg px-3 py-2 text-sm'

function loadAll() {
  return Promise.all([
    supabase.from('vehicle_lease_contracts').select('id, contract_code, rate_type, rate_amount, status, start_date, end_date, vehicles(plate), carriers(business_name)').in('status', ['ACTIVO', 'RENOVADO', 'TERMINADO']).order('start_date', { ascending: false }),
    supabase.from('lease_settlements').select('*, vehicle_lease_contracts(contract_code, rate_type, carriers(business_name)), vehicles(plate)').order('created_at', { ascending: false }).limit(100),
    supabase.from('lease_settlement_sends').select('settlement_id, sent_at, sent_to').order('sent_at', { ascending: false }).limit(500),
  ])
}

export default function LiquidacionesAlquilerPage() {
  const [contracts, setContracts] = useState<Row[]>([])
  const [settlements, setSettlements] = useState<Row[]>([])
  const [sends, setSends] = useState<Record<string, Row>>({})
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ contract_id: '', period_start: '', period_end: '', other_discounts: '0', penalties: '0', consumptions: '0', additional_costs: '0', notes: '' })
  const [preview, setPreview] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<string | null>(null)

  const apply = useCallback(([c, s, e]: Awaited<ReturnType<typeof loadAll>>) => {
    if (c.error) toast.error('Error al cargar contratos: ' + c.error.message)
    setContracts(c.data || []); setSettlements(s.data || [])
    const m: Record<string, Row> = {}
    for (const x of e.data || []) if (!m[x.settlement_id]) m[x.settlement_id] = x
    setSends(m)
    setLoading(false)
    return s.data || []
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  // Llegada desde la alerta del día 1: ?contrato=<id>&periodo=AAAA-MM abre la liquidación o deja listo el cálculo
  useEffect(() => {
    loadAll().then(apply).then(list => {
      const q = new URLSearchParams(window.location.search)
      const contrato = q.get('contrato'), periodo = q.get('periodo')
      if (!contrato || !periodo || !/^\d{4}-\d{2}$/.test(periodo)) return
      const [y, m] = periodo.split('-').map(Number)
      const ini = `${periodo}-01`, fin = `${periodo}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
      const s = list.find((x: Row) => x.contract_id === contrato && x.status !== 'ANULADA' && x.period_start <= fin && x.period_end >= ini)
      if (s) setViewing(s.id)
      else setForm(f => ({ ...f, contract_id: contrato, period_start: ini, period_end: fin }))
    })
  }, [apply])

  // Envío mensual: el día 1 se envía la liquidación del mes anterior de cada contrato activo
  const pendientes = useMemo(() => {
    const hoy = new Date()
    const ini = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1), fin = new Date(hoy.getFullYear(), hoy.getMonth(), 0)
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const a = iso(ini), b = iso(fin)
    return contracts.filter(c => c.status === 'ACTIVO' && c.start_date <= b && (!c.end_date || c.end_date >= a)).map(c => {
      const s = settlements.find(x => x.contract_id === c.id && x.status !== 'ANULADA' && x.period_start <= b && x.period_end >= a)
      return { c, s, ini: a, fin: b, enviado: s ? sends[s.id] : null }
    }).filter(p => !p.enviado)
  }, [contracts, settlements, sends])

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

  if (viewing) return <LiquidacionAlquilerView settlementId={viewing} onBack={() => { setViewing(null); refresh() }} onChanged={refresh} />
  const dia = new Date().getDate()

  return (
    <div className="space-y-3">
      <PageHeader showTitle title="Liquidación de alquiler seco" description="Km y horas reales del periodo, excesos, descuento por indisponibilidad, penalidades, consumos y costos adicionales. La aprueba un usuario distinto." actions={<>
<button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
</>} />

      {!loading && pendientes.length > 0 && (
        <div className={`rounded-xl border p-4 text-sm ${dia === 1 ? 'border-amber-300 bg-amber-50' : 'border-red-200 bg-red-50'}`}>
          <div className="flex items-center gap-2 font-semibold text-slate-800"><BellRing className={`h-4 w-4 ${dia === 1 ? 'text-amber-600' : 'text-[#cf152d]'}`} />
            {dia === 1 ? 'Hoy se envían las liquidaciones de alquiler' : 'Liquidaciones de alquiler sin enviar'} · {mesDe(pendientes[0].ini)}
            <span className="font-normal text-slate-500">(se envían el día 1 de cada mes)</span>
          </div>
          <div className="mt-2 divide-y divide-black/5">
            {pendientes.map(p => (
              <div key={p.c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><b>{p.c.vehicles?.plate}</b> · {p.c.carriers?.business_name} · <span className="text-slate-600">{!p.s ? 'falta calcular y registrar' : p.s.status === 'BORRADOR' ? 'registrada, falta aprobar y enviar' : 'aprobada, falta enviar'}</span></span>
                {p.s ? (
                  <button onClick={() => setViewing(p.s!.id)} className="flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-1.5 text-xs font-semibold text-white"><Mail className="h-3.5 w-3.5" />Abrir y enviar</button>
                ) : (
                  <button onClick={() => { setForm(f => ({ ...f, contract_id: p.c.id, period_start: p.ini, period_end: p.fin })); setPreview(null) }} className="flex items-center gap-1 rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold"><Calculator className="h-3.5 w-3.5" />Preparar cálculo</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

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
          <DataTable className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
              <th className="text-left p-3">Periodo</th><th className="text-left p-3">Contrato / unidad</th><th className="text-right p-3">Km</th><th className="text-right p-3">Horas</th>
              <th className="text-right p-3">Subtotal</th><th className="text-right p-3">Total</th><th className="text-left p-3">Estado</th><th className="text-left p-3">Envío</th><th className="p-3"></th>
            </tr></thead>
            <tbody className="divide-y">
              {settlements.map(s => (
                <tr key={s.id}>
                  <td className="p-3">{s.period_start} → {s.period_end}<div className="text-xs text-slate-500">{s.days} días</div></td>
                  <td className="p-3">{s.vehicle_lease_contracts?.contract_code} · {s.vehicles?.plate}<div className="text-xs text-slate-500">{s.vehicle_lease_contracts?.carriers?.business_name}</div></td>
                  <td className="p-3 text-right">{s.km_used}</td><td className="p-3 text-right">{s.hours_used}</td>
                  <td className="p-3 text-right">{money(s.subtotal)}</td><td className="p-3 text-right font-semibold">{money(s.total)}</td>
                  <td className="p-3"><span className={`px-2 py-0.5 rounded text-xs font-semibold ${s.status === 'APROBADA' ? 'bg-emerald-100 text-emerald-700' : s.status === 'ANULADA' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{s.status}</span></td>
                  <td className="p-3 text-xs">{sends[s.id] ? <span className="text-emerald-700">Enviada {new Date(sends[s.id].sent_at).toLocaleDateString('es-PE')}<div className="text-slate-500">{sends[s.id].sent_to}</div></span> : s.status === 'ANULADA' ? '—' : <span className="text-amber-700">Pendiente</span>}</td>
                  <td className="p-3"><div className="flex gap-1 justify-end">
                    {s.status === 'BORRADOR' && <>
                      <button title="Aprobar" onClick={() => decide(s, 'APROBADA')} className="p-1.5 border rounded-lg text-emerald-700"><Check className="w-4 h-4" /></button>
                      <button title="Anular" onClick={() => decide(s, 'ANULADA')} className="p-1.5 border rounded-lg text-red-600"><X className="w-4 h-4" /></button>
                    </>}
                    <button title="Ver documento, descargar PDF y enviar" onClick={() => setViewing(s.id)} className="flex items-center gap-1 px-2 py-1.5 border rounded-lg text-xs font-semibold text-[#002855]"><FileText className="w-4 h-4" />Documento</button>
                  </div></td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  )
}

const FUENTE: Record<string, string> = {
  VALORIZACION: 'Valorización del arrendador (agosto y setiembre 2026, importada del Excel)',
  RUTA: 'Rutas del sistema: odómetro del checklist o GPS de la app por cada viaje',
  ODOMETRO: 'Lecturas de odómetro del periodo',
}
const km = (n: unknown) => Number(n || 0).toLocaleString('es-PE', { maximumFractionDigits: 2 })

function Breakdown({ s }: { s: Row }) {
  const rows: [string, React.ReactNode][] = [
    ['Periodo liquidado', `${s.period_start} → ${s.period_end} (${s.days} días)`],
    ['Uso real', `${km(s.km_used)} km · ${s.hours_used} h`],
    [`Tarifa base (${s.rate_type})`, money(s.base_amount)],
    [`Exceso de km (${km(s.excess_km)} km sobre ${s.included_km != null ? km(s.included_km) : '—'}${s.excess_km_rate ? ` × S/ ${Number(s.excess_km_rate).toFixed(4)}` : ''})`, money(s.excess_km_amount)],
    [`Exceso de horas (${s.excess_hours} h)`, money(s.excess_hours_amount)],
    [`Descuento por indisponibilidad (${s.downtime_days} días${s.costo_diario ? ` × ${money(s.costo_diario)}` : ''})`, `− ${money(s.downtime_discount)}`],
    ['Otros descuentos', `− ${money(s.other_discounts)}`], ['Penalidades', money(s.penalties)],
    ['Consumos', money(s.consumptions)], ['Costos adicionales', money(s.additional_costs)],
    ['Subtotal', money(s.subtotal)], ['IGV 18%', money(s.tax)], ['Total', <b key="t">{money(s.total)}</b>],
  ]
  return (
    <div className="space-y-3">
      <DataTable className="w-full max-w-xl text-sm border rounded-lg">
        <tbody className="divide-y">{rows.map(([k, v]) => <tr key={k}><td className="p-2 text-slate-600">{k}</td><td className="p-2 text-right">{v}</td></tr>)}</tbody>
      </DataTable>
      {s.km_fuente && <Valorizacion s={s} />}
    </div>
  )
}

// Factores de la valorización: de dónde salen los km, días laborados, costo diario, garantía y el control GPS/odómetro.
function Valorizacion({ s }: { s: Row }) {
  const viajes: Row[] = Array.isArray(s.viajes) ? s.viajes : []
  const control = s.km_gps != null ? Number(s.km_gps) : Number(s.km_odometro || 0) || null
  const items: [string, string][] = [
    ['Días laborados', `${s.dias_laborados ?? 0} de ${s.days}`],
    ['Costo diario', s.costo_diario ? `${money(s.costo_diario)}${s.dias_base ? ` (base ${s.dias_base} días)` : ''}` : '—'],
    ['Garantía', s.garantia ? money(s.garantia) : '—'],
    ['Viajes', `${viajes.length}${s.viajes_sin_km ? ` · ${s.viajes_sin_km} sin km` : ''}`],
  ]
  return (
    <div className="max-w-3xl space-y-2 text-sm">
      <div className="rounded-lg border bg-slate-50 p-3">
        <div className="text-xs font-semibold uppercase text-slate-500">Fuente de los km</div>
        <div className="font-medium text-slate-800">{FUENTE[s.km_fuente] || s.km_fuente}</div>
        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
          {items.map(([k, v]) => <div key={k}><div className="text-xs text-slate-500">{k}</div><div className="font-semibold text-slate-800">{v}</div></div>)}
        </div>
      </div>
      {s.km_fuente !== 'ODOMETRO' && control != null && (
        <div className={`rounded-lg border p-3 ${Number(s.km_fuera_de_ruta) > 0 ? 'border-amber-200 bg-amber-50 text-amber-900' : 'bg-white text-slate-700'}`}>
          Control: {s.km_gps != null ? 'GPS del arrendador' : 'odómetro'} {km(control)} km vs. {km(s.km_used)} km liquidados
          {Number(s.km_fuera_de_ruta) > 0 && <> · <b>{km(s.km_fuera_de_ruta)} km recorridos sin viaje registrado</b> (no se cobran; revisar con el arrendador)</>}
        </div>
      )}
      {s.viajes_sin_km > 0 && <p className="text-xs text-amber-700">{s.viajes_sin_km} viajes no tienen odómetro de cierre ni km de GPS: complete el checklist de retorno para que sumen.</p>}
      <p className="text-xs text-slate-500">Los fletes facturados al cliente no forman parte del alquiler.</p>
      {viajes.length > 0 && (
        <details className="rounded-lg border">
          <summary className="cursor-pointer p-2 font-medium text-slate-700">Detalle de viajes ({viajes.length})</summary>
          <div className="max-h-80 overflow-auto print:max-h-none">
            <DataTable className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr>
                <th className="p-2 text-left">Fecha</th><th className="p-2 text-left">Guía / viaje</th><th className="p-2 text-left">Cliente / destino</th><th className="p-2 text-right">Km</th><th className="p-2 text-left">Fuente</th>
              </tr></thead>
              <tbody className="divide-y">{viajes.map((v, i) => (
                <tr key={i}>
                  <td className="p-2 whitespace-nowrap">{v.fecha}</td><td className="p-2">{v.ref || '—'}</td>
                  <td className="p-2">{[v.cliente, v.destino].filter(Boolean).join(' · ') || '—'}</td>
                  <td className="p-2 text-right">{v.km != null ? km(v.km) : '—'}</td><td className="p-2">{v.km_fuente}</td>
                </tr>))}
              </tbody>
            </DataTable>
          </div>
        </details>
      )}
    </div>
  )
}
