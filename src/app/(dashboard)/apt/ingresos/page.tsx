'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Download, Filter, Loader2, PackagePlus, RotateCcw, Search, X } from 'lucide-react'
import { aptApi, type AptIngresoFilters, type AptIngresos } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtInt, fmtTn } from '@/lib/apt/format'
import { EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'

// Reporte de ingresos APT (ENTRADA · P/E Producción): OT, lote, cliente, glosa y cantidad.
// «Resumen» agrupa por lote y glosa; «Detalle» muestra cada ingreso con su fecha y documento.
// Los filtros de las tablas (fila bajo los encabezados) se aplican en el servidor: totales, páginas y Excel cuadran.

const PAGE = 200
const SIN_CLIENTE = '(Sin cliente identificado)'
type ColumnKey = 'ot' | 'lote' | 'cliente' | 'glosa' | 'documento'
const COLUMN_LABEL: Record<ColumnKey, string> = { ot: 'OT', lote: 'Lote', cliente: 'Cliente', glosa: 'Glosa / producto', documento: 'Documento' }
const qty = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 }).format(Number(v)))
const kg = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(v)))
const input = 'min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm'
const cellInput = 'h-8 w-full min-w-20 rounded-md border border-slate-300 bg-white px-2 text-xs font-normal text-slate-700 placeholder:text-slate-400'

export default function AptIngresosPage() {
  const [period, setPeriod] = useState<{ desde?: string; hasta?: string }>({})
  const [periodDraft, setPeriodDraft] = useState<{ desde?: string; hasta?: string }>({})
  // Filtros de columna: lo que se escribe (columns) se aplica tras una pausa breve (applied)
  const [columns, setColumns] = useState<Partial<Record<ColumnKey, string>>>({})
  const [applied, setApplied] = useState<Partial<Record<ColumnKey, string>>>({})
  const [sinCliente, setSinCliente] = useState(false)
  const [vista, setVista] = useState<'resumen' | 'detalle'>('resumen')
  const [page, setPage] = useState(0)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{ key: string; data?: AptIngresos; error?: string } | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const timer = window.setTimeout(() => { setApplied(columns); setPage(0) }, 400)
    return () => window.clearTimeout(timer)
  }, [columns])

  const filters: AptIngresoFilters = { ...period, ...applied, sin_cliente: sinCliente || undefined }
  const key = JSON.stringify([filters, vista, page, nonce])
  useEffect(() => {
    let alive = true
    const query: AptIngresoFilters = JSON.parse(key)[0]
    aptApi.ingresos(query, vista, PAGE, page * PAGE)
      .then(data => { if (alive) setState({ key, data }) })
      .catch(error => { if (alive) setState(prev => ({ key, data: prev?.data, error: error instanceof Error ? error.message : String(error) })) })
    return () => { alive = false }
  }, [key, vista, page])

  // Se conserva la última respuesta mientras se recalcula: la tabla y sus filtros no desaparecen al escribir
  const d = state?.data
  const loading = state?.key !== key
  const error = !loading ? state?.error : undefined
  const desde = periodDraft.desde ?? d?.desde ?? ''
  const hasta = periodDraft.hasta ?? d?.hasta ?? ''
  const applyPeriod = (event?: React.FormEvent) => { event?.preventDefault(); setPage(0); setPeriod({ desde: desde || undefined, hasta: hasta || undefined }) }
  const setColumn = (k: ColumnKey, value: string) => setColumns(prev => ({ ...prev, [k]: value }))
  const active = (Object.keys(COLUMN_LABEL) as ColumnKey[]).filter(k => applied[k]?.trim())
  const clearColumns = () => { setColumns({}); setApplied({}); setSinCliente(false); setPage(0) }
  const reset = () => { setPeriodDraft({}); setPeriod({}); clearColumns() }
  const pickCliente = (cliente: string) => {
    if (cliente === SIN_CLIENTE) { setSinCliente(true); setColumns(prev => ({ ...prev, cliente: '' })); setApplied(prev => ({ ...prev, cliente: '' })) }
    else { setSinCliente(false); setColumns(prev => ({ ...prev, cliente })); setApplied(prev => ({ ...prev, cliente })) }
    setPage(0)
  }
  const pages = d ? Math.max(1, Math.ceil(d.totales.filas / PAGE)) : 1

  const exportXlsx = useCallback(async () => {
    if (!d || exporting) return
    setExporting(true)
    try {
      const query: AptIngresoFilters = JSON.parse(key)[0]
      const [resumen, detalle] = await Promise.all([aptApi.ingresos(query, 'resumen', 20000, 0), aptApi.ingresos(query, 'detalle', 20000, 0)])
      exportAptXlsx(`ingresos-apt-${d.desde}-a-${d.hasta}`, {
        'Resumen por lote y glosa': resumen.rows.map(r => ({ OT: r.ot, Lote: r.lote, Cliente: r.cliente, Producto: r.producto, Glosa: r.glosa, Cantidad: r.cantidad, Unidad: r.unidad, 'Peso (kg)': r.kg, Ingresos: r.ingresos, 'Primer ingreso': r.primera, 'Último ingreso': r.ultima })),
        'Detalle de ingresos': detalle.rows.map(r => ({ Fecha: r.fecha, Documento: r.documento, OT: r.ot, Lote: r.lote, Cliente: r.cliente, Producto: r.producto, Glosa: r.glosa, Cantidad: r.cantidad, Unidad: r.unidad, 'Peso (kg)': r.kg })),
        'Por cliente': resumen.clientes.map(c => ({ Cliente: c.cliente, OT: c.ots, Lotes: c.lotes, Cantidad: c.cantidad, TN: c.tn })),
      })
      if (resumen.totales.filas > 20000 || detalle.totales.filas > 20000) toast.warning('El Excel incluye las primeras 20 000 filas; acote el período para el resto.')
    } catch (err) { toast.error(err instanceof Error ? err.message : 'No se pudo exportar') } finally { setExporting(false) }
  }, [d, exporting, key])

  const filterCell = (k: ColumnKey, placeholder: string) => <th className="px-2 pb-2 pt-0 font-normal">
    <input value={columns[k] ?? ''} onChange={e => setColumn(k, e.target.value)} placeholder={placeholder} aria-label={`Filtrar por ${COLUMN_LABEL[k]}`} className={cellInput} />
  </th>

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold text-[#002855]"><PackagePlus className="h-5 w-5" />Ingresos APT</h2>
        <p className="text-xs text-slate-500">Ingresos de producción (P/E Producción) por OT, lote, cliente y glosa.{d ? ` Datos cargados del ${fmtDate(d.min)} al ${fmtDate(d.max)}.` : ''}</p>
      </div>
      <button type="button" onClick={() => void exportXlsx()} disabled={!d || exporting || !d.totales.ingresos} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white disabled:opacity-40">{exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Exportar Excel (con filtros)</button>
    </div>

    <form onSubmit={applyPeriod} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3">
      <label className="text-xs text-slate-600">Desde<input type="date" value={desde} onChange={e => setPeriodDraft({ ...periodDraft, desde: e.target.value })} className={input} /></label>
      <label className="text-xs text-slate-600">Hasta<input type="date" value={hasta} onChange={e => setPeriodDraft({ ...periodDraft, hasta: e.target.value })} className={input} /></label>
      <button type="submit" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Search className="h-4 w-4" />Consultar período</button>
      <button type="button" onClick={reset} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm text-slate-600"><RotateCcw className="h-4 w-4" />Restablecer todo</button>
      {loading && d && <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" />Actualizando…</span>}
    </form>

    {(active.length > 0 || sinCliente) && <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1 font-semibold text-slate-600"><Filter className="h-3.5 w-3.5" />Filtros aplicados:</span>
      {active.map(k => <button key={k} type="button" onClick={() => { setColumns(prev => ({ ...prev, [k]: '' })); setApplied(prev => ({ ...prev, [k]: '' })); setPage(0) }} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2.5 py-1 font-medium text-blue-900 ring-1 ring-blue-200 hover:bg-blue-100">{COLUMN_LABEL[k]}: {applied[k]}<X className="h-3 w-3" /></button>)}
      {sinCliente && <button type="button" onClick={() => { setSinCliente(false); setPage(0) }} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-1 font-medium text-amber-900 ring-1 ring-amber-200 hover:bg-amber-100">Solo sin cliente<X className="h-3 w-3" /></button>}
      <button type="button" onClick={clearColumns} className="font-semibold text-slate-600 underline">Quitar filtros</button>
    </div>}

    {!d ? (error ? <ErrorBlock message={error} onRetry={() => setNonce(n => n + 1)} /> : <LoadingBlock label="Consultando ingresos…" className="h-72" />) : <>
      {error && <ErrorBlock message={error} onRetry={() => setNonce(n => n + 1)} />}
      <div className={`grid grid-cols-2 gap-3 lg:grid-cols-5 ${loading ? 'opacity-60' : ''}`}>
        <KpiCard label="Ingresado" value={fmtTn(d.totales.tn)} unit="TN" tone="navy" hint={`${fmtDate(d.desde)} – ${fmtDate(d.hasta)}`} />
        <KpiCard label="Cantidad" value={qty(d.totales.cantidad)} unit="und" hint={`${fmtInt(d.totales.ingresos)} ingresos`} />
        <KpiCard label="OT" value={fmtInt(d.totales.ots)} hint={`${fmtInt(d.totales.lotes)} lotes`} />
        <KpiCard label="Clientes" value={fmtInt(d.totales.clientes)} />
        <KpiCard label="Sin cliente identificado" value={fmtTn(d.totales.sin_cliente_tn)} unit="TN" tone={d.totales.sin_cliente_tn > 0 ? 'warn' : 'ok'} hint="Clic para ver solo esos lotes" onClick={() => { setSinCliente(true); setPage(0) }} active={sinCliente} />
      </div>

      <details className="rounded-xl border border-slate-200 bg-white" open>
        <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-[#002855]">Ingresos por cliente <span className="font-normal text-slate-500">· clic en un cliente para filtrar</span></summary>
        <div className={`overflow-x-auto border-t border-slate-100 ${loading ? 'opacity-60' : ''}`}><table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr><th className="px-3 py-2 text-left">Cliente</th><th className="px-3 py-2 text-right">OT</th><th className="px-3 py-2 text-right">Lotes</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">TN</th></tr>
            <tr>{filterCell('cliente', 'Buscar cliente…')}<th colSpan={4} /></tr>
          </thead>
          <tbody>
            {!d.clientes.length && <tr><td colSpan={5} className="px-3 py-4 text-center text-xs text-slate-500">Sin clientes para estos filtros.</td></tr>}
            {d.clientes.map(c => <tr key={c.cliente} className="border-t border-slate-100">
              <td className={`px-3 py-2 ${c.cliente === SIN_CLIENTE ? 'italic text-amber-800' : 'font-medium text-slate-800'}`}><button type="button" onClick={() => pickCliente(c.cliente)} className="text-left hover:underline">{c.cliente}</button></td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtInt(c.ots)}</td><td className="px-3 py-2 text-right tabular-nums">{fmtInt(c.lotes)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{qty(c.cantidad)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtTn(c.tn)}</td>
            </tr>)}
          </tbody>
        </table></div>
      </details>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div className="inline-flex rounded-lg bg-slate-100 p-1" role="tablist">
            {([['resumen', 'Resumen por lote y glosa'], ['detalle', 'Detalle por ingreso']] as const).map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={vista === v} onClick={() => { setVista(v); setPage(0) }} className={`min-h-9 rounded-md px-3 text-xs font-semibold ${vista === v ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-600'}`}>{label}</button>)}
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-600">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={sinCliente} onChange={e => { setSinCliente(e.target.checked); setPage(0) }} className="h-4 w-4 rounded border-slate-300" />Solo sin cliente</label>
            <span className="text-slate-500">{fmtInt(d.totales.filas)} filas</span>
          </div>
        </div>
        <div className={`overflow-x-auto ${loading ? 'opacity-60' : ''}`}><table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              {vista === 'detalle' && <th className="px-3 py-2 text-left">Fecha</th>}
              <th className="px-3 py-2 text-left">OT</th><th className="px-3 py-2 text-left">Lote</th><th className="px-3 py-2 text-left">Cliente</th><th className="px-3 py-2 text-left">Glosa</th>
              <th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">Peso (kg)</th>
              {vista === 'resumen' ? <th className="px-3 py-2 text-left">Ingresó</th> : <th className="px-3 py-2 text-left">Documento</th>}
            </tr>
            <tr>
              {vista === 'detalle' && <th />}
              {filterCell('ot', '16533')}{filterCell('lote', 'S001')}{filterCell('cliente', 'Razón social')}{filterCell('glosa', 'Poste, marco…')}
              <th /><th />
              {vista === 'detalle' ? filterCell('documento', 'N.° documento') : <th />}
            </tr>
          </thead>
          <tbody>
            {!d.rows.length && <tr><td colSpan={8} className="px-3 py-8"><EmptyState title="Sin ingresos para estos filtros"><button type="button" onClick={clearColumns} className="font-semibold text-[#002855] underline">Quitar filtros</button>{' · '}<Link href="/apt/cargas" className="font-semibold text-[#002855] underline">Revisar cargas</Link></EmptyState></td></tr>}
            {d.rows.map((r, i) => <tr key={`${r.lote}-${r.producto}-${r.fecha ?? ''}-${i}`} className="border-t border-slate-100 align-top">
              {vista === 'detalle' && <td className="whitespace-nowrap px-3 py-2">{fmtDate(r.fecha)}</td>}
              <td className="whitespace-nowrap px-3 py-2 font-semibold text-[#002855]">{r.ot}</td>
              <td className="whitespace-nowrap px-3 py-2"><Link href={`/apt/lote/${encodeURIComponent(r.lote)}`} className="hover:underline">{r.lote}</Link></td>
              <td className={`min-w-40 px-3 py-2 ${r.cliente === SIN_CLIENTE ? 'italic text-amber-800' : ''}`}>{r.cliente}</td>
              <td className="min-w-64 px-3 py-2">{r.glosa || '—'}<span className="block text-[11px] text-slate-400">{r.producto}</span></td>
              <td className="whitespace-nowrap px-3 py-2 text-right font-semibold tabular-nums">{qty(r.cantidad)} <span className="text-xs font-normal text-slate-500">{r.unidad || ''}</span></td>
              <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{kg(r.kg)}</td>
              {vista === 'resumen'
                ? <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">{r.primera === r.ultima ? fmtDate(r.primera) : `${fmtDate(r.primera)} – ${fmtDate(r.ultima)}`}{(r.ingresos ?? 0) > 1 && <span className="block text-slate-400">{r.ingresos} ingresos</span>}</td>
                : <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-600">{r.documento || '—'}</td>}
            </tr>)}
          </tbody>
        </table></div>
        {pages > 1 && <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-600">
          <button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)} aria-label="Página anterior" className="rounded-lg border border-slate-300 p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
          Página {page + 1} de {pages}
          <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)} aria-label="Página siguiente" className="rounded-lg border border-slate-300 p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
        </div>}
      </div>
    </>}
  </div>
}
