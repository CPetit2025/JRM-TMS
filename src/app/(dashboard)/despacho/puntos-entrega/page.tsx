'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, MapPin, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'

type Point = { id: string; kind: string; label: string; lat: number; lon: number; radius_m: number; source: string; samples: number; updated_at: string }
const FUENTE: Record<string, string> = { GPS_PLANTA: 'GPS de las unidades', GEOCODIFICADO: 'Ubicado por dirección', APRENDIDO: 'Llegadas con GPS', CORREGIDO: 'Corregido por Despacho' }
const field = 'min-h-11 rounded-lg border border-slate-300 px-2 text-sm'

/** Geocercas del FR-DT.004: planta y destinos con su radio. Las horas de llegada y salida se calculan con ellas. */
export default function PuntosEntregaPage() {
  const { canWrite } = usePermissions()
  const [rows, setRows] = useState<Point[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [q, setQ] = useState('')
  const [edit, setEdit] = useState<{ id: string; coords: string; radius: string } | null>(null), [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const { data, error: e } = await createClient().from('geo_points').select('id,kind,label,lat,lon,radius_m,source,samples,updated_at').order('kind', { ascending: false }).order('label')
    if (e) setError(e.message); else { setError(''); setRows((data || []) as Point[]) }
    setLoading(false)
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const view = useMemo(() => rows.filter(r => !q || r.label.toLowerCase().includes(q.toLowerCase())), [rows, q])
  const pg = usePagination(view, 'puntos-entrega', (r, col) => [r.kind, r.label, FUENTE[r.source] || r.source, r.radius_m, r.samples, r.updated_at][col])
  const save = async () => {
    if (!edit) return
    const [lat, lon] = edit.coords.split(/[,\s]+/).filter(Boolean).map(Number)
    setBusy(true); setError('')
    const { error: e } = await createClient().rpc('geo_point_save', { p_id: edit.id, p_lat: lat, p_lon: lon, p_radius: Number(edit.radius) })
    setBusy(false)
    if (e) { setError(e.message); return }
    setEdit(null); void load()
  }
  return <div className="space-y-4">
    <PageHeader title="Puntos de entrega (geocercas)" showTitle description="Planta y destinos con su radio. El GPS del celular marca la llegada y la salida al entrar y salir del círculo."
      actions={<button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold"><RefreshCw className="h-4 w-4" aria-hidden />Actualizar</button>} />
    <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">Los destinos se crean solos: con el punto que calcula el mapa al programar la ruta y, cuando hay llegadas con GPS preciso, con la ubicación real de esas llegadas. Si un punto está mal, corríjalo pegando «latitud, longitud» (por ejemplo, desde Google Maps) y ajuste el radio para plantas grandes.</p>
    <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar dirección" aria-label="Buscar dirección" className={`w-full max-w-md ${field}`} />
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {loading ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /> : <div className="rounded-xl border border-slate-200 bg-white">
      <div className="overflow-x-auto"><DataTable dense onSortChange={pg.onSortChange} className="min-w-[900px] text-sm">
        <thead><tr><th scope="col">Tipo</th><th scope="col">Dirección</th><th scope="col">Fuente</th><th scope="col">Radio</th><th scope="col">Llegadas</th><th scope="col">Ubicación</th></tr></thead>
        <tbody>{pg.pageRows.map(r => <tr key={r.id} className="align-top">
          <td>{r.kind === 'PLANTA' ? 'Planta' : 'Destino'}</td>
          <td className="max-w-md">{r.label}</td>
          <td><span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${r.source === 'GEOCODIFICADO' ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}`}>{FUENTE[r.source] || r.source}</span></td>
          <td className="tabular-nums">{r.radius_m} m</td>
          <td className="tabular-nums">{r.samples || '—'}</td>
          <td>{edit?.id === r.id ? <div className="flex flex-wrap items-center gap-2">
              <input value={edit.coords} onChange={e => setEdit({ ...edit, coords: e.target.value })} aria-label="Latitud, longitud" className={`w-52 ${field}`} />
              <input type="number" min="50" max="3000" value={edit.radius} onChange={e => setEdit({ ...edit, radius: e.target.value })} aria-label="Radio en metros" className={`w-24 ${field}`} />
              <button type="button" disabled={busy} onClick={() => setEdit(null)} className="min-h-11 rounded-lg border px-3">Cancelar</button>
              <button type="button" disabled={busy} onClick={() => void save()} className="min-h-11 rounded-lg bg-[#002855] px-3 font-semibold text-white">{busy ? 'Guardando…' : 'Guardar'}</button>
            </div> : <div className="flex flex-wrap items-center gap-2">
              <a href={`https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lon}#map=17/${r.lat}/${r.lon}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-700 underline"><MapPin className="h-4 w-4" aria-hidden />{r.lat.toFixed(5)}, {r.lon.toFixed(5)}</a>
              {canWrite('despacho') && <button type="button" onClick={() => setEdit({ id: r.id, coords: `${r.lat}, ${r.lon}`, radius: String(r.radius_m) })} className="min-h-9 text-sm font-semibold text-blue-700 underline">Corregir</button>}
            </div>}</td>
        </tr>)}</tbody>
      </DataTable></div>
      <TablePagination total={pg.total} page={pg.page} pageSize={pg.pageSize} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="puntos" />
    </div>}
  </div>
}
