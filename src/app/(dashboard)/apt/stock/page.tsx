'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Download, Search } from 'lucide-react'
import { ChartCard, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { DiasPill, KindBadge, Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { ALMACENES, ALMACEN_LABEL, AlmacenTag, aptAlmacen, useAmbito } from '@/components/inventario/ambito'
import { invApi } from '@/lib/inventario/api'
import { KINDS, KIND_LABEL, fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { AptAlmacen, InvKind, InvStockFilters } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'

const PAGE = 100

// Stock disponible al corte por bodega · producto · lote: libre (sin contrato) o comprometido (lote de una OT)
export default function InventarioStockPage() {
  const sp = useSearchParams()
  const apt = useAmbito() === 'apt'
  const [draft, setDraft] = useState({ q: sp.get('q') ?? '', bodega: sp.get('bodega') ?? '', almacen: (sp.get('almacen') ?? '') as AptAlmacen | '', kind: (sp.get('kind') ?? '') as InvKind | '',
    estado: (sp.get('estado') ?? '') as InvStockFilters['estado'], min_dias: sp.get('min_dias') ?? '', orden: (sp.get('orden') ?? 'kg') as InvStockFilters['orden'] })
  const [applied, setApplied] = useState(draft)
  const [page, setPage] = useState(0)
  const cats = useInvQuery('cats', () => invApi.catalogs())
  // En el APT la lista de bodegas se limita a 647 · 540 · ST; «Almacén» agrupa sus bodegas
  const bodegas = useMemo(() => (cats.data?.bodegas ?? []).filter(b => !apt || aptAlmacen(b.code)), [cats.data, apt])
  const almacenBodegas = useMemo(() => (apt && applied.almacen ? bodegas.filter(b => aptAlmacen(b.code) === applied.almacen).map(b => b.code) : []), [apt, applied.almacen, bodegas])
  const filters: InvStockFilters = useMemo(() => ({
    q: applied.q || undefined, bodegas: applied.bodega && (!apt || aptAlmacen(applied.bodega)) ? [applied.bodega] : almacenBodegas, kinds: applied.kind ? [applied.kind] : [],
    estado: applied.estado || '', min_dias: applied.min_dias ? Number(applied.min_dias) : 0, orden: applied.orden, limit: PAGE, offset: page * PAGE,
    ...(apt ? { ambito: 'apt' as const } : {}),
  }), [applied, page, apt, almacenBodegas])
  // Con «Almacén» se espera la lista de bodegas para no mostrar un instante todo el APT
  const waiting = apt && !!applied.almacen && !cats.data
  const q = useInvQuery(`stock|${JSON.stringify(filters)}|${waiting}`, () => (waiting ? new Promise<never>(() => {}) : invApi.stock(filters)))
  const d = q.data
  const apply = () => { setPage(0); setApplied(draft) }
  const [exporting, setExporting] = useState(false)
  const exportAll = async () => {
    setExporting(true)
    try {
      const all = await invApi.stock({ ...filters, limit: 2000, offset: 0 })
      exportAptXlsx(`stock-disponible-${d?.corte ?? ''}`, { Stock: all.filas.map(r => ({
        Bodega: r.bodega, Almacén: aptAlmacen(r.bodega) ?? '', Tipo: KIND_LABEL[r.kind], Producto: r.producto, Glosa: r.glosa ?? '', Lote: r.lote ?? '', OT: r.ot ?? '',
        Estado: r.ot ? 'Comprometido' : 'Libre', Cliente: r.cliente ?? '', Unidad: r.unidad ?? '', Cantidad: r.qty, Kg: r.kg_conocido ? r.kg : '',
        'Ingreso a la bodega': r.fecha_ingreso ?? 'Saldo inicial', 'Días en bodega': r.dias_bodega ?? '', 'Fecha de origen': r.fecha_origen ?? '',
        'Días desde origen': r.dias_origen ?? '', 'Saldo inferido': r.inferido, 'Saldo de foto': r.foto,
      })) })
    } finally { setExporting(false) }
  }
  return (
    <div className="space-y-4">
      <form onSubmit={e => { e.preventDefault(); apply() }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="min-w-56 flex-1 text-xs font-semibold text-slate-600">Buscar
          <span className="mt-1 flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-2"><Search className="h-4 w-4 text-slate-400" />
            <input value={draft.q} onChange={e => setDraft({ ...draft, q: e.target.value })} placeholder="Producto, glosa, lote, OT o cliente" className="w-full text-sm outline-none" /></span>
        </label>
        {apt && <label className="text-xs font-semibold text-slate-600">Almacén
          <select value={draft.almacen} onChange={e => setDraft({ ...draft, almacen: e.target.value as AptAlmacen | '', bodega: '' })} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="">647 · 540 · ST</option>{ALMACENES.map(a => <option key={a} value={a}>{ALMACEN_LABEL[a]}</option>)}
          </select>
        </label>}
        <label className="text-xs font-semibold text-slate-600">Bodega
          <select value={draft.bodega} onChange={e => setDraft({ ...draft, bodega: e.target.value })} className="mt-1 block min-h-10 max-w-60 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="">Todas</option>{bodegas.filter(b => !draft.almacen || aptAlmacen(b.code) === draft.almacen).map(b => <option key={b.code} value={b.code}>{b.code}</option>)}
          </select>
        </label>
        {!apt && <label className="text-xs font-semibold text-slate-600">Tipo de bodega
          <select value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as InvKind | '' })} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="">Todos</option>{KINDS.map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </label>}
        <label className="text-xs font-semibold text-slate-600">Estado
          <select value={draft.estado} onChange={e => setDraft({ ...draft, estado: e.target.value as InvStockFilters['estado'] })} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="">Libre y comprometido</option><option value="libre">Libre (sin contrato)</option><option value="comprometido">Comprometido (con OT)</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">Antigüedad mínima
          <input type="number" min={0} value={draft.min_dias} onChange={e => setDraft({ ...draft, min_dias: e.target.value })} placeholder="días" className="mt-1 block min-h-10 w-24 rounded-lg border border-slate-300 px-2 text-sm" />
        </label>
        <label className="text-xs font-semibold text-slate-600">Ordenar por
          <select value={draft.orden} onChange={e => setDraft({ ...draft, orden: e.target.value as InvStockFilters['orden'] })} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="kg">Peso</option><option value="edad">Antigüedad</option><option value="qty">Cantidad</option>
          </select>
        </label>
        <button type="submit" className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white">Aplicar</button>
        <button type="button" onClick={exportAll} disabled={exporting || !d?.total} className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" /> Excel</button>
      </form>
      {q.loading ? <LoadingBlock label="Calculando el stock…" /> : q.error ? <ErrorBlock message={q.error} onRetry={q.reload} /> : d && <>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <KpiCard label="Stock con peso" value={fmtPeso(d.totales.kg)} tone="navy" hint={`${fmtN(d.totales.claves)} productos·lote al ${fmtDate(d.corte)}`} />
          <KpiCard label="Libre" value={fmtPeso(d.totales.kg_libre)} tone="ok" hint="Sin contrato: disponible para asignar" />
          <KpiCard label="Comprometido" value={fmtPeso(d.totales.kg_comprometido)} tone="warn" hint="Lote de una OT / subcontrato" />
          <KpiCard label="Con saldo inferido" value={fmtN(d.totales.claves_inferidas)} unit="claves" tone={d.totales.claves_inferidas ? 'warn' : 'ok'} hint={`${fmtN(d.totales.claves_sin_peso)} sin peso (solo cantidad)`} />
        </div>
        <ChartCard title="Detalle del stock" subtitle={`${fmtN(d.total)} productos·lote · página ${page + 1} de ${Math.max(1, Math.ceil(d.total / PAGE))}`}
          info="El saldo resulta de aplicar las salidas a los ingresos más antiguos (FIFO) por bodega, producto y lote. «Inferido» es saldo anterior a los datos cargados que no viene de una foto de stock.">
          <Table empty={!d.filas.length} head={<tr><th className={th}>Bodega</th><th className={th}>Producto</th><th className={th}>Lote / OT</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Peso</th><th className={th}>Ingreso</th><th className={th}>En bodega</th><th className={th}>Desde origen</th></tr>}>
            {d.filas.map(r => <tr key={`${r.bodega}|${r.producto}|${r.lote}`} className="hover:bg-slate-50">
              <td className={td}><p className="font-semibold text-slate-800">{r.bodega}</p>{apt ? <AlmacenTag almacen={aptAlmacen(r.bodega)} /> : <KindBadge kind={r.kind} />}</td>
              <td className={td}><p className="font-mono text-[11px] text-slate-500">{r.producto}</p><p className="max-w-80 text-slate-800">{r.glosa ?? '—'}</p></td>
              <td className={td}>{r.lote ? <Link href={`/apt/trazabilidad?q=${encodeURIComponent(r.lote)}`} className="font-semibold text-[#002855] underline">{r.lote}</Link> : <span className="text-slate-400">Sin lote</span>}
                <p className="mt-0.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${r.ot ? 'bg-blue-50 text-blue-800' : 'bg-emerald-50 text-emerald-800'}`}>{r.ot ? `OT ${r.ot}` : 'Libre'}</span></p>
                {r.cliente && <p className="mt-0.5 max-w-52 truncate text-[11px] text-slate-500" title={r.cliente}>{r.cliente}</p>}</td>
              <td className={tdNum}>{fmtQty(r.qty)} <span className="text-slate-400">{r.unidad ?? ''}</span>
                {r.inferido > 0 && <p className="text-[10px] font-semibold text-amber-700" title="Saldo anterior a los datos, sin foto de stock">{fmtQty(r.inferido)} inferido</p>}
                {r.foto > 0 && <p className="text-[10px] text-emerald-700">{fmtQty(r.foto)} de la foto</p>}</td>
              <td className={tdNum}>{r.kg_conocido ? fmtPeso(r.kg) : <span className="text-slate-400">Sin peso</span>}</td>
              <td className={td}>{r.fecha_ingreso ? fmtDate(r.fecha_ingreso) : <span className="text-amber-700">Saldo inicial</span>}</td>
              <td className={td}><DiasPill dias={r.dias_bodega} title="Desde el ingreso más antiguo con saldo en esta bodega" /></td>
              <td className={td}><DiasPill dias={r.dias_origen} title={r.fecha_origen ? `Origen: ${fmtDate(r.fecha_origen)}` : 'Origen desconocido'} /></td>
            </tr>)}
          </Table>
          <div className="mt-3 flex items-center justify-end gap-2 text-xs">
            <button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="min-h-9 rounded-lg border border-slate-300 px-3 disabled:opacity-40">Anterior</button>
            <button type="button" disabled={(page + 1) * PAGE >= d.total} onClick={() => setPage(p => p + 1)} className="min-h-9 rounded-lg border border-slate-300 px-3 disabled:opacity-40">Siguiente</button>
          </div>
        </ChartCard>
      </>}
    </div>
  )
}
