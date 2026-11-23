'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { createClient } from '@/lib/supabase/client'

type Row = { area: string | null; fecha: string; tipo_actividad: string; guia: string | null; ot_oc_os: string | null; razon_social: string | null; provincia: string | null
  distrito: string | null; destino: string | null; vuelta: number; placa: string | null; marca: string | null; conductor: string | null; modalidad: string
  hora_salida: string | null; hora_llegada_cliente: string | null; espera_min: number | null; descarga_min: number | null; hora_salida_cliente: string | null
  hora_llegada_planta: string | null; total_min: number | null; km_inicial: number | null; km_cliente: number | null; km_cliente_fuente: string | null
  km_recorridos: number | null; km_planta: number | null; km_total: number | null; ocupacion_pct: number | null; ocupacion_fuente: string | null
  peso_kg: number | null; peso_fuente: string | null; tipo_descarga: string; viaje: string | null; solicitud: string | null; estado_viaje: string }

const lima = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const hora = (v: string | null) => v ? new Date(v).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }) : ''
const hm = (min: number | null) => min == null ? '' : `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`
const fecha = (v: string) => v.split('-').reverse().join('/')
const num = (v: number | null) => v == null ? '' : Number(v).toLocaleString('es-PE', { maximumFractionDigits: 1 })
const field = 'min-h-11 rounded-lg border border-slate-300 px-3 text-sm'

// Columnas del formato FR-DT.004 v02 (hoja «Referencia»), en el mismo orden
const COLS: { h: string; v: (r: Row) => string | number; w?: number }[] = [
  { h: 'AREA SOLICITANTE', v: r => r.area || '' }, { h: 'Fecha', v: r => fecha(r.fecha) }, { h: 'TIPO DE ACTIVIDAD', v: r => r.tipo_actividad, w: 28 },
  { h: 'NRO DE GUIA', v: r => r.guia || '' }, { h: 'OT /OC/OS', v: r => r.ot_oc_os || '' }, { h: 'Razón Social', v: r => r.razon_social || '', w: 28 },
  { h: 'Provincia', v: r => r.provincia || '' }, { h: 'Distrito', v: r => r.distrito || '' }, { h: 'NUMERO DE VUELTA', v: r => r.vuelta },
  { h: 'Placa del vehiculo', v: r => r.placa || '' }, { h: 'Marca del vehiculo', v: r => r.marca || '' }, { h: 'Nombre de Conductores', v: r => r.conductor || '', w: 28 },
  { h: 'DESTINO', v: r => r.destino || '' }, { h: 'Hr/SALIDA', v: r => hora(r.hora_salida) }, { h: 'HORA LLEGADA CLIENTE', v: r => hora(r.hora_llegada_cliente) },
  { h: 'TIEMPO DE ESPERA EN HORAS', v: r => hm(r.espera_min) }, { h: 'TIEMPO DE ENTREGA DESCARGA', v: r => hm(r.descarga_min) },
  { h: 'HORA DE SALIDA DE CLIENTE', v: r => hora(r.hora_salida_cliente) }, { h: 'HORA DE LLEGADA A PLANTA', v: r => hora(r.hora_llegada_planta) },
  { h: 'TIEMPO TOTAL HORAS RECORRIDAS / PARADAS', v: r => hm(r.total_min) }, { h: 'KM/ INICIAL', v: r => r.km_inicial ?? '' },
  { h: 'KM/LLEGADA CLIENTE', v: r => r.km_cliente ?? '' }, { h: 'KM RECORRIDOS', v: r => r.km_recorridos ?? '' }, { h: 'KM. LLEGADA PLANTA', v: r => r.km_planta ?? '' },
  { h: 'KM TOTAL DE ENTREGA', v: r => r.km_total ?? '' }, { h: 'METRO CUBICO (%)', v: r => r.ocupacion_pct == null ? '' : `${r.ocupacion_pct}%` },
  { h: 'PESO (KG)', v: r => r.peso_kg ?? '' }, { h: 'TIPO DE DESCARGA', v: r => r.tipo_descarga },
]

/** Programa de despacho FR-DT.004: una fila por parada (flota propia y terceros) con la fuente de cada dato estimado. */
export default function ProgramaDespachoPage() {
  const [today] = useState(() => lima(new Date()))
  const [from, setFrom] = useState(() => lima(new Date(Date.now() - 6 * 864e5))), [to, setTo] = useState(today)
  const [plate, setPlate] = useState(''), [driver, setDriver] = useState(''), [mode, setMode] = useState<'' | 'PROPIA' | 'TERCERO'>('')
  const [rows, setRows] = useState<Row[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [exporting, setExporting] = useState(false)
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
    kmGps: view.filter(r => r.km_cliente_fuente === 'GPS').length, sinKm: view.filter(r => r.modalidad === 'PROPIA' && r.km_cliente == null).length,
    sinOcup: view.filter(r => r.ocupacion_pct == null).length, sinPeso: view.filter(r => r.peso_kg == null).length,
    sinSalida: view.filter(r => !r.hora_salida).length, sinPlanta: view.filter(r => !r.hora_llegada_planta).length,
  }), [view])

  const exportar = async () => {
    setExporting(true)
    try {
      const ExcelJS = (await import('exceljs')).default
      const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet('FR-DT.004')
      ws.mergeCells('A1:B4'); ws.getCell('A1').value = 'JRM'
      ws.mergeCells('C1:I1'); ws.getCell('C1').value = 'SISTEMA INTEGRADO DE GESTION'
      ws.mergeCells('C2:I2'); ws.getCell('C2').value = 'FORMATO:'
      ws.mergeCells('C3:I4'); ws.getCell('C3').value = 'PROGRAMA DE DESPACHO'
      ws.getCell('J1').value = 'CÓDIGO: FR-DT.004'; ws.getCell('J2').value = 'VERSION Nº: 02'; ws.getCell('J3').value = `Período: ${fecha(from)} a ${fecha(to)}`
      ws.getCell('J4').value = `Extraído ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}${plate ? ` · placa ${plate}` : ''}${driver ? ` · conductor ${driver}` : ''}${mode ? ` · ${mode === 'PROPIA' ? 'flota propia' : 'terceros'}` : ''}`
      ;['A1', 'C1', 'C3'].forEach(c => { ws.getCell(c).font = { bold: true }; ws.getCell(c).alignment = { vertical: 'middle', horizontal: 'center' } })
      const head = ws.getRow(7); COLS.forEach((c, i) => { const cell = head.getCell(i + 1); cell.value = c.h; cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002855' } }; cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' } })
      head.height = 42
      view.forEach((r, i) => ws.getRow(8 + i).values = COLS.map(c => c.v(r)))
      COLS.forEach((c, i) => { ws.getColumn(i + 1).width = c.w || 14 })
      ws.getColumn(COLS.length + 2).width = 60
      ws.getCell(7, COLS.length + 2).value = 'Fuente de datos estimados'; ws.getCell(7, COLS.length + 2).font = { bold: true }
      view.forEach((r, i) => { const n = [r.km_cliente_fuente === 'GPS' && 'km en cliente estimado con GPS', r.ocupacion_fuente === 'CONDUCTOR' && 'ocupación corregida por el conductor',
        r.peso_fuente === 'PACKING_LIST' && 'peso del packing list', `viaje ${r.viaje || '—'} · ${r.solicitud || '—'}`].filter(Boolean).join(' · ')
        ws.getCell(8 + i, COLS.length + 2).value = n })
      ws.views = [{ state: 'frozen', ySplit: 7 }]
      const buffer = await wb.xlsx.writeBuffer()
      const url = URL.createObjectURL(new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
      const a = document.createElement('a'); a.href = url; a.download = `FR-DT.004_${from}_${to}.xlsx`; a.click(); URL.revokeObjectURL(url)
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo exportar') } finally { setExporting(false) }
  }

  return <div className="space-y-4">
    <PageHeader title="Programa de despacho" showTitle description="Formato FR-DT.004: una fila por parada, en hora de Lima. Los datos estimados se marcan."
      actions={<>
        <button type="button" onClick={() => void load()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold"><RefreshCw className="h-4 w-4" aria-hidden />Actualizar</button>
        <button type="button" disabled={exporting || !view.length} onClick={() => void exportar()} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50"><Download className="h-4 w-4" aria-hidden />{exporting ? 'Exportando…' : 'Exportar Excel'}</button>
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
    {!loading && view.length > 0 && <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-700">{view.length} paradas · km en cliente estimado con GPS: {gaps.kmGps} · sin km en cliente (propia): {gaps.sinKm} · sin hora de salida: {gaps.sinSalida} · sin llegada a planta: {gaps.sinPlanta} · sin m³ %: {gaps.sinOcup} · sin peso: {gaps.sinPeso}. Un dato vacío no se registró; nunca se rellena con 0.</p>}
    {loading ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /> : view.length === 0
      ? <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-slate-500">Sin paradas en el período.</p>
      : <div className="rounded-xl border border-slate-200 bg-white"><div className="overflow-x-auto"><DataTable dense onSortChange={pg.onSortChange} className="min-w-[2400px] text-xs">
        <thead><tr>{COLS.map(c => <th key={c.h} scope="col">{c.h}</th>)}</tr></thead>
        <tbody>{pg.pageRows.map((r, i) => <tr key={`${r.viaje}-${r.solicitud}-${i}`} className="border-t border-slate-100 align-top">
          {COLS.map(c => { const v = c.v(r)
            const est = (c.h === 'KM/LLEGADA CLIENTE' && r.km_cliente_fuente === 'GPS') || (c.h === 'PESO (KG)' && r.peso_fuente === 'PACKING_LIST') || (c.h === 'METRO CUBICO (%)' && r.ocupacion_fuente === 'CONDUCTOR')
            return <td key={c.h} className={`p-2 ${typeof v === 'number' ? 'text-right tabular-nums' : ''} ${est ? 'bg-amber-50' : ''}`}
              title={est ? (c.h === 'KM/LLEGADA CLIENTE' ? 'Estimado: km inicial + km GPS hasta la llegada' : c.h === 'PESO (KG)' ? 'Peso del packing list' : 'Corregido por el conductor') : undefined}>
              {typeof v === 'number' ? num(v) : v}{est && <span className="sr-only"> (estimado)</span>}</td> })}
        </tr>)}</tbody></DataTable></div>
        <TablePagination total={pg.total} page={pg.page} pageSize={pg.pageSize} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="paradas" /></div>}
    <p className="text-xs text-slate-500">Celdas en ámbar: dato estimado (km por GPS o peso del packing list) o corregido por el conductor (m³ %). Pase el cursor o el lector de pantalla para ver la fuente.</p>
  </div>
}
