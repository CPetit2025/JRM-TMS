'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Download, Search } from 'lucide-react'
import { ChartCard, EmptyState, ErrorBlock, InlineBar, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { DiasPill, Table, td, tdNum, th } from '@/components/inventario/parts'
import { ALMACEN_LABEL, AlmacenTag, ProductoCell } from '@/components/inventario/ambito'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { fmtN, fmtN1, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { InvContrato, InvContratoFila } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'

// Contratos / OT en el APT (647 · 540 · ST): la lista de OT con avance, saldo y cumplimiento, y la ficha de una OT con
// sus IDs (producto + glosa): ingresado, despachado, stock por almacén, último ingreso y última salida.
export default function ContratosPage() {
  const sp = useSearchParams()
  const router = useRouter()
  const ot = sp.get('ot')?.trim() ?? ''
  const [draft, setDraft] = useState(ot)
  const open = (q: string) => router.push(q.trim() ? `/apt/contratos?ot=${encodeURIComponent(q.trim())}` : '/apt/contratos')
  return (
    <div className="space-y-4">
      <form onSubmit={e => { e.preventDefault(); open(draft) }} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="min-w-64 flex-1 text-xs font-semibold text-slate-600">Buscar contrato u OT
          <span className="mt-1 flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-2"><Search className="h-4 w-4 text-slate-400" />
            <input value={draft} onChange={e => setDraft(e.target.value)} placeholder="Ej. 16339 o 16339-S005" inputMode="search" className="w-full text-sm outline-none" /></span>
        </label>
        <button type="submit" className="min-h-10 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white">Ver ficha</button>
        {ot && <button type="button" onClick={() => { setDraft(''); open('') }} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-[#002855]"><ArrowLeft className="h-4 w-4" /> Todas las OT</button>}
        <p className="max-w-md text-xs text-slate-500">La OT reúne su lote madre y sus subcontratos (16339, 16339-S001…) en los almacenes 647, 540 y ST.</p>
      </form>
      {ot ? <Ficha q={ot} onOpen={q => { setDraft(q); open(q) }} /> : <Lista onOpen={q => { setDraft(q); open(q) }} />}
    </div>
  )
}

type Orden = 'stock' | 'dias' | 'avance' | 'reciente' | 'ot'
type Estado = '' | 'stock' | 'curso' | 'cerradas'
const PAGE = 100

function Lista({ onOpen }: { onOpen: (q: string) => void }) {
  const q = useInvQuery('contratos', () => invApi.contratos())
  const [filtro, setFiltro] = useState('')
  const [estado, setEstado] = useState<Estado>('stock')
  const [orden, setOrden] = useState<Orden>('stock')
  const [page, setPage] = useState(0)
  const rows = useMemo(() => {
    const f = filtro.trim().toUpperCase()
    const out = (q.data?.contratos ?? []).filter(c => (!f || c.ot.includes(f) || (c.cliente ?? '').toUpperCase().includes(f))
      && (estado === '' || (estado === 'stock' ? c.stock_kg > 0 : estado === 'curso' ? c.stock_kg > 0 || (c.avance_pct ?? 0) < 100 : c.stock_kg <= 0)))
    const last = (c: InvContratoFila) => [c.ultima_salida, c.ultimo_ingreso].filter(Boolean).sort().pop() ?? ''
    const by: Record<Orden, (a: InvContratoFila, b: InvContratoFila) => number> = {
      stock: (a, b) => b.stock_kg - a.stock_kg, dias: (a, b) => (b.dias_stock ?? -1) - (a.dias_stock ?? -1),
      avance: (a, b) => (a.avance_pct ?? 0) - (b.avance_pct ?? 0), reciente: (a, b) => last(b).localeCompare(last(a)), ot: (a, b) => b.ot.localeCompare(a.ot),
    }
    return out.sort(by[orden])
  }, [q.data, filtro, estado, orden])
  if (q.loading) return <LoadingBlock label="Cargando contratos…" />
  if (q.error) return <ErrorBlock message={q.error} onRetry={q.reload} />
  const all = q.data?.contratos ?? []
  if (!all.length) return <EmptyState title="Sin contratos en el APT">Aún no hay movimientos con lote de OT en los almacenes 647, 540 y ST.</EmptyState>
  const conStock = all.filter(c => c.stock_kg > 0)
  const stockKg = conStock.reduce((t, c) => t + c.stock_kg, 0)
  const viejas = conStock.filter(c => (c.dias_stock ?? 0) > 60)
  const conFecha = all.filter(c => c.a_tiempo_pct !== null)
  const exportar = () => exportAptXlsx(`contratos-apt-${q.data?.corte ?? ''}`, { Contratos: rows.map(c => ({
    OT: c.ot, Cliente: c.cliente ?? '', Productos: c.productos, Lotes: c.lotes, Guías: c.guias, 'Ingresado kg': c.ingresado_kg, 'Despachado kg': c.despachado_kg,
    'Avance %': c.avance_pct ?? '', 'Stock kg': c.stock_kg, 'Stock 647 kg': c.stock_647_kg, 'Stock 540 kg': c.stock_540_kg, 'Stock ST kg': c.stock_st_kg,
    'Días en stock': c.dias_stock ?? '', 'Entrega comprometida': c.fecha_entrega ?? '', 'A tiempo %': c.a_tiempo_pct ?? '',
    'Primer ingreso': c.primer_ingreso ?? '', 'Último ingreso': c.ultimo_ingreso ?? '', 'Última salida': c.ultima_salida ?? '',
  })) })
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  return <>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <KpiCard label="OT con stock en el APT" value={fmtN(conStock.length)} tone="navy" hint={`de ${fmtN(all.length)} OT con movimiento · corte ${fmtDate(q.data?.corte)}`} />
      <KpiCard label="Stock comprometido" value={fmtPeso(stockKg)} hint="Saldo de lotes de OT en 647 · 540 · ST" />
      <KpiCard label="OT con stock > 60 días" value={fmtN(viejas.length)} tone={viejas.length ? 'warn' : 'ok'} hint={fmtPeso(viejas.reduce((t, c) => t + c.stock_kg, 0))} />
      <KpiCard label="Despachos a tiempo" value={conFecha.length ? `${fmtN1(conFecha.reduce((t, c) => t + (c.a_tiempo_pct ?? 0), 0) / conFecha.length)} %` : '—'}
        hint="Promedio por OT · guía con fecha ≤ entrega comprometida" />
    </div>
    <ChartCard title="Contratos / OT" subtitle={`${fmtN(rows.length)} OT · página ${Math.min(page + 1, pages)} de ${pages}`}
      info="Avance = kg despachados / kg ingresados al APT (sin contar dos veces el traspaso 647 → ST de la misma OT). Días en stock: desde el ingreso más antiguo que aún tiene saldo."
      actions={<button type="button" onClick={exportar} disabled={!rows.length} className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" /> Excel</button>}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-slate-600">Filtrar
          <input value={filtro} onChange={e => { setFiltro(e.target.value); setPage(0) }} placeholder="OT o cliente" className="mt-1 block min-h-10 w-56 rounded-lg border border-slate-300 px-2 text-sm" />
        </label>
        <label className="text-xs font-semibold text-slate-600">Estado
          <select value={estado} onChange={e => { setEstado(e.target.value as Estado); setPage(0) }} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="stock">Con stock en el APT</option><option value="curso">En curso (stock o avance &lt; 100 %)</option><option value="cerradas">Sin stock</option><option value="">Todas</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">Ordenar por
          <select value={orden} onChange={e => setOrden(e.target.value as Orden)} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="stock">Stock</option><option value="dias">Antigüedad del stock</option><option value="avance">Menor avance</option><option value="reciente">Movimiento más reciente</option><option value="ot">Número de OT</option>
          </select>
        </label>
      </div>
      <Table empty={!rows.length} head={<tr><th className={th}>OT</th><th className={th}>Cliente</th><th className={`${th} text-right`}>Ingresado</th><th className={`${th} text-right`}>Despachado</th><th className={th}>Avance</th>
        <th className={`${th} text-right`}>Stock</th><th className={`${th} text-right`}>647</th><th className={`${th} text-right`}>540</th><th className={`${th} text-right`}>ST</th><th className={th}>Días</th>
        <th className={th}>Entrega</th><th className={`${th} text-right`}>A tiempo</th><th className={th}>Último ingreso</th><th className={th}>Última salida</th></tr>}>
        {rows.slice(page * PAGE, (page + 1) * PAGE).map(c => <tr key={c.ot} className="hover:bg-slate-50">
          <td className={td}><button type="button" onClick={() => onOpen(c.ot)} className="font-bold text-[#002855] underline">{c.ot}</button>
            <p className="text-[10px] text-slate-500">{fmtN(c.productos)} ID · {fmtN(c.lotes)} lotes</p></td>
          <td className={td}><p className="max-w-56 truncate" title={c.cliente ?? ''}>{c.cliente ?? '—'}</p></td>
          <td className={tdNum}>{fmtPeso(c.ingresado_kg)}</td><td className={tdNum}>{fmtPeso(c.despachado_kg)}</td>
          <td className={`${td} min-w-28`}><div className="flex items-center gap-2"><InlineBar value={c.avance_pct ?? 0} max={100} color={(c.avance_pct ?? 0) >= 100 ? '#0d9488' : '#002855'} /><span className="tabular-nums">{c.avance_pct === null ? '—' : `${fmtN(c.avance_pct)} %`}</span></div></td>
          <td className={`${tdNum} font-semibold`}>{c.stock_kg > 0 ? fmtPeso(c.stock_kg) : '—'}</td>
          <td className={tdNum}>{c.stock_647_kg > 0 ? fmtPeso(c.stock_647_kg) : '—'}</td><td className={tdNum}>{c.stock_540_kg > 0 ? fmtPeso(c.stock_540_kg) : '—'}</td><td className={tdNum}>{c.stock_st_kg > 0 ? fmtPeso(c.stock_st_kg) : '—'}</td>
          <td className={td}>{c.stock_kg > 0 ? <DiasPill dias={c.dias_stock} /> : '—'}</td>
          <td className={td}>{fmtDate(c.fecha_entrega)}</td><td className={tdNum}>{c.a_tiempo_pct === null ? '—' : `${fmtN(c.a_tiempo_pct)} %`}</td>
          <td className={td}>{fmtDate(c.ultimo_ingreso)}</td><td className={td}>{fmtDate(c.ultima_salida)}</td>
        </tr>)}
      </Table>
      <div className="mt-3 flex items-center justify-end gap-2 text-xs">
        <button type="button" disabled={page === 0} onClick={() => setPage(p => p - 1)} className="min-h-9 rounded-lg border border-slate-300 px-3 disabled:opacity-40">Anterior</button>
        <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(p => p + 1)} className="min-h-9 rounded-lg border border-slate-300 px-3 disabled:opacity-40">Siguiente</button>
      </div>
    </ChartCard>
  </>
}

function exportFicha(d: InvContrato) {
  exportAptXlsx(`ot-${d.ot}-${d.corte ?? ''}`, {
    IDs: (d.productos ?? []).map(p => ({ ID: p.producto, Glosa: p.glosa ?? '', Unidad: p.unidad ?? '', Lotes: p.lotes.join(', '),
      Ingresado: p.ingresado, Producido: p.producido, Despachado: p.despachado, 'Otras salidas': p.otras_salidas,
      'Stock 647': p.stock_647, 'Stock 540': p.stock_540, 'Stock ST': p.stock_st, 'Stock total': p.stock, 'Stock kg': p.stock_kg,
      'Ingresado kg': p.ingresado_kg, 'Despachado kg': p.despachado_kg, Diferencia: p.diferencia,
      'Último ingreso': p.ultimo_ingreso ?? '', 'Última salida': p.ultima_salida ?? '', 'Días en APT': p.dias_apt ?? '', Guías: p.guias })),
    Guías: (d.guias ?? []).map(g => ({ Guía: g.numero, Fecha: g.fecha, Almacén: g.almacen, Cliente: g.cliente ?? '', Líneas: g.lineas, Cantidad: g.cantidad, Kg: g.kg,
      'Entrega comprometida': g.fecha_entrega ?? '', 'A tiempo': g.a_tiempo === null ? '' : g.a_tiempo ? 'Sí' : 'No',
      'Viaje TMS': g.tms?.numero ?? '', Estado: g.tms?.estado ?? '', Placa: g.tms?.placa ?? '', Conductor: g.tms?.conductor ?? '', Llegada: g.tms?.llegada ?? '' })),
    Lotes: (d.lotes ?? []).map(l => ({ Lote: l.lote, Líneas: l.lineas, 'Ingresado kg': l.ingresado_kg, 'Despachado kg': l.despachado_kg })),
  })
}

function Ficha({ q, onOpen }: { q: string; onOpen: (q: string) => void }) {
  const r = useInvQuery(`contrato|${q}`, () => invApi.contrato(q))
  const [soloStock, setSoloStock] = useState(false)
  if (r.loading) return <LoadingBlock label={`Buscando la OT ${q}…`} />
  if (r.error) return <ErrorBlock message={r.error} onRetry={r.reload} />
  const d = r.data
  if (!d) return null
  if (!d.encontrado || !d.resumen) {
    return <EmptyState title={`La OT ${d.ot} no tiene movimientos en el APT`}>Revise el número o búsquelo en <Link href={`/apt/trazabilidad?q=${encodeURIComponent(q)}`} className="font-semibold text-[#002855] underline">Trazabilidad</Link> (todas las bodegas).</EmptyState>
  }
  const s = d.resumen
  const productos = (d.productos ?? []).filter(p => !soloStock || p.stock > 0)
  const descuadres = (d.productos ?? []).filter(p => Math.abs(p.diferencia) > 0.0005).length
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Contrato / OT</p>
        <h2 className="text-2xl font-black text-[#002855]">{d.ot}</h2>
        <p className="text-sm font-semibold text-slate-700">{s.cliente ?? 'Cliente no identificado'}</p>
        <p className="mt-1 text-xs text-slate-500">{fmtN(s.productos)} ID · {fmtN(s.lotes)} lotes · {fmtN(s.guias)} guías · corte {fmtDate(d.corte)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/apt/trazabilidad?q=${encodeURIComponent(d.ot)}`} className="flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]">Kardex / trazabilidad</Link>
        <button type="button" onClick={() => exportFicha(d)} className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]"><Download className="h-4 w-4" /> Excel</button>
      </div>
    </div>
    {d.stock_al_dia === false && <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><AlertTriangle className="h-4 w-4" /> El stock es del último recálculo; hay cargas pendientes de recalcular.</p>}
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <KpiCard label="Avance de despacho" value={s.avance_pct === null ? '—' : `${fmtN1(s.avance_pct)} %`} tone="navy" hint={`${fmtPeso(s.despachado_kg)} despachado de ${fmtPeso(s.ingresado_kg)} ingresado`} />
      <KpiCard label="Stock en el APT" value={fmtPeso(s.stock_kg)} tone={s.stock_kg > 0 ? 'warn' : 'ok'} hint={`647: ${fmtPeso(s.stock_647_kg)} · 540: ${fmtPeso(s.stock_540_kg)} · ST: ${fmtPeso(s.stock_st_kg)}`} />
      <KpiCard label="Despachos a tiempo" value={s.a_tiempo_pct === null ? '—' : `${fmtN1(s.a_tiempo_pct)} %`} tone={s.a_tiempo_pct === null ? 'default' : s.a_tiempo_pct >= 90 ? 'ok' : 'warn'}
        hint={s.fecha_entrega_min ? `Entrega comprometida ${fmtDate(s.fecha_entrega_min)}${s.fecha_entrega_max && s.fecha_entrega_max !== s.fecha_entrega_min ? ` – ${fmtDate(s.fecha_entrega_max)}` : ''}` : 'Sin fecha de entrega en las guías'} />
      <KpiCard label="Movimiento" value={fmtDate(s.ultima_salida ?? s.ultimo_ingreso)} hint={`Primer ingreso ${fmtDate(s.primer_ingreso)} · último ingreso ${fmtDate(s.ultimo_ingreso)} · última salida ${fmtDate(s.ultima_salida)}`} />
    </div>
    <ChartCard title="IDs de la OT" subtitle={`${fmtN(productos.length)} productos · cantidades en la unidad del ID${descuadres ? ` · ${descuadres} con diferencia` : ''}`}
      info="Ingresado: producción, compras o asignación de stock a la OT en el APT (el traspaso 647 → ST de la misma OT es interno). Diferencia = ingresado − despachado − otras salidas − stock; distinto de 0 indica saldo anterior a los datos o un ajuste."
      actions={<label className="flex items-center gap-2 text-xs font-semibold text-slate-600"><input type="checkbox" checked={soloStock} onChange={e => setSoloStock(e.target.checked)} className="h-4 w-4" /> Solo con stock</label>}>
      <Table empty={!productos.length} head={<tr><th className={th}>ID / glosa</th><th className={th}>Lotes</th><th className={`${th} text-right`}>Ingresado</th><th className={`${th} text-right`}>Despachado</th>
        <th className={`${th} text-right`}>Otras salidas</th><th className={`${th} text-right`}>647</th><th className={`${th} text-right`}>540</th><th className={`${th} text-right`}>ST</th><th className={`${th} text-right`}>Stock</th>
        <th className={th}>Último ingreso</th><th className={th}>Última salida</th><th className={th}>Días en APT</th></tr>}>
        {productos.map(p => <tr key={p.producto} className="hover:bg-slate-50">
          <td className={td}><ProductoCell producto={p.producto} glosa={p.glosa} /></td>
          <td className={td}><p className="max-w-40 text-[11px] text-slate-600">{p.lotes.join(', ')}</p></td>
          <td className={tdNum}>{fmtQty(p.ingresado)} <span className="text-slate-400">{p.unidad ?? ''}</span>{p.producido > 0 && p.producido !== p.ingresado && <p className="text-[10px] text-slate-500">{fmtQty(p.producido)} producido</p>}</td>
          <td className={tdNum}>{fmtQty(p.despachado)}<p className="text-[10px] text-slate-500">{fmtN(p.guias)} guías</p></td>
          <td className={tdNum}>{p.otras_salidas ? fmtQty(p.otras_salidas) : '—'}</td>
          <td className={tdNum}>{p.stock_647 ? fmtQty(p.stock_647) : '—'}</td><td className={tdNum}>{p.stock_540 ? fmtQty(p.stock_540) : '—'}</td><td className={tdNum}>{p.stock_st ? fmtQty(p.stock_st) : '—'}</td>
          <td className={`${tdNum} font-semibold`}>{p.stock ? fmtQty(p.stock) : '0'}{p.stock_kg > 0 && <p className="text-[10px] font-normal text-slate-500">{fmtPeso(p.stock_kg)}</p>}
            {Math.abs(p.diferencia) > 0.0005 && <p className="text-[10px] font-semibold text-amber-700" title="Ingresado − despachado − otras salidas − stock">dif. {fmtQty(p.diferencia)}</p>}</td>
          <td className={td}>{fmtDate(p.ultimo_ingreso)}</td><td className={td}>{fmtDate(p.ultima_salida)}</td>
          <td className={td}>{p.stock > 0 ? <DiasPill dias={p.dias_apt} title="Desde el ingreso más antiguo con saldo" /> : '—'}</td>
        </tr>)}
      </Table>
    </ChartCard>
    <ChartCard title="Guías de despacho" subtitle={`${fmtN(d.guias?.length ?? 0)} guías · viaje del TMS cuando la guía está registrada en Documentos`}>
      <Table empty={!d.guias?.length} head={<tr><th className={th}>Guía</th><th className={th}>Fecha</th><th className={th}>Almacén</th><th className={th}>Cliente</th><th className={`${th} text-right`}>Peso</th>
        <th className={th}>Entrega comprometida</th><th className={th}>Cumplimiento</th><th className={th}>Viaje TMS</th></tr>}>
        {d.guias?.map(g => <tr key={g.numero} className="hover:bg-slate-50">
          <td className={td}><Link href={`/apt/trazabilidad?q=${encodeURIComponent(g.numero)}`} className="font-semibold text-[#002855] underline">{g.numero}</Link><p className="text-[10px] text-slate-500">{fmtN(g.lineas)} líneas</p></td>
          <td className={td}>{fmtDate(g.fecha)}</td><td className={td}><AlmacenTag almacen={g.almacen} /></td>
          <td className={td}><p className="max-w-52 truncate" title={g.cliente ?? ''}>{g.cliente ?? '—'}</p></td><td className={tdNum}>{fmtPeso(g.kg)}</td>
          <td className={td}>{fmtDate(g.fecha_entrega)}</td>
          <td className={td}>{g.a_tiempo === null ? '—' : <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${g.a_tiempo ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{g.a_tiempo ? 'A tiempo' : 'Fuera de plazo'}</span>}</td>
          <td className={td}>{g.tms ? <>
            <Link href={`/despacho/documentos?despacho=${g.tms.dispatch_id}&vista=historial${g.tms.programado ? `&desde=${g.tms.programado.slice(0, 10)}` : ''}`} className="font-semibold text-[#002855] underline">{g.tms.numero ?? 'Viaje'}</Link>
            <p className="text-[10px] text-slate-500">{[g.tms.estado, g.tms.placa, g.tms.conductor].filter(Boolean).join(' · ')}</p>
          </> : <span className="text-slate-400">Sin registro</span>}</td>
        </tr>)}
      </Table>
    </ChartCard>
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <ChartCard title="Lotes de la OT">
        <Table empty={!d.lotes?.length} head={<tr><th className={th}>Lote</th><th className={`${th} text-right`}>Líneas</th><th className={`${th} text-right`}>Ingresado</th><th className={`${th} text-right`}>Despachado</th></tr>}>
          {d.lotes?.map(l => <tr key={l.lote}><td className={td}><Link href={`/apt/trazabilidad?q=${encodeURIComponent(l.lote)}`} className="font-semibold text-[#002855] underline">{l.lote}</Link></td>
            <td className={tdNum}>{fmtN(l.lineas)}</td><td className={tdNum}>{fmtPeso(l.ingresado_kg)}</td><td className={tdNum}>{fmtPeso(l.despachado_kg)}</td></tr>)}
        </Table>
      </ChartCard>
      <ChartCard title="OT parecidas" subtitle="Un dígito de diferencia: revise si algún lote se digitó mal" info="Lotes del APT cuya OT difiere en un dígito de esta (por ejemplo 16339 y 16389).">
        <Table empty={!d.sospechosos?.length} head={<tr><th className={th}>OT</th><th className={th}>Lotes</th><th className={`${th} text-right`}>Líneas</th></tr>}>
          {d.sospechosos?.map(x => <tr key={x.ot}><td className={td}><button type="button" onClick={() => onOpen(x.ot)} className="font-semibold text-[#002855] underline">{x.ot}</button></td>
            <td className={td}><p className="max-w-72 text-[11px] text-slate-600">{x.lotes.join(', ')}</p></td><td className={tdNum}>{fmtN(x.lineas)}</td></tr>)}
        </Table>
      </ChartCard>
    </div>
    <p className="text-[11px] text-slate-500">Almacenes: {Object.values(ALMACEN_LABEL).join(' · ')}.</p>
  </>
}
