'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Download, Loader2, PackagePlus, RotateCcw, Search } from 'lucide-react'
import { aptApi, type AptIngresoFilters, type AptIngresos } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtInt, fmtTn } from '@/lib/apt/format'
import { EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'

// Reporte de ingresos APT (ENTRADA · P/E Producción): OT, lote, cliente, glosa y cantidad.
// «Resumen» agrupa por lote y glosa; «Detalle» muestra cada ingreso con su fecha y documento.

const PAGE = 200
const SIN_CLIENTE = '(Sin cliente identificado)'
const qty = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 }).format(Number(v)))
const kg = (v: number | null | undefined) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(v)))
const input = 'min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm'

export default function AptIngresosPage() {
  const [draft, setDraft] = useState<AptIngresoFilters>({})
  const [filters, setFilters] = useState<AptIngresoFilters>({})
  const [vista, setVista] = useState<'resumen' | 'detalle'>('resumen')
  const [page, setPage] = useState(0)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState<{ key: string; data?: AptIngresos; error?: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const key = JSON.stringify([filters, vista, page, nonce])

  useEffect(() => {
    let alive = true
    aptApi.ingresos(filters, vista, PAGE, page * PAGE)
      .then(data => { if (alive) setState({ key, data }) })
      .catch(error => { if (alive) setState({ key, error: error instanceof Error ? error.message : String(error) }) })
    return () => { alive = false }
  }, [filters, vista, page, nonce, key])

  const current = state?.key === key ? state : null
  const d = current?.data
  // El período por defecto lo decide el servidor (mes del último ingreso): se muestra en los campos de fecha
  const desde = draft.desde ?? d?.desde ?? ''
  const hasta = draft.hasta ?? d?.hasta ?? ''
  const apply = (event?: React.FormEvent) => { event?.preventDefault(); setPage(0); setFilters({ ...draft, desde: desde || undefined, hasta: hasta || undefined }) }
  const reset = () => { setDraft({}); setFilters({}); setPage(0) }
  const pages = d ? Math.max(1, Math.ceil(d.totales.filas / PAGE)) : 1

  const exportXlsx = useCallback(async () => {
    if (!d || exporting) return
    setExporting(true)
    try {
      const [resumen, detalle] = await Promise.all([aptApi.ingresos(filters, 'resumen', 20000, 0), aptApi.ingresos(filters, 'detalle', 20000, 0)])
      exportAptXlsx(`ingresos-apt-${d.desde}-a-${d.hasta}`, {
        'Resumen por lote y glosa': resumen.rows.map(r => ({ OT: r.ot, Lote: r.lote, Cliente: r.cliente, Producto: r.producto, Glosa: r.glosa, Cantidad: r.cantidad, Unidad: r.unidad, 'Peso (kg)': r.kg, Ingresos: r.ingresos, 'Primer ingreso': r.primera, 'Último ingreso': r.ultima })),
        'Detalle de ingresos': detalle.rows.map(r => ({ Fecha: r.fecha, Documento: r.documento, OT: r.ot, Lote: r.lote, Cliente: r.cliente, Producto: r.producto, Glosa: r.glosa, Cantidad: r.cantidad, Unidad: r.unidad, 'Peso (kg)': r.kg })),
        'Por cliente': resumen.clientes.map(c => ({ Cliente: c.cliente, OT: c.ots, Lotes: c.lotes, Cantidad: c.cantidad, TN: c.tn })),
      })
      if (resumen.totales.filas > 20000 || detalle.totales.filas > 20000) toast.warning('El Excel incluye las primeras 20 000 filas; acote el período para el resto.')
    } catch (error) { toast.error(error instanceof Error ? error.message : 'No se pudo exportar') } finally { setExporting(false) }
  }, [d, exporting, filters])

  return <div className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-bold text-[#002855]"><PackagePlus className="h-5 w-5" />Ingresos APT</h2>
        <p className="text-xs text-slate-500">Ingresos de producción (P/E Producción) por OT, lote, cliente y glosa.{d ? ` Datos cargados del ${fmtDate(d.min)} al ${fmtDate(d.max)}.` : ''}</p>
      </div>
      <button type="button" onClick={() => void exportXlsx()} disabled={!d || exporting || !d.totales.ingresos} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white disabled:opacity-40">{exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Exportar Excel</button>
    </div>

    <form onSubmit={apply} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-6">
      <label className="text-xs text-slate-600">Desde<input type="date" value={desde} onChange={e => setDraft({ ...draft, desde: e.target.value })} className={input} /></label>
      <label className="text-xs text-slate-600">Hasta<input type="date" value={hasta} onChange={e => setDraft({ ...draft, hasta: e.target.value })} className={input} /></label>
      <label className="text-xs text-slate-600">OT o lote<input value={draft.ot ?? ''} onChange={e => setDraft({ ...draft, ot: e.target.value })} placeholder="16533 o 16533-S001" className={input} /></label>
      <label className="text-xs text-slate-600">Cliente<input value={draft.cliente ?? ''} onChange={e => setDraft({ ...draft, cliente: e.target.value })} placeholder="Razón social" className={input} /></label>
      <label className="text-xs text-slate-600">Glosa o producto<input value={draft.glosa ?? ''} onChange={e => setDraft({ ...draft, glosa: e.target.value })} placeholder="Ej.: poste, marco" className={input} /></label>
      <div className="flex items-end gap-2">
        <button type="submit" className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white"><Search className="h-4 w-4" />Consultar</button>
        <button type="button" onClick={reset} aria-label="Limpiar filtros" className="min-h-10 rounded-lg border border-slate-300 px-3 text-slate-600"><RotateCcw className="h-4 w-4" /></button>
      </div>
    </form>

    {!current ? <LoadingBlock label="Consultando ingresos…" className="h-72" /> : current.error ? <ErrorBlock message={current.error} onRetry={() => setNonce(n => n + 1)} /> : !d || !d.totales.ingresos ? <EmptyState title="Sin ingresos para estos filtros"><Link href="/apt/cargas" className="font-semibold text-[#002855] underline">Revisar cargas</Link></EmptyState> : <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <KpiCard label="Ingresado" value={fmtTn(d.totales.tn)} unit="TN" tone="navy" hint={`${fmtDate(d.desde)} – ${fmtDate(d.hasta)}`} />
        <KpiCard label="Cantidad" value={qty(d.totales.cantidad)} unit="und" hint={`${fmtInt(d.totales.ingresos)} ingresos`} />
        <KpiCard label="OT" value={fmtInt(d.totales.ots)} hint={`${fmtInt(d.totales.lotes)} lotes`} />
        <KpiCard label="Clientes" value={fmtInt(d.totales.clientes)} />
        <KpiCard label="Sin cliente identificado" value={fmtTn(d.totales.sin_cliente_tn)} unit="TN" tone={d.totales.sin_cliente_tn > 0 ? 'warn' : 'ok'} hint="Lote sin guía ni OT en Contratos" />
      </div>

      <details className="rounded-xl border border-slate-200 bg-white" open>
        <summary className="cursor-pointer px-4 py-3 text-sm font-bold text-[#002855]">Ingresos por cliente</summary>
        <div className="overflow-x-auto border-t border-slate-100"><table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr><th className="px-3 py-2 text-left">Cliente</th><th className="px-3 py-2 text-right">OT</th><th className="px-3 py-2 text-right">Lotes</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">TN</th></tr></thead>
          <tbody>{d.clientes.map(c => <tr key={c.cliente} className="border-t border-slate-100">
            <td className={`px-3 py-2 ${c.cliente === SIN_CLIENTE ? 'italic text-amber-800' : 'font-medium text-slate-800'}`}><button type="button" onClick={() => { const next = { ...filters, cliente: c.cliente === SIN_CLIENTE ? SIN_CLIENTE : c.cliente }; setDraft(next); setFilters(next); setPage(0) }} className="text-left hover:underline">{c.cliente}</button></td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtInt(c.ots)}</td><td className="px-3 py-2 text-right tabular-nums">{fmtInt(c.lotes)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{qty(c.cantidad)}</td><td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtTn(c.tn)}</td>
          </tr>)}</tbody>
        </table></div>
      </details>

      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div className="inline-flex rounded-lg bg-slate-100 p-1" role="tablist">
            {([['resumen', 'Resumen por lote y glosa'], ['detalle', 'Detalle por ingreso']] as const).map(([v, label]) => <button key={v} type="button" role="tab" aria-selected={vista === v} onClick={() => { setVista(v); setPage(0) }} className={`min-h-9 rounded-md px-3 text-xs font-semibold ${vista === v ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-600'}`}>{label}</button>)}
          </div>
          <p className="text-xs text-slate-500">{fmtInt(d.totales.filas)} filas</p>
        </div>
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500"><tr>
            {vista === 'detalle' && <th className="px-3 py-2 text-left">Fecha</th>}
            <th className="px-3 py-2 text-left">OT</th><th className="px-3 py-2 text-left">Lote</th><th className="px-3 py-2 text-left">Cliente</th><th className="px-3 py-2 text-left">Glosa</th>
            <th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">Peso (kg)</th>
            {vista === 'resumen' ? <th className="px-3 py-2 text-left">Ingresó</th> : <th className="px-3 py-2 text-left">Documento</th>}
          </tr></thead>
          <tbody>{d.rows.map((r, i) => <tr key={`${r.lote}-${r.producto}-${r.fecha ?? ''}-${i}`} className="border-t border-slate-100 align-top">
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
          </tr>)}</tbody>
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
