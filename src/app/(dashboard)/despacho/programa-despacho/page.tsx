'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileSpreadsheet, FileText, Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { createClient } from '@/lib/supabase/client'
import { COLS, estimated, exportExcel, exportPdf, type FrRow as Row } from '@/lib/despacho/fr-dt-004'

const lima = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const num = (v: number | null) => v == null ? '' : Number(v).toLocaleString('es-PE', { maximumFractionDigits: 1 })
const field = 'min-h-11 rounded-lg border border-slate-300 px-3 text-sm'

/** Programa de despacho FR-DT.004: una fila por parada (flota propia y terceros) con la fuente de cada dato estimado. */
export default function ProgramaDespachoPage() {
  const [today] = useState(() => lima(new Date()))
  const [from, setFrom] = useState(() => lima(new Date(Date.now() - 6 * 864e5))), [to, setTo] = useState(today)
  const [plate, setPlate] = useState(''), [driver, setDriver] = useState(''), [mode, setMode] = useState<'' | 'PROPIA' | 'TERCERO'>('')
  const [rows, setRows] = useState<Row[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [exporting, setExporting] = useState<'' | 'xlsx' | 'pdf'>('')
  const load = useCallback(async () => {
    setLoading(true)
    const { data, error: e } = await createClient().rpc('fr_dt_004_report', { p_from: from, p_to: to, p_plate: plate.trim() || null, p_driver: driver.trim() || null })
    if (e) setError(e.message); else { setError(''); setRows((data || []) as Row[]) }
    setLoading(false)
  }, [from, to, plate, driver])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const view = useMemo(() => rows.filter(r => !mode || r.modalidad === mode), [rows, mode])
  const pg = usePagination(view, 'programa-despacho', (r, col) => COLS[col] ? COLS[col].v(r) : '')
  const gaps = useMemo(() => ({
    llegGps: view.filter(r => r.llegada_fuente === 'GPS').length, sinDescarga: view.filter(r => r.llegada_fuente && !r.tiempos_fuente).length,
    kmGps: view.filter(r => r.km_cliente_fuente === 'GPS').length, sinKm: view.filter(r => r.modalidad === 'PROPIA' && r.km_cliente == null).length,
    sinOcup: view.filter(r => r.ocupacion_pct == null).length, sinPeso: view.filter(r => r.peso_kg == null).length,
    sinSalida: view.filter(r => !r.hora_salida).length, sinPlanta: view.filter(r => !r.hora_llegada_planta).length,
  }), [view])

  const filters = [plate && `placa ${plate}`, driver && `conductor ${driver}`, mode && (mode === 'PROPIA' ? 'flota propia' : 'terceros')].filter(Boolean).join(' · ')
  const exportar = async (kind: 'xlsx' | 'pdf') => {
    setExporting(kind)
    try { await (kind === 'xlsx' ? exportExcel : exportPdf)(view, { from, to, filters }) }
    catch (e) { setError(e instanceof Error ? e.message : 'No se pudo exportar') } finally { setExporting('') }
  }

  return <div className="space-y-4">
    <PageHeader title="Programa de despacho" showTitle description="Formato FR-DT.004: una fila por parada, en hora de Lima. Los datos estimados se marcan."
      actions={<>
        <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold"><RefreshCw className="h-4 w-4" aria-hidden />Actualizar</button>
        <button type="button" disabled={!!exporting || !view.length} onClick={() => void exportar('xlsx')} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white disabled:opacity-50"><FileSpreadsheet className="h-4 w-4" aria-hidden />{exporting === 'xlsx' ? 'Generando…' : 'Descargar Excel'}</button>
        <button type="button" disabled={!!exporting || !view.length} onClick={() => void exportar('pdf')} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50"><FileText className="h-4 w-4" aria-hidden />{exporting === 'pdf' ? 'Generando…' : 'Descargar PDF'}</button>
      </>} />
    <section className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <label className="font-semibold">Desde<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className={`mt-1 block ${field}`} /></label>
      <label className="font-semibold">Hasta<input type="date" value={to} min={from} max={today} onChange={e => setTo(e.target.value)} className={`mt-1 block ${field}`} /></label>
      <label className="font-semibold">Placa<input value={plate} onChange={e => setPlate(e.target.value)} placeholder="BCW838" className={`mt-1 block w-32 ${field}`} /></label>
      <label className="font-semibold">Conductor<input value={driver} onChange={e => setDriver(e.target.value)} placeholder="Apellido" className={`mt-1 block w-40 ${field}`} /></label>
      <label className="font-semibold">Flota<select value={mode} onChange={e => setMode(e.target.value as typeof mode)} className={`mt-1 block ${field}`}>
        <option value="">Propia y terceros</option><option value="PROPIA">Propia</option><option value="TERCERO">Terceros</option></select></label>
      {(plate || driver || mode) && <button type="button" onClick={() => { setPlate(''); setDriver(''); setMode('') }} className="min-h-11 rounded-lg border px-3 font-semibold">Limpiar filtros</button>}
    </section>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {!loading && view.length > 0 && <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">{view.length} paradas · llegadas por GPS: {gaps.llegGps} · sin marca de descarga: {gaps.sinDescarga} · km en cliente estimado con GPS: {gaps.kmGps} · sin km en cliente (propia): {gaps.sinKm} · sin hora de salida: {gaps.sinSalida} · sin llegada a planta: {gaps.sinPlanta} · sin m³ %: {gaps.sinOcup} · sin peso: {gaps.sinPeso}. Un dato vacío no se registró; nunca se rellena con 0.</p>}
    {loading ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /> : view.length === 0
      ? <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-500">Sin paradas en el período.</p>
      : <div className="rounded-xl border border-slate-200 bg-white"><div className="overflow-x-auto"><DataTable dense onSortChange={pg.onSortChange} className="min-w-[2400px] text-xs">
        <thead><tr>{COLS.map(c => <th key={c.h} scope="col">{c.h}</th>)}</tr></thead>
        <tbody>{pg.pageRows.map((r, i) => <tr key={`${r.viaje}-${r.solicitud}-${i}`} className="border-t border-slate-100 align-top">
          {COLS.map(c => { const v = c.v(r)
            const est = estimated(r, c.h)
            return <td key={c.h} className={`p-2 ${typeof v === 'number' ? 'text-right tabular-nums' : ''} ${est ? 'bg-amber-50' : ''}`}
              title={est ? (c.h === 'KM/LLEGADA CLIENTE' ? 'Estimado: km inicial + km GPS hasta la llegada' : c.h === 'PESO (KG)' ? 'Peso del packing list' : c.h === 'TIEMPO DE ENTREGA DESCARGA' ? 'Estimado: de la llegada al envío de la guía (sin marca de descarga)' : 'Corregido por el conductor') : undefined}>
              {typeof v === 'number' ? num(v) : v}{est && <span className="sr-only"> (estimado)</span>}</td> })}
        </tr>)}</tbody></DataTable></div>
        <TablePagination total={pg.total} page={pg.page} pageSize={pg.pageSize} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="paradas" /></div>}
    <p className="text-xs text-slate-500">Las horas de salida, llegada, salida del cliente y llegada a planta salen del GPS (geocercas) y, si no hay señal, de lo que registró el conductor. Celdas en ámbar: dato estimado (km por GPS, peso del packing list o descarga sin marca) o corregido por el conductor (m³ %). Pase el cursor o el lector de pantalla para ver la fuente.</p>
  </div>
}
