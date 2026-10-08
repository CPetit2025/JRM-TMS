'use client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Download, FileSpreadsheet, Loader2, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { daysAgo, exportXlsx, fmtDate, money, todayLima, type Row } from '@/lib/caja'
import { evidenceLink } from '@/components/evidence/EvidenceGallery'

// Reportes de la caja de transporte (Caja C3): rentabilidad por viaje (flete + refacturable − gastos aprobados),
// presupuesto vs real por categoría y exportación contable de gastos aprobados y del libro de caja.

const supabase = createClient()
const BUDGET: Record<string, string> = { COMBUSTIBLE: 'Combustible', PEAJE: 'Peajes', ALIMENTACION: 'Alimentación', HOSPEDAJE: 'Hospedaje', OTROS: 'Otros' }
const IGV = 0.18

export default function ReportesCajaPage() {
  const [range, setRange] = useState(() => ({ from: daysAgo(30), to: todayLima() }))
  const [trips, setTrips] = useState<Row[]>([])
  const [bva, setBva] = useState<Row[]>([])
  const [people, setPeople] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const load = useCallback(async (r: { from: string; to: string }) => {
    setLoading(true)
    const { data, error } = await supabase.from('vw_trip_profitability').select('*')
      .gte('departure_at', `${r.from}T00:00:00-05:00`).lte('departure_at', `${r.to}T23:59:59-05:00`).order('departure_at', { ascending: false }).limit(1000)
    if (error) toast.error(error.message)
    const list = (data || []).filter(t => Number(t.expenses) > 0 || Number(t.freight) > 0)
    setTrips(list)
    const ids = list.map(t => t.dispatch_id)
    if (ids.length) {
      const [b, p] = await Promise.all([
        supabase.from('vw_trip_budget_vs_actual').select('*').in('dispatch_id', ids),
        supabase.from('vw_caja_people').select('id, full_name').in('id', [...new Set(list.map(t => t.driver_id).filter(Boolean))]),
      ])
      setBva(b.data || []); setPeople(Object.fromEntries((p.data || []).map(x => [x.id, x.full_name])))
    } else { setBva([]) }
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(range) }, [range, load])

  const tot = useMemo(() => trips.reduce((a, t) => ({
    freight: a.freight + Number(t.freight), billable: a.billable + Number(t.billable), expenses: a.expenses + Number(t.expenses),
    fuel: a.fuel + Number(t.fuel), tolls: a.tolls + Number(t.tolls), per_diem: a.per_diem + Number(t.per_diem), other: a.other + Number(t.other_ops) + Number(t.maintenance),
    km: a.km + Number(t.km || 0),
  }), { freight: 0, billable: 0, expenses: 0, fuel: 0, tolls: 0, per_diem: 0, other: 0, km: 0 }), [trips])
  const margin = tot.freight + tot.billable - tot.expenses
  const bvaByCat = useMemo(() => {
    const g: Record<string, { budget: number; actual: number }> = {}
    bva.forEach(r => { g[r.category] = g[r.category] || { budget: 0, actual: 0 }; g[r.category].budget += Number(r.budget || 0); g[r.category].actual += Number(r.actual || 0) })
    return Object.entries(g)
  }, [bva])
  const maxBva = Math.max(1, ...bvaByCat.flatMap(([, v]) => [v.budget, v.actual]))

  // Exportación contable: gastos aprobados del periodo con cuenta, centro de costo e IGV de las facturas
  const exportAccounting = async () => {
    setExporting(true)
    try {
      const [exp, cats, mov] = await Promise.all([
        supabase.from('dispatch_expenses').select('*, dispatch:dispatches(dispatch_number)').eq('status', 'APROBADO')
          .gte('expense_date', range.from).lte('expense_date', range.to).order('expense_date').limit(5000),
        supabase.from('expense_categories').select('code, label, account_code'),
        supabase.from('cash_movements').select('*, box:cash_boxes(code, name)').gte('created_at', `${range.from}T00:00:00-05:00`)
          .lte('created_at', `${range.to}T23:59:59-05:00`).order('created_at').limit(5000),
      ])
      if (exp.error) throw exp.error
      const cat = Object.fromEntries((cats.data || []).map(c => [c.code, c]))
      exportXlsx(`contabilidad_caja_${range.from}_${range.to}.xlsx`, {
        'Gastos aprobados': (exp.data || []).map(e => {
          const total = Number(e.approved_amount ?? e.amount)
          const base = e.document_type === 'FACTURA' ? Math.round(total / (1 + IGV) * 100) / 100 : total
          return {
            Fecha: e.expense_date, 'Tipo doc.': e.document_type || '', Serie: e.document_series || '', Número: e.document_number || '',
            RUC: e.provider_ruc || '', Proveedor: e.provider_name || '', Categoría: cat[e.expense_type]?.label || e.expense_type,
            'Cuenta contable': cat[e.expense_type]?.account_code || '', 'Centro de costo (placa)': e.vehicle_plate || '', Despacho: e.dispatch?.dispatch_number || '',
            'Base imponible': base, IGV: Math.round((total - base) * 100) / 100, Total: total,
            'Pagado por': e.paid_by, Refacturable: e.is_billable ? 'Sí' : 'No', 'Aprobado el': fmtDate(e.reviewed_at, true),
            Comprobante: evidenceLink(e.receipt_url),
          }
        }),
        'Libro de caja': (mov.data || []).map(m => ({
          Fecha: fmtDate(m.created_at, true), Caja: m.box?.name || '', Tipo: m.movement_type, Descripción: m.description || '', Referencia: m.reference || '',
          Ingreso: m.direction === 1 ? Number(m.amount) : 0, Egreso: m.direction === -1 ? Number(m.amount) : 0,
        })),
      })
    } catch (e) { toast.error('No se pudo exportar: ' + (e instanceof Error ? e.message : String(e))) } finally { setExporting(false) }
  }

  const exportTrips = () => exportXlsx(`rentabilidad_viajes_${range.from}_${range.to}.xlsx`, {
    Viajes: trips.map(t => ({
      Despacho: t.dispatch_number, Placa: t.vehicle_plate, Conductor: people[t.driver_id] || '', Salida: fmtDate(t.departure_at), Km: Number(t.km || 0),
      Flete: Number(t.freight), Refacturable: Number(t.billable), Combustible: Number(t.fuel), Peajes: Number(t.tolls), Viáticos: Number(t.per_diem),
      'Otros operativos': Number(t.other_ops), Mantenimiento: Number(t.maintenance), 'Gasto total': Number(t.expenses), Presupuesto: t.budget != null ? Number(t.budget) : '',
      Margen: Number(t.margin), 'Margen %': t.margin_pct ?? '', 'Costo/km': t.cost_per_km ?? '', Liquidación: t.settlement_status || 'Abierta',
    })),
  })

  return (
    <div className="space-y-3">
      <PageHeader showTitle title="Reportes de caja" description="Rentabilidad por viaje con gastos aprobados, presupuesto contra real y exportación contable." actions={<>
<div className="flex flex-wrap items-end gap-2 text-sm">
          <label>Desde<input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} className="block border rounded-lg px-2 py-1.5" /></label>
          <label>Hasta<input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} className="block border rounded-lg px-2 py-1.5" /></label>
          <button onClick={() => load(range)} className="px-3 py-2 border rounded-lg flex items-center gap-1.5"><RefreshCw className="w-4 h-4" /></button>
          <button onClick={exportTrips} className="px-3 py-2 border rounded-lg flex items-center gap-1.5"><Download className="w-4 h-4" />Rentabilidad</button>
          <button disabled={exporting} onClick={exportAccounting} className="px-3 py-2 bg-[#002855] text-white rounded-lg flex items-center gap-1.5 disabled:opacity-50">
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileSpreadsheet className="w-4 h-4" />}Exportación contable
          </button>
        </div>
</>} />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat label="Flete + refacturable" value={money(tot.freight + tot.billable, 0)} sub={`${trips.length} viajes`} />
        <Stat label="Gastos aprobados" value={money(tot.expenses, 0)} sub={tot.km ? `S/ ${(tot.expenses / tot.km).toFixed(3)} por km` : undefined} />
        <Stat label="Margen" value={money(margin, 0)} sub={tot.freight + tot.billable ? `${((margin / (tot.freight + tot.billable)) * 100).toFixed(1)}%` : undefined} tone={margin < 0 ? 'red' : 'green'} />
        <Stat label="Combustible" value={money(tot.fuel, 0)} sub={tot.expenses ? `${((tot.fuel / tot.expenses) * 100).toFixed(0)}% del gasto` : undefined} />
        <Stat label="Peajes y viáticos" value={money(tot.tolls + tot.per_diem, 0)} />
      </div>

      {bvaByCat.length > 0 && (
        <div className="bg-white border rounded-xl p-4">
          <div className="text-sm font-semibold text-slate-800 mb-3">Presupuesto vs real (viajes presupuestados)</div>
          <div className="space-y-2">
            {bvaByCat.map(([k, v]) => (
              <div key={k} className="grid grid-cols-[8rem_1fr_9rem] items-center gap-3 text-xs">
                <span className="font-semibold">{BUDGET[k] || k}</span>
                <div className="space-y-1">
                  <div className="h-2.5 rounded bg-slate-300" style={{ width: `${(v.budget / maxBva) * 100}%` }} title="Presupuesto" />
                  <div className={`h-2.5 rounded ${v.actual > v.budget ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${(v.actual / maxBva) * 100}%` }} title="Real" />
                </div>
                <span className="text-right">{money(v.actual, 0)} / {money(v.budget, 0)}</span>
              </div>
            ))}
          </div>
          <div className="text-[11px] text-slate-500 mt-2 flex gap-4"><span><span className="inline-block w-3 h-2 bg-slate-300 rounded mr-1" />Presupuesto</span><span><span className="inline-block w-3 h-2 bg-emerald-500 rounded mr-1" />Real</span></div>
        </div>
      )}

      <div className="bg-white border rounded-xl overflow-auto max-h-[calc(100vh-420px)]">
        {loading ? <div className="p-12 flex justify-center"><Loader2 className="w-8 h-8 animate-spin text-blue-500" /></div> : (
          <DataTable className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500 sticky top-0"><tr>
              <th className="p-3 text-left">Despacho</th><th className="p-3 text-left">Conductor</th><th className="p-3 text-right">Flete</th><th className="p-3 text-right">Combustible</th>
              <th className="p-3 text-right">Peajes</th><th className="p-3 text-right">Viáticos</th><th className="p-3 text-right">Otros</th><th className="p-3 text-right">Gasto</th>
              <th className="p-3 text-right">Presupuesto</th><th className="p-3 text-right">Margen</th><th className="p-3 text-right">Costo/km</th>
            </tr></thead>
            <tbody className="divide-y">
              {trips.length === 0 && <tr><td colSpan={11} className="p-10 text-center text-slate-400">Sin viajes con flete o gastos en el periodo</td></tr>}
              {trips.map(t => (
                <tr key={t.dispatch_id}>
                  <td className="p-3 font-semibold">{t.dispatch_number}<div className="text-xs text-slate-500 font-normal">{t.vehicle_plate} · {fmtDate(t.departure_at)}</div></td>
                  <td className="p-3">{people[t.driver_id] || '—'}</td>
                  <td className="p-3 text-right">{money(t.freight, 0)}{Number(t.billable) > 0 && <div className="text-[10px] text-emerald-700">+{money(t.billable, 0)} refact.</div>}</td>
                  <td className="p-3 text-right">{money(t.fuel, 0)}</td>
                  <td className="p-3 text-right">{money(t.tolls, 0)}</td>
                  <td className="p-3 text-right">{money(t.per_diem, 0)}</td>
                  <td className="p-3 text-right">{money(Number(t.other_ops) + Number(t.maintenance), 0)}</td>
                  <td className="p-3 text-right font-semibold">{money(t.expenses, 0)}</td>
                  <td className={`p-3 text-right ${t.budget != null && Number(t.expenses) > Number(t.budget) ? 'text-red-600 font-semibold' : ''}`}>{t.budget != null ? money(t.budget, 0) : '—'}</td>
                  <td className={`p-3 text-right font-bold ${Number(t.margin) < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{money(t.margin, 0)}{t.margin_pct != null && <div className="text-[10px] font-normal">{t.margin_pct}%</div>}</td>
                  <td className="p-3 text-right">{t.cost_per_km != null ? `S/ ${t.cost_per_km}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'red' | 'green' }) {
  return (
    <div className="bg-white border rounded-xl p-4">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-2xl font-bold ${tone === 'red' ? 'text-red-600' : tone === 'green' ? 'text-emerald-700' : 'text-slate-900'}`}>{value}</div>
      {sub && <div className="text-xs text-slate-400">{sub}</div>}
    </div>
  )
}
