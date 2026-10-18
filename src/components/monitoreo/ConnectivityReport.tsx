'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import { gpsTime, type DriverClientState } from '@/lib/gps-monitor'

type Row = {
  driver_id: string; driver: string; points: number; gps_gaps: number; delay_p50_s: number | null; delay_p90_s: number | null
  late_pct: number | null; route_gaps: number; route_gap_minutes: number; route_gap_max_minutes: number; all_gaps: number
  last_seen_at: string | null; client: DriverClientState | null; pending_points: number | null
}

const delay = (seconds: number | null) => seconds === null ? '—' : seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`

// Diagnóstico de conexión por conductor: cortes del app en ruta, huecos de registro GPS y retraso con que llegan los
// puntos (subida diferida = app en segundo plano o sin datos). Los cortes se registran desde esta versión.
export function ConnectivityReport() {
  const supabase = useMemo(() => createClient(), [])
  const [days, setDays] = useState(7)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void supabase.rpc('get_driver_connectivity_report', { p_days: days }).then(({ data, error: loadError }) => {
      if (cancelled) return
      if (loadError || !data?.success) { setError(loadError ? errorMessage(loadError) : 'No se pudo consultar el diagnóstico.'); setRows([]) }
      else { setError(''); setRows(data.drivers as Row[]) }
    })
    return () => { cancelled = true }
  }, [supabase, days])

  return <div className="space-y-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-slate-600">Conductores con rutas en el periodo. Los cortes del app se registran desde la actualización de conectividad.</p>
      <label className="flex items-center gap-2 text-xs text-slate-600">Periodo
        <select value={days} onChange={e => { setRows(null); setDays(Number(e.target.value)) }} className="min-h-9 rounded-lg border border-slate-300 bg-white px-2">
          {[1, 7, 14, 30].map(value => <option key={value} value={value}>{value === 1 ? 'Último día' : `Últimos ${value} días`}</option>)}
        </select></label>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {rows === null ? <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" />Consultando…</p>
      : !rows.length ? <p className="text-slate-500">Sin rutas con conductor en el periodo.</p>
      : <div className="max-h-[60dvh] overflow-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[46rem] text-left text-xs">
          <thead className="sticky top-0 bg-slate-50 text-slate-600"><tr>
            <th className="p-2">Conductor</th><th className="p-2" title="Veces que el app dejó de reportar más de 90 s con una ruta en curso">Cortes en ruta</th>
            <th className="p-2" title="Tiempo total y corte más largo">Tiempo sin conexión</th>
            <th className="p-2" title="Tramos de más de 2 min sin puntos GPS registrados (GPS apagado, sin señal o servicio detenido)">Huecos GPS</th>
            <th className="p-2" title="Tiempo entre que se tomó el punto y llegó al servidor (mediana / 90 %)">Retraso de subida</th>
            <th className="p-2" title="Puntos que llegaron con más de 2 min de retraso">Subida diferida</th><th className="p-2">Teléfono</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-100">{rows.map(row => <tr key={row.driver_id} className="align-top">
            <td className="p-2 font-semibold text-jrm-navy">{row.driver}<span className="block font-normal text-slate-500">Última conexión: {gpsTime(row.last_seen_at)}</span></td>
            <td className={`p-2 ${row.route_gaps ? 'font-semibold text-amber-800' : ''}`}>{row.route_gaps}</td>
            <td className="p-2">{row.route_gap_minutes} min{row.route_gap_max_minutes > 0 && <span className="block text-slate-500">máx. {row.route_gap_max_minutes} min</span>}</td>
            <td className="p-2">{row.gps_gaps}<span className="block text-slate-500">de {row.points} puntos</span></td>
            <td className="p-2">{delay(row.delay_p50_s)} / {delay(row.delay_p90_s)}</td>
            <td className={`p-2 ${(row.late_pct ?? 0) >= 20 ? 'font-semibold text-amber-800' : ''}`}>{row.late_pct === null ? '—' : `${row.late_pct} %`}</td>
            <td className="p-2 text-slate-600">{row.client?.device || '—'}{typeof row.client?.battery === 'number' && <span className="block">Batería {Math.round(row.client.battery * 100)} %</span>}{row.client?.app_version && <span className="block">App {row.client.app_version}</span>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    <p className="text-xs text-slate-500">Lectura: muchos cortes con subida diferida alta indican el app en segundo plano o ahorro de batería; huecos GPS altos indican GPS apagado, sin señal o el seguimiento detenido por el teléfono.</p>
  </div>
}
