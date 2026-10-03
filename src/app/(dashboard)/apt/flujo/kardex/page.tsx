'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ArrowDownLeft, ArrowUpRight, BookOpenCheck, ChevronLeft, ChevronRight, Download, Filter, Layers, RotateCcw, Scale, Search } from 'lucide-react'
import { aptApi, cleanFilters, flowApi } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtInt, fmtTn } from '@/lib/apt/format'
import { ALMACEN_LABEL, KARDEX_TIPO_LABEL, type FlowAlmacen, type Kardex, type KardexFilters, type KardexNivel, type KardexRow, type KardexTipo } from '@/lib/apt/flowTypes'
import { ALMACEN_COLOR, FLOW_ALMACENES } from '@/lib/apt/flowColors'
import type { AptFilterOptions } from '@/lib/apt/types'
import { KpiCard, LoadingBlock, ErrorBlock, EmptyState } from '@/components/apt/ui'
import { MultiSelect } from '@/components/apt/AptFilterBar'
import { GuiaDetalleModal } from '@/components/guias/GuiaDetalleModal'

// Kardex de trazabilidad: cada movimiento del ERP en orden cronológico con su saldo acumulado por lote y producto
// (o por producto, lote o total), por almacén o consolidado. Filtros en la URL (?k=, ?n=, ?a=, ?pg=) para compartir.

const PAGE = 500
const TIPOS: KardexTipo[] = ['PRODUCCION', 'TRASPASO_ENT', 'TRASPASO_SAL', 'DESPACHO', 'CONSUMO', 'DEVOLUCION', 'INICIAL']
const TIPO_STYLE: Record<KardexTipo, string> = {
  INICIAL: 'bg-slate-100 text-slate-600 border-slate-200',
  PRODUCCION: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  TRASPASO_ENT: 'bg-sky-50 text-sky-700 border-sky-200',
  TRASPASO_SAL: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  DESPACHO: 'bg-blue-50 text-blue-700 border-blue-200',
  CONSUMO: 'bg-purple-50 text-purple-700 border-purple-200',
  DEVOLUCION: 'bg-amber-50 text-amber-700 border-amber-200',
}
const NIVELES: Array<{ k: KardexNivel; label: string; hint: string }> = [
  { k: 'lote_producto', label: 'Lote + SKU', hint: 'Kardex clásico: un saldo por producto de cada lote' },
  { k: 'producto', label: 'SKU', hint: 'Saldo por producto, sumando todos sus lotes' },
  { k: 'lote', label: 'Lote', hint: 'Saldo en kg del lote (todos sus productos)' },
  { k: 'total', label: 'Total', hint: 'Un solo saldo en kg con todo lo filtrado' },
]
const qf = (v: number | null | undefined) => (v === null || v === undefined ? '' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 }).format(Number(v)))
const kgf = (v: number | null | undefined) => (v === null || v === undefined ? '' : new Intl.NumberFormat('es-PE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Number(v)))

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) as T } catch { return fallback }
}

function KardexPage() {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const filters = useMemo(() => parse<KardexFilters>(sp.get('k'), {}), [sp])
  const nivel = (sp.get('n') as KardexNivel) || 'lote_producto'
  const porAlmacen = sp.get('a') !== '0'
  const page = Math.max(0, Number(sp.get('pg') || 0))
  const key = sp.toString()

  const go = useCallback((next: { k?: KardexFilters; n?: KardexNivel; a?: boolean; pg?: number }) => {
    const qs = new URLSearchParams(sp.toString())
    if (next.k !== undefined) {
      const c = cleanFilters(next.k)
      if (Object.keys(c).length) qs.set('k', JSON.stringify(c)); else qs.delete('k')
      qs.delete('pg')
    }
    if (next.n !== undefined) { qs.set('n', next.n); qs.delete('pg') }
    if (next.a !== undefined) { qs.set('a', next.a ? '1' : '0'); qs.delete('pg') }
    if (next.pg !== undefined) { if (next.pg > 0) qs.set('pg', String(next.pg)); else qs.delete('pg') }
    router.replace(`${pathname}?${qs.toString()}`, { scroll: false })
  }, [pathname, router, sp])

  const [res, setRes] = useState<{ key: string; data?: Kardex; error?: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    flowApi.kardex(filters, nivel, porAlmacen, PAGE, page * PAGE)
      .then(d => { if (alive) setRes({ key, data: d }) })
      .catch(e => { if (alive) setRes({ key, error: e instanceof Error ? e.message : 'No se pudo calcular el kardex' }) })
    return () => { alive = false }
  }, [key, nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const [opts, setOpts] = useState<AptFilterOptions | null>(null)
  useEffect(() => { aptApi.filterOptions().then(setOpts).catch(() => setOpts(null)) }, [])
  const [guia, setGuia] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const data = res?.data
  const loading = !res || res.key !== key

  const exportar = async () => {
    setExporting(true)
    try {
      const all = await flowApi.kardex(filters, nivel, porAlmacen, 20000, 0)
      exportAptXlsx(`Kardex_${filters.lote_exacto || filters.lote || filters.ot || 'APT'}_${all.desde}_${all.hasta}`, {
        Kardex: all.filas.map(r => ({
          Clave: r.clave, Fecha: r.fecha, Movimiento: KARDEX_TIPO_LABEL[r.tipo], Documento: r.documento, 'Tipo doc.': r.tipodocto,
          Almacén: r.almacen, 'Origen / destino': r.contraparte, Lote: r.lote, 'Lote relacionado': r.lote_rel, Producto: r.producto,
          Glosa: r.glosa, Cliente: r.cliente, NumRel: r.numrel, Unidad: r.unidad, 'Cant. entrada': r.cant_in, 'Cant. salida': r.cant_out,
          'Saldo cant.': r.saldo_cant, 'Kg entrada': r.kg_in, 'Kg salida': r.kg_out, 'Saldo kg': r.saldo_kg,
        })),
        Resumen: all.almacenes.map(a => ({ Almacén: ALMACEN_LABEL[a.almacen], 'Saldo inicial TN': a.inicial_tn, 'Entradas TN': a.entradas_tn,
          'Salidas TN': a.salidas_tn, 'Saldo final TN': a.saldo_tn })),
      })
    } finally { setExporting(false) }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-black text-slate-900"><BookOpenCheck className="h-5 w-5 text-[#002855]" /> Kardex de trazabilidad</h2>
          <p className="text-xs text-slate-500">Cada movimiento del ERP (producción, traspasos, guías, consumos, devoluciones) con su saldo acumulado. El saldo
            inicial incluye el stock previo inferido y los movimientos anteriores al periodo.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setNonce(n => n + 1)} className="h-9 rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600 hover:bg-slate-50">Actualizar</button>
          <button type="button" onClick={exportar} disabled={exporting || !data}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-emerald-600 px-3 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-50">
            <Download className="h-3.5 w-3.5" /> {exporting ? 'Exportando…' : 'Excel (hasta 20 000 filas)'}
          </button>
        </div>
      </div>

      <FiltersPanel key={sp.get('k') || ''} filters={filters} opts={opts} onApply={k => go({ k })} />

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-slate-400"><Layers className="h-3.5 w-3.5" /> Saldo por</span>
        <div className="flex rounded-lg border border-slate-200 p-0.5">
          {NIVELES.map(n => (
            <button key={n.k} type="button" title={n.hint} onClick={() => go({ n: n.k })}
              className={`rounded-md px-3 py-1.5 text-xs font-bold ${nivel === n.k ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{n.label}</button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-slate-600">
          <input type="checkbox" checked={porAlmacen} onChange={e => go({ a: e.target.checked })} className="h-4 w-4 accent-[#002855]" />
          Separar por almacén
        </label>
        <span className="text-[11px] text-slate-400">{porAlmacen ? 'Cada almacén lleva su propio saldo.' : 'Consolidado 647 + 540 + ST: un traspaso entre ellos suma cero.'}</span>
      </div>

      {loading && !data ? <LoadingBlock label="Calculando kardex…" className="h-80" /> : res?.error ? (
        <ErrorBlock message={res.error} onRetry={() => setNonce(n => n + 1)} />
      ) : data ? (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="Saldo inicial" value={fmtTn(data.resumen.saldo_inicial_tn)} unit="TN" hint={`Al ${fmtDate(data.desde)} (incluye stock previo)`} />
            <KpiCard label="Entradas" value={fmtTn(data.resumen.entradas_tn)} unit="TN" tone="ok" icon={<ArrowDownLeft className="h-4 w-4" />} hint="Producción, traspasos recibidos, devoluciones" />
            <KpiCard label="Salidas" value={fmtTn(data.resumen.salidas_tn)} unit="TN" tone="warn" icon={<ArrowUpRight className="h-4 w-4" />} hint="Guías, traspasos enviados, consumos" />
            <KpiCard label="Saldo final" value={fmtTn(data.resumen.saldo_final_tn)} unit="TN" tone="navy" icon={<Scale className="h-4 w-4" />} hint={`Al ${fmtDate(data.hasta)}`} />
            <KpiCard label="Movimientos" value={fmtInt(data.resumen.movimientos)} hint={`${fmtInt(data.resumen.lotes)} lotes · ${fmtInt(data.resumen.guias)} guías`} />
            <KpiCard label="Saldos negativos" value={fmtInt(data.resumen.claves_negativas)} tone={data.resumen.claves_negativas ? 'crit' : 'ok'}
              hint={data.resumen.claves_negativas ? 'Falta un ingreso o el stock previo' : 'Todo cuadra'} />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {data.almacenes.map(a => (
              <button key={a.almacen} type="button" onClick={() => go({ k: { ...filters, almacenes: filters.almacenes?.length === 1 && filters.almacenes[0] === a.almacen ? undefined : [a.almacen] } })}
                className="rounded-xl border bg-white p-3 text-left shadow-sm transition-shadow hover:shadow-md"
                style={{ borderColor: `${ALMACEN_COLOR[a.almacen]}55`, boxShadow: filters.almacenes?.includes(a.almacen) ? `0 0 0 2px ${ALMACEN_COLOR[a.almacen]}` : undefined }}>
                <p className="text-[11px] font-black uppercase tracking-wider" style={{ color: ALMACEN_COLOR[a.almacen] }}>{ALMACEN_LABEL[a.almacen]}</p>
                <div className="mt-1 grid grid-cols-4 gap-1 text-[11px] tabular-nums">
                  <div><p className="text-slate-400">Inicial</p><p className="font-bold text-slate-700">{fmtTn(a.inicial_tn)}</p></div>
                  <div><p className="text-slate-400">Entradas</p><p className="font-bold text-emerald-700">+{fmtTn(a.entradas_tn)}</p></div>
                  <div><p className="text-slate-400">Salidas</p><p className="font-bold text-amber-700">−{fmtTn(a.salidas_tn)}</p></div>
                  <div><p className="text-slate-400">Saldo</p><p className="font-black text-[#002855]">{fmtTn(a.saldo_tn)}</p></div>
                </div>
              </button>
            ))}
          </div>

          {data.filas.length === 0 ? (
            <EmptyState title="Sin movimientos con estos filtros">Amplíe el periodo o quite algún filtro.</EmptyState>
          ) : (
            <KardexTable rows={data.filas} nivel={nivel} onGuia={setGuia} />
          )}

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Filas {fmtInt(data.offset + 1)}–{fmtInt(Math.min(data.offset + data.filas.length, data.total))} de {fmtInt(data.total)} · periodo {fmtDate(data.desde)} – {fmtDate(data.hasta)}</span>
            <div className="flex items-center gap-1">
              <button type="button" disabled={page === 0} onClick={() => go({ pg: page - 1 })} className="rounded-lg border border-slate-200 p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
              <span className="px-2">Página {page + 1} de {Math.max(1, Math.ceil(data.total / PAGE))}</span>
              <button type="button" disabled={(page + 1) * PAGE >= data.total} onClick={() => go({ pg: page + 1 })} className="rounded-lg border border-slate-200 p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
            </div>
          </div>
        </div>
      ) : null}
      <GuiaDetalleModal key={guia || 'none'} guias={guia} onClose={() => setGuia(null)} />
    </div>
  )
}

function FiltersPanel({ filters, opts, onApply }: { filters: KardexFilters; opts: AptFilterOptions | null; onApply: (f: KardexFilters) => void }) {
  const [f, setF] = useState<KardexFilters>(filters)
  const set = (patch: Partial<KardexFilters>) => setF(x => ({ ...x, ...patch }))
  const toggle = <T extends string>(arr: T[] | undefined, v: T) => (arr?.includes(v) ? arr.filter(x => x !== v) : [...(arr || []), v])
  const input = (k: 'lote' | 'lote_exacto' | 'ot' | 'producto' | 'glosa' | 'documento', label: string, ph: string, w = 'w-40') => (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      <input value={f[k] || ''} onChange={e => set({ [k]: e.target.value || undefined })} placeholder={ph}
        className={`h-9 ${w} rounded-lg border border-slate-200 px-2 text-xs outline-none focus:border-[#002855]`} />
    </label>
  )
  return (
    <form onSubmit={e => { e.preventDefault(); onApply(f) }} className="space-y-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        <span className="flex items-center gap-1.5 self-center text-[11px] font-black uppercase tracking-wider text-slate-400"><Filter className="h-3.5 w-3.5" /> Filtros</span>
        {input('lote_exacto', 'Lote exacto', '16339-S001')}
        {input('lote', 'Lote contiene', '16339')}
        {input('ot', 'OT / contrato', '16339', 'w-28')}
        {input('producto', 'Producto (SKU)', 'RAPO.20…')}
        {input('glosa', 'Descripción', 'POSTE…')}
        {input('documento', 'Documento / guía', 'T001-…')}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Desde</span>
          <input type="date" value={f.desde || ''} onChange={e => set({ desde: e.target.value || undefined })} className="h-9 rounded-lg border border-slate-200 px-2 text-xs" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Hasta</span>
          <input type="date" value={f.hasta || ''} onChange={e => set({ hasta: e.target.value || undefined })} className="h-9 rounded-lg border border-slate-200 px-2 text-xs" />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Cliente</span>
          <MultiSelect label="Cliente" options={(opts?.clientes || []).map(c => c.cliente)} value={f.clientes} searchable width="w-80" onChange={v => set({ clientes: v })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Almacén</span>
        {FLOW_ALMACENES.map(a => (
          <button key={a} type="button" onClick={() => set({ almacenes: toggle<FlowAlmacen>(f.almacenes, a) })}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${f.almacenes?.includes(a) ? 'text-white' : 'bg-white text-slate-600'}`}
            style={f.almacenes?.includes(a) ? { background: ALMACEN_COLOR[a], borderColor: ALMACEN_COLOR[a] } : { borderColor: '#e2e8f0' }}>{ALMACEN_LABEL[a]}</button>
        ))}
        <span className="ml-3 text-[10px] font-bold uppercase tracking-wider text-slate-400">Movimiento</span>
        {TIPOS.map(t => (
          <button key={t} type="button" onClick={() => set({ tipos: toggle<KardexTipo>(f.tipos, t) })}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-bold ${f.tipos?.includes(t) ? TIPO_STYLE[t] + ' ring-2 ring-offset-1 ring-[#002855]/30' : 'border-slate-200 bg-white text-slate-500'}`}>
            {KARDEX_TIPO_LABEL[t]}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={() => { setF({}); onApply({}) }} className="inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50">
            <RotateCcw className="h-3.5 w-3.5" /> Limpiar
          </button>
          <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#002855] px-4 text-xs font-bold text-white hover:bg-[#0b3d7a]">
            <Search className="h-3.5 w-3.5" /> Aplicar
          </button>
        </div>
      </div>
    </form>
  )
}

function KardexTable({ rows, nivel, onGuia }: { rows: KardexRow[]; nivel: KardexNivel; onGuia: (g: string) => void }) {
  const showCant = nivel === 'lote_producto' || nivel === 'producto'
  // Encabezado de grupo cada vez que cambia la clave del saldo
  const items: Array<{ head: string; antes: number } | KardexRow> = []
  let prev = ''
  rows.forEach(r => {
    if (nivel !== 'total' && r.clave !== prev) { items.push({ head: r.clave, antes: r.saldo_kg_antes }); prev = r.clave }
    items.push(r)
  })
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[1400px] text-xs">
        <thead className="sticky top-0 z-10 bg-slate-50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
          <tr className="border-b border-slate-200">
            <th className="px-3 py-2 text-left">Fecha</th>
            <th className="px-3 py-2 text-left">Movimiento</th>
            <th className="px-3 py-2 text-left">Documento</th>
            <th className="px-3 py-2 text-left">Almacén</th>
            <th className="px-3 py-2 text-left">Origen / destino</th>
            <th className="px-3 py-2 text-left">Lote</th>
            <th className="px-3 py-2 text-left">Producto</th>
            <th className="px-3 py-2 text-left">Descripción</th>
            <th className="px-3 py-2 text-left">Cliente</th>
            {showCant && <><th className="px-3 py-2 text-right">Entrada</th><th className="px-3 py-2 text-right">Salida</th><th className="px-3 py-2 text-right">Saldo</th><th className="px-2 py-2 text-left">Und</th></>}
            <th className="px-3 py-2 text-right">Kg entrada</th>
            <th className="px-3 py-2 text-right">Kg salida</th>
            <th className="px-3 py-2 text-right">Saldo kg</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((it, i) => 'head' in it ? (
            <tr key={`h-${i}`} className="bg-[#002855]/5">
              <td colSpan={showCant ? 16 : 12} className="px-3 py-1.5 text-[11px] font-black text-[#002855]">
                {it.head} <span className="ml-2 font-semibold text-slate-500">saldo anterior {kgf(it.antes)} kg</span>
              </td>
            </tr>
          ) : (
            <tr key={it.id} className={`hover:bg-slate-50 ${it.saldo_kg < -0.5 ? 'bg-red-50/60' : ''}`}>
              <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-slate-600">{fmtDate(it.fecha)}</td>
              <td className="px-3 py-1.5"><span className={`whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-bold ${TIPO_STYLE[it.tipo]}`}>{KARDEX_TIPO_LABEL[it.tipo]}</span></td>
              <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                {it.tipo === 'DESPACHO' && it.documento
                  ? <button type="button" onClick={() => onGuia(it.documento!)} className="font-semibold text-blue-700 hover:underline">{it.documento}</button>
                  : <span className="text-slate-600">{it.documento || '—'}</span>}
              </td>
              <td className="px-3 py-1.5"><span className="font-bold" style={{ color: ALMACEN_COLOR[it.almacen] }}>{it.almacen}</span></td>
              <td className="whitespace-nowrap px-3 py-1.5 text-slate-500">
                {it.contraparte ? <>{it.tipo === 'TRASPASO_SAL' ? '→ ' : '← '}{it.contraparte}</> : '—'}
                {it.lote_rel && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700">lote {it.lote_rel}</span>}
              </td>
              <td className="whitespace-nowrap px-3 py-1.5"><Link href={`/apt/flujo/trazabilidad?q=${encodeURIComponent(it.lote)}`} className="font-mono font-semibold text-[#002855] hover:underline">{it.lote}</Link></td>
              <td className="whitespace-nowrap px-3 py-1.5 font-mono text-slate-700">{it.producto}</td>
              <td className="max-w-[260px] truncate px-3 py-1.5 text-slate-600" title={it.glosa || ''}>{it.glosa || '—'}</td>
              <td className="max-w-[180px] truncate px-3 py-1.5 text-slate-500" title={it.cliente || ''}>{it.cliente || '—'}</td>
              {showCant && <>
                <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{qf(it.cant_in)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-amber-700">{qf(it.cant_out)}</td>
                <td className="px-3 py-1.5 text-right font-semibold tabular-nums text-slate-800">{qf(it.saldo_cant)}</td>
                <td className="px-2 py-1.5 text-slate-400">{it.unidad || ''}</td>
              </>}
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-700">{kgf(it.kg_in)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-amber-700">{kgf(it.kg_out)}</td>
              <td className={`px-3 py-1.5 text-right font-black tabular-nums ${it.saldo_kg < -0.5 ? 'text-red-600' : 'text-[#002855]'}`}>{kgf(it.saldo_kg)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function KardexRoute() {
  return <Suspense fallback={<LoadingBlock className="h-80" />}><KardexPage /></Suspense>
}
