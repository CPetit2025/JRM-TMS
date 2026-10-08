'use client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Loader2, RefreshCw } from 'lucide-react'

// Finanzas y TCO (Fase 11): todo sale del libro de costos por activo (vw_vehicle_cost_ledger):
// mantenimiento, operación, combustible, neumáticos, multas/siniestros y alquiler (migración 20260928130000).

const supabase = createClient()
type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const money = (n: unknown) => `S/ ${Number(n || 0).toLocaleString('es-PE', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
const CATS = [['maintenance_cost', 'Mantenimiento'], ['operating_cost', 'Operación'], ['fuel_cost', 'Combustible'], ['tires_cost', 'Neumáticos'], ['compliance_cost', 'Multas y siniestros'], ['lease_cost', 'Alquiler']] as const

function loadAll() {
  return Promise.all([
    supabase.from('vehicle_tco_analytics').select('*').order('total_tco', { ascending: false }),
    supabase.from('vw_asset_tco').select('*').order('anio', { ascending: false }).order('mes', { ascending: false }).limit(500),
  ])
}

export default function FinanzasTcoPage() {
  const [tco, setTco] = useState<Row[]>([])
  const [monthly, setMonthly] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [ownership, setOwnership] = useState('TODOS')

  const apply = useCallback(([t, m]: Awaited<ReturnType<typeof loadAll>>) => {
    if (t.error) toast.error('Error al cargar TCO: ' + t.error.message)
    setTco(t.data || []); setMonthly(m.data || [])
    setLoading(false)
  }, [])
  const refresh = useCallback(() => { setLoading(true); return loadAll().then(apply) }, [apply])
  useEffect(() => { loadAll().then(apply) }, [apply])

  const rows = useMemo(() => tco.filter(r => ownership === 'TODOS' || r.ownership_status === ownership), [tco, ownership])
  const totals = useMemo(() => {
    const t: Record<string, number> = { total_tco: 0 }
    CATS.forEach(([k]) => { t[k] = 0 })
    rows.forEach(r => { t.total_tco += Number(r.total_tco || 0); CATS.forEach(([k]) => { t[k] += Number(r[k] || 0) }) })
    return t
  }, [rows])
  const byOwnership = useMemo(() => {
    const g = new Map<string, { units: number; tco: number; km: number }>()
    tco.forEach(r => {
      const k = r.ownership_status || 'PROPIO'
      const cur = g.get(k) || { units: 0, tco: 0, km: 0 }
      g.set(k, { units: cur.units + 1, tco: cur.tco + Number(r.total_tco || 0), km: cur.km + Number(r.current_odometer || 0) })
    })
    return [...g.entries()]
  }, [tco])
  const months = useMemo(() => {
    const g = new Map<string, number>()
    monthly.filter(m => ownership === 'TODOS' || m.propiedad === ownership).forEach(m => {
      const k = `${m.anio}-${String(m.mes).padStart(2, '0')}`
      g.set(k, (g.get(k) || 0) + Number(m.total_tco || 0))
    })
    return [...g.entries()].sort(([a], [b]) => b.localeCompare(a)).slice(0, 12)
  }, [monthly, ownership])
  const maxMonth = Math.max(1, ...months.map(([, v]) => v))

  return (
    <div className="space-y-3">
      <PageHeader showTitle title="Finanzas y TCO" description="Costo total de propiedad por activo desde el libro de costos: mantenimiento, operación, combustible, neumáticos, cumplimiento y alquiler." actions={<>
<div className="flex gap-2">
          <select value={ownership} onChange={e => setOwnership(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="TODOS">Propios y alquilados</option><option value="PROPIO">Solo propios</option><option value="ALQUILADO">Solo alquilados</option><option value="LEASING">Leasing</option>
          </select>
          <button onClick={refresh} className="px-3 py-2 border rounded-lg text-sm flex items-center gap-2"><RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        </div>
</>} />

      {loading ? <div className="p-10 flex justify-center"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div> : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
            <div className="bg-[#002855] text-white rounded-xl p-3"><div className="text-xs opacity-80">TCO total</div><div className="text-xl font-bold">{money(totals.total_tco)}</div></div>
            {CATS.map(([k, l]) => <div key={k} className="bg-white border rounded-xl p-3"><div className="text-xs text-slate-500">{l}</div><div className="text-lg font-bold">{money(totals[k])}</div></div>)}
          </div>

          <div className="grid md:grid-cols-2 gap-4">
            <div className="bg-white border rounded-xl p-4">
              <h3 className="font-semibold mb-3">Propios vs alquilados</h3>
              <DataTable className="w-full text-sm"><thead className="text-xs text-slate-500"><tr><th className="text-left">Propiedad</th><th className="text-right">Unidades</th><th className="text-right">TCO</th><th className="text-right">Costo/km</th></tr></thead>
                <tbody>{byOwnership.map(([k, v]) => <tr key={k}><td className="py-1">{k}</td><td className="text-right">{v.units}</td><td className="text-right">{money(v.tco)}</td><td className="text-right">{v.km > 0 ? `S/ ${(v.tco / v.km).toFixed(3)}` : '—'}</td></tr>)}</tbody></DataTable>
            </div>
            <div className="bg-white border rounded-xl p-4">
              <h3 className="font-semibold mb-3">TCO por mes (últimos 12)</h3>
              {months.length === 0 ? <p className="text-sm text-slate-500">Sin costos registrados.</p> : (
                <ul className="space-y-1.5 text-xs">{months.map(([m, v]) => (
                  <li key={m} className="flex items-center gap-2"><span className="w-16 text-slate-500">{m}</span>
                    <span className="h-3 rounded bg-[#002855]" style={{ width: `${Math.max(2, (v / maxMonth) * 100)}%` }} /><span className="whitespace-nowrap">{money(v)}</span></li>))}</ul>
              )}
            </div>
          </div>

          <div className="bg-white border rounded-xl overflow-x-auto">
            <DataTable className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                <th className="text-left p-3">Unidad</th>{CATS.map(([, l]) => <th key={l} className="text-right p-3">{l}</th>)}<th className="text-right p-3">TCO</th><th className="text-right p-3">Costo/km</th><th className="text-right p-3">Costo/h</th>
              </tr></thead>
              <tbody className="divide-y">
                {rows.map(r => (
                  <tr key={r.vehicle_id}>
                    <td className="p-3"><div className="font-semibold">{r.plate}</div><div className="text-xs text-slate-500">{r.type} · {r.ownership_status}</div></td>
                    {CATS.map(([k]) => <td key={k} className="p-3 text-right">{money(r[k])}</td>)}
                    <td className="p-3 text-right font-semibold">{money(r.total_tco)}</td>
                    <td className="p-3 text-right">{r.cpk != null ? `S/ ${Number(r.cpk).toFixed(3)}` : '—'}</td>
                    <td className="p-3 text-right">{r.cost_per_hour != null ? `S/ ${Number(r.cost_per_hour).toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          </div>
        </>
      )}
    </div>
  )
}
