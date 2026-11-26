'use client'

import { Fragment, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Download, SlidersHorizontal, X } from 'lucide-react'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { DataTable } from '@/components/ui/data-table'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { fmtN } from '@/lib/inventario/format'
import { fmtDate } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { BODEGAS, FILTRO_INICIAL, buildAvance, filtrarAvance, tn, totalAvance, type AvanceFila, type AvanceFiltro, type AvanceTotal } from '@/lib/inventario/avance-contrato'
import type { InvContratoProducto } from '@/lib/inventario/types'

type Vista = 'both' | 'und' | 'tn'
const q0 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 0 }), q3 = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 })
const t2 = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), t3 = new Intl.NumberFormat('es-PE', { minimumFractionDigits: 3, maximumFractionDigits: 3 })
const Dash = () => <span className="text-slate-300">—</span>
const ESTADO_CLS = { COMPLETO: 'bg-emerald-50 text-emerald-800', PARCIAL: 'bg-amber-50 text-amber-800', PENDIENTE: 'bg-red-50 text-red-700' }
const GRUPOS: Array<[string, string]> = [['Contrato', 'bg-blue-50'], ['Despachado', 'bg-emerald-50'], ['Saldo', 'bg-slate-100'], ['APT 647', 'bg-orange-50'], ['APT 540', 'bg-orange-50'], ['APT ST', 'bg-orange-50'], ['Por producir', 'bg-amber-100']]
const field = 'min-h-9 rounded-lg border border-slate-300 bg-white px-2 text-xs'
const thc = 'sticky z-10 px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-wide text-slate-600'

function Bar({ d, a, c }: { d: number; a: number; c: number }) {
  const p = (x: number) => (c > 0 ? Math.min(100, (x / c) * 100) : 0)
  return <div className="flex h-2 w-20 overflow-hidden rounded-full bg-slate-200" aria-hidden><i className="block h-full bg-[#002855]" style={{ width: `${p(d)}%` }} /><i className="block h-full bg-amber-400" style={{ width: `${p(a)}%` }} /></div>
}

/** Reporte único de la OT: cada ítem del contrato (ERP) con su avance, el saldo en el APT por bodega y lo que falta producir. */
export function AvanceContrato({ q, ot, productos, onKardex }: { q: string; ot: string; productos: InvContratoProducto[]; onKardex?: (producto: string) => void }) {
  const r = useInvQuery(`contrato-lineas|${q}`, () => invApi.contratoLineas(q))
  const [f, setF] = useState<AvanceFiltro>(FILTRO_INICIAL)
  const [vista, setVista] = useState<Vista>('both'), [agrupar, setAgrupar] = useState(true), [avanzado, setAvanzado] = useState(false)
  const [cerrados, setCerrados] = useState<Set<string>>(new Set())
  const todas = useMemo(() => buildAvance(r.data?.lineas ?? [], productos), [r.data, productos])
  const filas = useMemo(() => filtrarAvance(todas, f), [todas, f])
  const lotes = useMemo(() => [...new Set(todas.map(x => x.lote))], [todas])
  if (r.loading) return <LoadingBlock label="Cargando ítems del contrato…" />
  if (r.error) return <ErrorBlock message={r.error} onRetry={r.reload} />
  if (!todas.length) return null

  const set = (p: Partial<AvanceFiltro>) => setF(x => ({ ...x, ...p }))
  const T = totalAvance(todas), TF = totalAvance(filas)
  const und = vista !== 'tn', ton = vista !== 'und', span = und && ton ? 2 : 1
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)} %` : '—')
  const nAvz = [f.lotes.length > 0, f.estado, f.bodega, f.situacion, f.min, f.max].filter(Boolean).length
  const chips = [f.soloSaldo && 'Solo con saldo', ...f.lotes.map(l => `Lote ${l}`), f.estado && `Estado: ${f.estado}`,
    f.bodega && `Bodega: ${f.bodega === 'NINGUNA' ? 'sin stock' : f.bodega}`, f.situacion && ({ LISTO: 'Listo para despachar', PRODUCIR: 'Falta producir', SIN_PESO: 'Sin peso unitario' } as Record<string, string>)[f.situacion],
    (f.min || f.max) && `Avance ${f.min || 0}–${f.max || 100} %`, f.q && `Texto: ${f.q}`].filter(Boolean) as string[]

  // Cantidades en la unidad del contrato; si no es UND se muestra al lado
  const pair = (q: number, peso: number | null, first = false, unidad: string | null = null) => <>
    {und && <td className={`px-2 py-1.5 text-right tabular-nums ${first ? 'border-l border-slate-100' : ''}`}>{q ? <>{q3.format(q)}{unidad && unidad.trim().toUpperCase() !== 'UND' && <span className="ml-1 text-[10px] font-semibold text-amber-700">{unidad}</span>}</> : <Dash />}</td>}
    {ton && <td className={`px-2 py-1.5 text-right tabular-nums text-slate-500 ${!und ? 'border-l border-slate-100' : ''}`}>{!q ? <Dash /> : peso ? t3.format(tn(q, peso)) : <span className="font-semibold text-amber-700" title="Sin peso unitario en el ERP ni en el APT">s/p</span>}</td>}
  </>
  const tpair = (q: number, t: number, mixta = false) => <>
    {und && <td className="border-l border-white/10 px-2 py-1.5 text-right tabular-nums" title={mixta ? 'Unidades distintas: compare en TN' : undefined}>{mixta ? '—' : q0.format(q)}</td>}
    {ton && <td className="px-2 py-1.5 text-right tabular-nums">{t2.format(t)}</td>}
  </>
  const totales = (t: AvanceTotal) => <>
    {tpair(t.contratado, t.tContratado, t.mixta)}{tpair(t.despachado, t.tDespachado, t.mixta)}{tpair(t.saldo, t.tSaldo, t.mixta)}
    {[0, 1, 2].map(i => <Fragment key={i}>{tpair(t.apt[i], t.tApt[i], t.mixta)}</Fragment>)}{tpair(t.porProducir, t.tPorProducir, t.mixta)}
    <td className="px-2 py-1.5"><Bar d={t.tDespachado} a={t.tApt[0] + t.tApt[1] + t.tApt[2]} c={t.tContratado} /><span className="text-[10px]">{pct(t.tDespachado, t.tContratado)}</span></td><td />
  </>
  const fila = (x: AvanceFila) => <tr key={x.item} className="border-b border-slate-100 align-top hover:bg-slate-50">
    {!agrupar && <td className="px-2 py-1.5 whitespace-nowrap">{x.lote}</td>}
    <td className="px-2 py-1.5 whitespace-nowrap font-semibold text-[#002855]">{x.item}</td>
    <td className="px-2 py-1.5"><p className="font-mono text-[11px] text-slate-500">{x.producto}{x.pesoFuente === 'APT' && <span title="Peso promedio del ID en el APT (el ERP no tiene peso unitario)"> · peso APT</span>}
      {x.unidadDistinta && <span className="font-semibold text-amber-700" title="El APT lleva este ID en otra unidad: el stock no se asigna al ítem"> · otra unidad en APT</span>}</p>
      <p className="max-w-80 text-slate-800">{x.glosa ?? '—'}</p>
      {onKardex && <button type="button" onClick={() => onKardex(x.producto)} className="text-[11px] font-semibold text-[#002855] underline decoration-dotted">Kardex del ID</button>}</td>
    {pair(x.contratado, x.peso, true, x.unidad)}{pair(x.despachado, x.peso, true, x.unidad)}{pair(x.saldo, x.peso, true, x.unidad)}
    {pair(x.apt[0], x.peso, true, x.unidad)}{pair(x.apt[1], x.peso, true, x.unidad)}{pair(x.apt[2], x.peso, true, x.unidad)}{pair(x.porProducir, x.peso, true, x.unidad)}
    <td className="px-2 py-1.5"><Bar d={x.despachado} a={x.enApt} c={x.contratado} /><span className="text-[10px] text-slate-500">{Math.round(x.avance * 100)} %</span></td>
    <td className="px-2 py-1.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${ESTADO_CLS[x.estado]}`}>{x.estado}</span></td>
  </tr>

  const lotesVista = lotes.filter(l => filas.some(x => x.lote === l))
  const exportar = () => exportAptXlsx(`avance-contrato-${ot}`, {
    'Avance por ítem': filas.map(x => ({ Lote: x.lote, Ítem: x.item, ID: x.producto, Glosa: x.glosa ?? '', Unidad: x.unidad ?? '', 'Peso unit. kg': x.peso ?? '', 'Fuente peso': x.pesoFuente ?? 'Sin peso',
      'Contrato und': x.contratado, 'Contrato TN': tn(x.contratado, x.peso), 'Despachado und': x.despachado, 'Despachado TN': tn(x.despachado, x.peso),
      'Saldo und': x.saldo, 'Saldo TN': tn(x.saldo, x.peso), ...Object.fromEntries(BODEGAS.flatMap((b, i) => [[`APT ${b} und`, x.apt[i]], [`APT ${b} TN`, tn(x.apt[i], x.peso)]])),
      'Por producir und': x.porProducir, 'Por producir TN': tn(x.porProducir, x.peso), 'Avance %': Math.round(x.avance * 1000) / 10, Estado: x.estado })),
    'Cumplimiento por lote': lotesVista.map(l => { const t = totalAvance(todas.filter(x => x.lote === l))
      return { Lote: l, Ítems: t.n, 'Sin peso': t.sinPeso, 'Contrato TN': t.tContratado, 'Despachado TN': t.tDespachado, 'En APT TN': t.tApt[0] + t.tApt[1] + t.tApt[2], 'Por producir TN': t.tPorProducir, 'Cumplimiento %': t.tContratado ? Math.round((t.tDespachado / t.tContratado) * 1000) / 10 : '' } }),
  })

  return <>
    <ChartCard title="Avance del contrato por ítem"
      subtitle={`${fmtN(todas.length)} ítems · ${fmtN(lotes.length)} lotes · mostrando ${fmtN(filas.length)} · Actualizable del ERP${r.data?.corte ? ` al ${fmtDate(r.data.corte)}` : ''} + stock del APT`}
      info="Contrato, despachado y saldo vienen del Actualizable del ERP. El stock de un ID compartido por varios ítems se asigna a los ítems con saldo en su orden (primero 647, luego 540 y ST). Por producir = saldo − stock asignado. Toneladas con el peso unitario del ERP o, si falta, el promedio del ID en el APT (s/p = sin peso)."
      actions={<button type="button" onClick={exportar} className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]"><Download className="h-4 w-4" aria-hidden /> Excel</button>}>
      <div className="space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <input value={f.q} onChange={e => set({ q: e.target.value })} placeholder="Buscar ítem, ID o glosa" aria-label="Buscar ítem, ID o glosa" className={`w-64 ${field}`} />
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-300" role="group" aria-label="Saldo">
            {[[false, 'Todos'], [true, 'Solo con saldo']].map(([v, l]) => <button key={String(v)} type="button" aria-pressed={f.soloSaldo === v} onClick={() => set({ soloSaldo: v as boolean })}
              className={`min-h-9 px-3 text-xs font-semibold ${f.soloSaldo === v ? 'bg-[#002855] text-white' : 'bg-white text-slate-700'}`}>{l as string}</button>)}
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-300" role="group" aria-label="Unidades">
            {([['both', 'Cant. + TN'], ['und', 'Cant.'], ['tn', 'TN']] as Array<[Vista, string]>).map(([v, l]) => <button key={v} type="button" aria-pressed={vista === v} onClick={() => setVista(v)}
              className={`min-h-9 px-3 text-xs font-semibold ${vista === v ? 'bg-[#002855] text-white' : 'bg-white text-slate-700'}`}>{l}</button>)}
          </div>
          <button type="button" aria-expanded={avanzado} onClick={() => setAvanzado(v => !v)} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]">
            <SlidersHorizontal className="h-4 w-4" aria-hidden /> Filtro avanzado{nAvz ? ` (${nAvz})` : ''}</button>
          <label className="ml-auto flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={agrupar} onChange={e => setAgrupar(e.target.checked)} className="h-4 w-4" /> Agrupar por lote</label>
        </div>
        {avanzado && <div className="grid gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 sm:grid-cols-2 xl:grid-cols-5">
          <label className="flex flex-col gap-1 text-[11px] font-bold text-slate-600">Lote (Ctrl para varios)
            <select multiple size={4} value={f.lotes} onChange={e => set({ lotes: [...e.target.selectedOptions].map(o => o.value) })} className="rounded-lg border border-slate-300 bg-white p-1 text-xs">{lotes.map(l => <option key={l}>{l}</option>)}</select></label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-slate-600">Estado
            <select value={f.estado} onChange={e => set({ estado: e.target.value })} className={field}><option value="">Todos</option><option>PENDIENTE</option><option>PARCIAL</option><option>COMPLETO</option></select></label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-slate-600">Bodega con stock
            <select value={f.bodega} onChange={e => set({ bodega: e.target.value })} className={field}><option value="">Cualquiera</option>{BODEGAS.map(b => <option key={b} value={b}>{b}</option>)}<option value="NINGUNA">Sin stock en APT</option></select></label>
          <label className="flex flex-col gap-1 text-[11px] font-bold text-slate-600">Situación
            <select value={f.situacion} onChange={e => set({ situacion: e.target.value })} className={field}><option value="">Todas</option><option value="LISTO">Listo para despachar (saldo en APT)</option><option value="PRODUCIR">Falta producir</option><option value="SIN_PESO">Sin peso unitario</option></select></label>
          <div className="flex flex-col gap-1 text-[11px] font-bold text-slate-600">Avance (%)
            <div className="flex gap-2"><input type="number" min="0" max="100" value={f.min} onChange={e => set({ min: e.target.value })} placeholder="Desde" aria-label="Avance desde" className={`w-20 ${field}`} />
              <input type="number" min="0" max="100" value={f.max} onChange={e => set({ max: e.target.value })} placeholder="Hasta" aria-label="Avance hasta" className={`w-20 ${field}`} /></div></div>
        </div>}
        {chips.length > 0 && <div className="flex flex-wrap items-center gap-1.5">{chips.map(c => <span key={c} className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-900">{c}</span>)}
          {(nAvz > 0 || f.q) && <button type="button" onClick={() => setF({ ...FILTRO_INICIAL, soloSaldo: f.soloSaldo })} className="flex items-center gap-1 text-[11px] font-semibold text-slate-600 underline"><X className="h-3 w-3" aria-hidden /> Limpiar filtros</button>}</div>}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
          {([['Contratado', `${t2.format(T.tContratado)} TN`, `${T.mixta ? 'varias unidades' : `${q0.format(T.contratado)} ${(T.unidad ?? 'und').toLowerCase()}`}${T.sinPeso ? ` · ${fmtN(T.sinPeso)} ítems sin peso` : ''}`, 'border-t-[#002855] text-[#002855]'],
            ['Despachado', `${t2.format(T.tDespachado)} TN`, `${pct(T.tDespachado, T.tContratado)} del contrato`, 'border-t-[#002855] text-[#002855]'],
            ['Saldo por despachar', `${t2.format(T.tSaldo)} TN`, `${fmtN(todas.filter(x => x.saldo > 0).length)} ítems con saldo`, 'border-t-red-600 text-red-700'],
            ['En APT (listo)', `${t2.format(T.tApt[0] + T.tApt[1] + T.tApt[2])} TN`, BODEGAS.map((b, i) => `${b}: ${t2.format(T.tApt[i])}`).join(' · '), 'border-t-amber-500 text-amber-700'],
            ['Por producir', `${t2.format(T.tPorProducir)} TN`, `${pct(T.tPorProducir, T.tContratado)} del contrato`, 'border-t-slate-500 text-slate-700']] as const).map(([l, v, h, c]) =>
            <div key={l} className={`rounded-lg border border-slate-200 border-t-4 p-2.5 ${c}`}><p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">{l}</p><p className="text-lg font-black">{v}</p><p className="text-[11px] text-slate-500">{h}</p></div>)}
        </div>
      </div>
      <div className="max-h-[36rem] overflow-auto border-t border-slate-200">
        <DataTable dense sortable={false} className="min-w-[1400px] text-xs">
          <thead>
            <tr>{!agrupar && <th scope="col" rowSpan={2} className={`${thc} top-0 bg-slate-50 text-left`}>Lote</th>}<th scope="col" rowSpan={2} className={`${thc} top-0 bg-slate-50 text-left`}>Ítem</th><th scope="col" rowSpan={2} className={`${thc} top-0 bg-slate-50 text-left`}>ID + glosa</th>
              {GRUPOS.map(([g, c]) => <th key={g} scope="colgroup" colSpan={span} className={`${thc} top-0 text-center ${c}`}>{g}</th>)}
              <th scope="col" rowSpan={2} className={`${thc} top-0 bg-slate-50 text-left`}>Avance</th><th scope="col" rowSpan={2} className={`${thc} top-0 bg-slate-50 text-left`}>Estado</th></tr>
            <tr>{GRUPOS.map(([g]) => <Fragment key={g}>{und && <th scope="col" className={`${thc} top-7 bg-slate-50 text-right`}>Cant.</th>}{ton && <th scope="col" className={`${thc} top-7 bg-slate-50 text-right`}>TN</th>}</Fragment>)}</tr>
          </thead>
          <tbody>
            {!filas.length && <tr><td colSpan={30} className="p-6 text-center text-slate-500">Sin ítems con estos filtros</td></tr>}
            {agrupar ? lotesVista.map(l => { const g = filas.filter(x => x.lote === l), cerrado = cerrados.has(l)
              return <Fragment key={l}>
                <tr className="cursor-pointer border-b border-slate-200 bg-slate-100 font-bold text-[#002855]" onClick={() => setCerrados(s => { const n = new Set(s); if (n.has(l)) n.delete(l); else n.add(l); return n })}>
                  <td colSpan={2} className="px-2 py-1.5"><button type="button" aria-expanded={!cerrado} className="flex items-center gap-1">{cerrado ? <ChevronRight className="h-3.5 w-3.5" aria-hidden /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}{l} · {fmtN(g.length)} ítems</button></td>
                  {totales(totalAvance(g))}
                </tr>
                {!cerrado && g.map(fila)}
              </Fragment> }) : filas.map(fila)}
          </tbody>
          <tfoot><tr className="sticky bottom-0 bg-[#002855] font-bold text-white"><td colSpan={agrupar ? 2 : 3} className="px-2 py-1.5">Total filtrado · {fmtN(TF.n)} ítems</td>{totales(TF)}</tr></tfoot>
        </DataTable>
      </div>
    </ChartCard>
    <ChartCard title="Cumplimiento por lote" subtitle="Cada barra es el 100 % del lote en toneladas (en unidades si el lote no tiene peso): despachado, listo en el APT y por producir. Lotes del filtro actual.">
      <div className="space-y-1.5 p-4">
        <div className="mb-2 flex flex-wrap gap-4 text-[11px] text-slate-600">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[#002855]" />Despachado</span><span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-amber-400" />En APT (listo)</span><span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-slate-200" />Por producir</span></div>
        {lotesVista.map(l => { const t = totalAvance(todas.filter(x => x.lote === l))
          // Lote sin peso en ningún ítem: el cumplimiento se mide en unidades
          const enTn = t.tContratado > 0, c = enTn ? t.tContratado : t.mixta ? 0 : t.contratado, d = enTn ? t.tDespachado : t.despachado
          const apt = enTn ? t.tApt[0] + t.tApt[1] + t.tApt[2] : t.apt[0] + t.apt[1] + t.apt[2], fmt = enTn ? t2 : q0, u = enTn ? 'TN' : (t.unidad ?? 'und').toLowerCase()
          const w = (x: number) => (c > 0 ? `${(x / c) * 100}%` : '0%')
          return <div key={l} className="grid grid-cols-[7rem_1fr_13rem] items-center gap-2 text-[11px]">
            <span className="text-right font-semibold text-slate-700">{l}</span>
            <div className="flex h-4 overflow-hidden rounded bg-slate-200" title={`Despachado ${fmt.format(d)} ${u} · En APT ${fmt.format(apt)} ${u} · Por producir ${fmt.format(enTn ? t.tPorProducir : t.porProducir)} ${u}`}>
              <i className="block h-full bg-[#002855]" style={{ width: w(d) }} /><i className="block h-full bg-amber-400" style={{ width: w(apt) }} /></div>
            <span><b>{pct(d, c)}</b> <span className="text-slate-500">· {fmt.format(d)} de {fmt.format(c)} {u}{t.sinPeso ? ` · ${t.sinPeso} s/p` : ''}</span></span>
          </div> })}
      </div>
    </ChartCard>
  </>
}
