'use client'
import { DataTable } from '@/components/ui/data-table'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Loader2, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import { limaDay, type PreuseInspection } from '@/lib/preuse'
import { exportPreusePdf } from '@/lib/preuse-pdf'
import { toast } from 'sonner'

export function PreuseReports() {
  const supabase = useMemo(() => createClient(), [])
  const [from,setFrom] = useState(limaDay), [to,setTo] = useState(limaDay), [search,setSearch] = useState('')
  const [rows,setRows] = useState<PreuseInspection[]>([]), [busy,setBusy] = useState(false), [exporting,setExporting] = useState(false), [error,setError] = useState('')
  const [query,setQuery] = useState<{ from:string; to:string; search:string } | null>(null)
  const load = useCallback(async (range: { from:string; to:string; search:string }) => {
    setBusy(true); setError(''); setQuery(null)
    try { const { data,error } = await supabase.rpc('list_driver_preuse', { p_from:range.from,p_to:range.to,p_search:range.search }); if (error) throw error; setRows(data || []); setQuery(range) }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(false) }
  }, [supabase])
  useEffect(() => { const timer = window.setTimeout(() => void load({ from:limaDay(),to:limaDay(),search:'' }),0); return () => window.clearTimeout(timer) }, [load])
  const current = query?.from === from && query?.to === to && query?.search === search
  const download = async () => { if (!query || !current || busy || exporting) return; setExporting(true); try { await exportPreusePdf(rows,query.from,query.to) } catch (e) { toast.error(errorMessage(e)) } finally { setExporting(false) } }
  return <section className="space-y-4">
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4"><h2 className="font-bold text-[#002855]">FR-DT 007 · Inspección de pre uso</h2><p className="mt-1 text-sm text-slate-600">Registro diario del conductor y unidad, independientemente de la ruta. Cada inspección se exporta en una página del formato v01, incluso si el conductor cambia de unidad el mismo día.</p></div>
    <form onSubmit={e => { e.preventDefault(); void load({ from,to,search }) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <label className="text-sm">Desde<input required type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 block min-h-11 rounded-lg border border-slate-300 px-3" /></label>
      <label className="text-sm">Hasta<input required type="date" min={from} value={to} onChange={e => setTo(e.target.value)} className="mt-1 block min-h-11 rounded-lg border border-slate-300 px-3" /></label>
      <label className="text-sm">Conductor, placa o brevete<input value={search} onChange={e => setSearch(e.target.value)} className="mt-1 block min-h-11 w-full rounded-lg border border-slate-300 px-3" /></label>
      <button disabled={busy} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Consultar</button>
      <button type="button" disabled={!current || !rows.length || busy || exporting} onClick={() => void download()} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855] disabled:opacity-50">{exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Exportar formato PDF</button>
    </form>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {!current && !busy && !error && <p className="text-sm text-slate-500">Pulsa Consultar para aplicar las fechas y filtros antes de exportar.</p>}
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><p className="border-b p-3 text-sm text-slate-500">{current ? `${rows.length} inspección(es) · un formato por registro` : 'Consulta pendiente de actualizar'}</p>{busy ? <p className="p-6 text-center text-sm">Consultando inspecciones…</p> : current && !rows.length ? <p className="p-6 text-center text-sm text-slate-500">Sin inspecciones para las fechas seleccionadas.</p> : current && <DataTable className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{['Fecha de operación','Conductor','Unidad','Vehículo Operativo','Inspeccionado por'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody className="divide-y">{rows.map(row => <tr key={row.operation_id}><td className="p-3">{row.operation_date.split('-').reverse().join('/')}<p className="text-xs text-slate-500">{new Date(row.captured_at).toLocaleTimeString('es-PE',{ timeZone:'America/Lima',hour:'2-digit',minute:'2-digit' })}</p></td><td className="p-3">{row.driver_name}</td><td className="p-3 font-semibold text-[#002855]">{row.vehicle_plate}</td><td className="p-3">{row.vehicle_operational ? 'SÍ' : 'NO'}{!row.can_operate && <p className="text-xs text-red-700">No habilita operación</p>}</td><td className="p-3">{row.inspector_name}</td></tr>)}</tbody></DataTable>}</div>
  </section>
}
