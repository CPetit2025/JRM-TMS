'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ArrowLeft, Download, Search } from 'lucide-react'
import { ChartCard, EmptyState, ErrorBlock, InlineBar, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { DiasPill, Table, td, tdNum, th } from '@/components/inventario/parts'
import { ALMACENES, ALMACEN_LABEL, AlmacenTag, aptAlmacen } from '@/components/inventario/ambito'
import { Modal } from '@/components/ui/modal'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { Kardex } from '@/components/inventario/Kardex'
import { AvanceContrato } from '@/components/inventario/AvanceContrato'
import { invApi } from '@/lib/inventario/api'
import { fmtN, fmtN1, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { AptAlmacen, InvContrato, InvContratoFila, InvContratoProductoFila } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'
import { exportAptXlsx } from '@/lib/apt/export'
import { MultiSelect } from '@/components/apt/AptFilterBar'
import { SortTh } from '@/components/apt/PphShared'

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

type Estado = '' | 'stock' | 'curso' | 'cerradas'
// Por OT, o la misma fila desglosada por OT + producto (código y glosa)
type Fila = InvContratoFila | InvContratoProductoFila
const esProducto = (c: Fila): c is InvContratoProductoFila => 'producto' in c
const TEXTO = ['ot', 'cliente', 'producto', 'glosa']
const cmpTxt = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true })
const KG = { '647': 'stock_647_kg', '540': 'stock_540_kg', ST: 'stock_st_kg' } as const

function Lista({ onOpen }: { onOpen: (q: string) => void }) {
  const q = useInvQuery('contratos', () => invApi.contratos())
  const [filtro, setFiltro] = useState('')
  const [estado, setEstado] = useState<Estado>('stock')
  const [sort, setSort] = useState({ k: 'stock_kg', desc: true })
  const [selOt, setSelOt] = useState<string[]>([])
  const [selCli, setSelCli] = useState<string[]>([])
  // Bodegas elegidas: el stock, el estado, el orden, los KPIs y el Excel cuentan solo esas
  const [alms, setAlms] = useState<string[]>([])
  const [lotesDe, setLotesDe] = useState<{ ot: string; producto?: string } | null>(null)
  const sk = useMemo(() => (c: Fila) => alms.length ? alms.reduce((t, a) => t + c[KG[a as AptAlmacen]], 0) : c.stock_kg, [alms])
  const ver1 = (a: AptAlmacen) => !alms.length || alms.includes(a)
  // Columna nueva: texto de A a Z, números de mayor a menor; misma columna: invierte
  const onSort = (k: string) => setSort(s => ({ k, desc: s.k === k ? !s.desc : !TEXTO.includes(k) }))
  const opts = useMemo(() => {
    const cs = q.data?.contratos ?? []
    return { ots: cs.map(c => c.ot).sort(cmpTxt), clientes: [...new Set(cs.map(c => c.cliente ?? '').filter(Boolean))].sort(cmpTxt), cliente: new Map(cs.map(c => [c.ot, c.cliente])) }
  }, [q.data])
  const pick = useMemo(() => {
    const ots = new Set(selOt), clis = new Set(selCli)
    return (c: Fila) => (!ots.size || ots.has(c.ot)) && (!clis.size || clis.has(c.cliente ?? ''))
  }, [selOt, selCli])
  const [ver, setVer] = useState<'ot' | 'producto'>('ot')
  const pq = useInvQuery(ver === 'producto' ? `contratos_producto|${estado}` : 'contratos_producto|off',
    () => ver === 'producto' ? invApi.contratosProducto(estado) : Promise.resolve(null))
  const rows = useMemo(() => {
    const f = filtro.trim().toUpperCase()
    const base: Fila[] = (ver === 'producto' ? pq.data?.filas : q.data?.contratos) ?? []
    const out = base.filter(c => pick(c) && (!f || c.ot.includes(f) || (c.cliente ?? '').toUpperCase().includes(f)
        || (esProducto(c) && (c.producto.toUpperCase().includes(f) || (c.glosa ?? '').toUpperCase().includes(f))))
      && (estado === '' || (estado === 'stock' ? sk(c) > 0 : estado === 'curso' ? sk(c) > 0 || (c.avance_pct ?? 0) < 100 : sk(c) <= 0)))
    const val = (c: Fila) => sort.k === 'stock_kg' ? sk(c) : (c as unknown as Record<string, string | number | null>)[sort.k] ?? null
    // Vacíos siempre al final; empate por stock
    return out.sort((a, b) => {
      const x = val(a), y = val(b)
      if (x === y) return sk(b) - sk(a)
      if (x === null || x === '') return 1
      if (y === null || y === '') return -1
      const d = typeof x === 'number' && typeof y === 'number' ? x - y : cmpTxt(String(x), String(y))
      return sort.desc ? -d : d
    })
  }, [q.data, pq.data, ver, filtro, estado, sort, pick, sk])
  if (q.loading) return <LoadingBlock label="Cargando contratos…" />
  if (q.error) return <ErrorBlock message={q.error} onRetry={q.reload} />
  if (!q.data?.contratos.length) return <EmptyState title="Sin contratos en el APT">Aún no hay movimientos con lote de OT en los almacenes 647, 540 y ST.</EmptyState>
  const all = q.data.contratos.filter(pick)
  const H = (k: string, l: string, left = false) => <SortTh key={k} label={l} k={k} sort={sort.k} desc={sort.desc} onSort={onSort} align={left ? 'left' : 'right'} />
  const conStock = all.filter(c => sk(c) > 0)
  const stockKg = conStock.reduce((t, c) => t + sk(c), 0)
  const viejas = conStock.filter(c => (c.dias_stock ?? 0) > 60)
  const conFecha = all.filter(c => c.a_tiempo_pct !== null)
  const exportar = () => exportAptXlsx(`contratos-${ver === 'producto' ? 'producto-' : ''}apt-${q.data?.corte ?? ''}`, { [ver === 'producto' ? 'Por producto' : 'Contratos']: rows.map(c => ({
    OT: c.ot, Cliente: c.cliente ?? '',
    ...(esProducto(c) ? { 'Código producto': c.producto, Glosa: c.glosa ?? '', Unidad: c.unidad ?? '' } : { Productos: c.productos }), Lotes: c.lotes, Guías: c.guias, 'Ingresado kg': c.ingresado_kg, 'Despachado kg': c.despachado_kg,
    'Avance %': c.avance_pct ?? '', 'Stock kg': sk(c), ...(ver1('647') ? { 'Stock 647 kg': c.stock_647_kg } : {}), ...(ver1('540') ? { 'Stock 540 kg': c.stock_540_kg } : {}), ...(ver1('ST') ? { 'Stock ST kg': c.stock_st_kg } : {}),
    'Días en stock': c.dias_stock ?? '', 'Entrega comprometida': c.fecha_entrega ?? '', 'A tiempo %': c.a_tiempo_pct ?? '',
    'Primer ingreso': c.primer_ingreso ?? '', 'Último ingreso': c.ultimo_ingreso ?? '', 'Última salida': c.ultima_salida ?? '',
  })) })
  return <>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <KpiCard label="OT con stock en el APT" value={fmtN(conStock.length)} tone="navy" hint={`de ${fmtN(all.length)} OT ${selOt.length || selCli.length ? 'seleccionadas' : 'con movimiento'} · corte ${fmtDate(q.data?.corte)}`} />
      <KpiCard label="Stock comprometido" value={fmtPeso(stockKg)} hint="Saldo de lotes de OT en 647 · 540 · ST" />
      <KpiCard label="OT con stock > 60 días" value={fmtN(viejas.length)} tone={viejas.length ? 'warn' : 'ok'} hint={fmtPeso(viejas.reduce((t, c) => t + sk(c), 0))} />
      <KpiCard label="Despachos a tiempo" value={conFecha.length ? `${fmtN1(conFecha.reduce((t, c) => t + (c.a_tiempo_pct ?? 0), 0) / conFecha.length)} %` : '—'}
        hint="Promedio por OT · guía con fecha ≤ entrega comprometida" />
    </div>
    <ChartCard title={ver === 'producto' ? 'Contratos / OT por producto' : 'Contratos / OT'} subtitle={ver === 'producto' ? `${fmtN(rows.length)} filas OT · producto` : `${fmtN(rows.length)} OT`}
      info="Avance = kg despachados / kg ingresados al APT (sin contar dos veces el traspaso 647 → ST de la misma OT). Días en stock: desde el ingreso más antiguo que aún tiene saldo."
      actions={<button type="button" onClick={exportar} disabled={!rows.length} className="flex min-h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" /> Excel</button>}>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-slate-600">Ver
          <select value={ver} onChange={e => setVer(e.target.value as 'ot' | 'producto')} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="ot">Por OT</option><option value="producto">Por OT y producto</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">Filtrar
          <input value={filtro} onChange={e => { setFiltro(e.target.value) }} placeholder={ver === 'producto' ? 'OT, cliente o producto' : 'OT o cliente'}className="mt-1 block min-h-10 w-56 rounded-lg border border-slate-300 px-2 text-sm" />
        </label>
        <label className="text-xs font-semibold text-slate-600">Estado
          <select value={estado} onChange={e => { setEstado(e.target.value as Estado) }} className="mt-1 block min-h-10 rounded-lg border border-slate-300 px-2 text-sm">
            <option value="stock">Con stock en el APT</option><option value="curso">En curso (stock o avance &lt; 100 %)</option><option value="cerradas">Sin stock</option><option value="">Todas</option>
          </select>
        </label>
        <div className="text-xs font-semibold text-slate-600">Contratos
          <div className="mt-1 flex gap-2">
            <MultiSelect label="OT" options={opts.ots} value={selOt} onChange={setSelOt} searchable width="w-80"
              render={o => <>{o} <span className="text-slate-400">· {opts.cliente.get(o) ?? '—'}</span></>} />
            <MultiSelect label="Cliente" options={opts.clientes} value={selCli} onChange={setSelCli} searchable width="w-80" />
            <MultiSelect label="Bodega" options={ALMACENES} value={alms} onChange={setAlms} render={a => ALMACEN_LABEL[a as AptAlmacen]} />
          </div>
        </div>
        <p className="pb-2 text-[11px] text-slate-500">Clic en un encabezado para ordenar.</p>
      </div>
      {ver === 'producto' && pq.loading && <LoadingBlock label="Cargando el detalle por producto…" />}
      {ver === 'producto' && pq.error && <ErrorBlock message={pq.error} onRetry={pq.reload} />}
      {!(ver === 'producto' && (pq.loading || pq.error)) && <Table empty={!rows.length} head={<tr>{H('ot', 'OT', true)}{H('cliente', 'Cliente', true)}{ver === 'producto' && <>{H('producto', 'Código', true)}{H('glosa', 'Glosa', true)}</>}{H('ingresado_kg', 'Ingresado')}{H('despachado_kg', 'Despachado')}{H('avance_pct', 'Avance', true)}
        {H('stock_kg', 'Stock')}{ver1('647') && H('stock_647_kg', '647')}{ver1('540') && H('stock_540_kg', '540')}{ver1('ST') && H('stock_st_kg', 'ST')}{H('dias_stock', 'Días', true)}
        {H('fecha_entrega', 'Entrega', true)}{H('a_tiempo_pct', 'A tiempo')}{H('ultimo_ingreso', 'Último ingreso', true)}{H('ultima_salida', 'Última salida', true)}</tr>}>
        {rows.map(c => <tr key={esProducto(c) ? `${c.ot}|${c.producto}` : c.ot} className="hover:bg-slate-50">
          <td className={td}><button type="button" onClick={() => onOpen(c.ot)} className="font-bold text-[#002855] underline">{c.ot}</button>
            <p className="text-[10px] text-slate-500">{esProducto(c) ? '' : `${fmtN(c.productos)} ID · `}<button type="button" onClick={() => setLotesDe({ ot: c.ot, producto: esProducto(c) ? c.producto : undefined })} title="Ver el stock disponible de los lotes" className="font-semibold text-[#002855] underline">{fmtN(c.lotes)} lotes</button></p></td>
          <td className={td}><p className="max-w-56 truncate" title={c.cliente ?? ''}>{c.cliente ?? '—'}</p></td>
          {esProducto(c) && <><td className={`${td} whitespace-nowrap font-semibold`}>{c.producto}</td>
            <td className={td}><p className="max-w-64 truncate" title={c.glosa ?? ''}>{c.glosa ?? '—'}</p></td></>}
          <td className={tdNum}>{fmtPeso(c.ingresado_kg)}</td><td className={tdNum}>{fmtPeso(c.despachado_kg)}</td>
          <td className={`${td} min-w-28`}><div className="flex items-center gap-2"><InlineBar value={c.avance_pct ?? 0} max={100} color={(c.avance_pct ?? 0) >= 100 ? '#0d9488' : '#002855'} /><span className="tabular-nums">{c.avance_pct === null ? '—' : `${fmtN(c.avance_pct)} %`}</span></div></td>
          <td className={`${tdNum} font-semibold`}>{sk(c) > 0 ? fmtPeso(sk(c)) : '—'}</td>
          {ALMACENES.filter(ver1).map(a => <td key={a} className={tdNum}>{c[KG[a]] > 0 ? fmtPeso(c[KG[a]]) : '—'}</td>)}
          <td className={td}>{sk(c) > 0 ? <DiasPill dias={c.dias_stock} /> : '—'}</td>
          <td className={td}>{fmtDate(c.fecha_entrega)}</td><td className={tdNum}>{c.a_tiempo_pct === null ? '—' : `${fmtN(c.a_tiempo_pct)} %`}</td>
          <td className={td}>{fmtDate(c.ultimo_ingreso)}</td><td className={td}>{fmtDate(c.ultima_salida)}</td>
        </tr>)}
      </Table>}
    </ChartCard>
    {lotesDe && <StockLotes {...lotesDe} alms={alms} onClose={() => setLotesDe(null)} onFicha={() => { setLotesDe(null); onOpen(lotesDe.ot) }} />}
  </>
}

// Stock disponible de los lotes de una OT (y de un producto en la vista por producto) sin salir de la lista
function StockLotes({ ot, producto, alms, onClose, onFicha }: { ot: string; producto?: string; alms: string[]; onClose: () => void; onFicha: () => void }) {
  const r = useInvQuery(`stock-ot|${ot}|${producto ?? ''}`, () => invApi.stock({ q: producto ?? ot, ambito: 'apt', estado: 'comprometido', orden: 'kg', limit: 500, offset: 0 }))
  // La búsqueda del servidor es por texto: se dejan solo los lotes de esta OT (y sus subcontratos)
  const filas = (r.data?.filas ?? []).filter(f => (f.ot === ot || f.ot?.startsWith(`${ot}-`)) && (!producto || f.producto === producto)
    && (!alms.length || alms.includes(aptAlmacen(f.bodega) ?? '')))
  const kg = filas.reduce((t, f) => t + (f.kg_conocido ? f.kg : 0), 0)
  return (
    <Modal isOpen onClose={onClose} title={`Stock disponible · OT ${ot}`} maxWidth="max-w-5xl"
      footer={<button type="button" onClick={onFicha} className="min-h-9 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white">Ver ficha de la OT</button>}>
      <p className="mb-3 text-xs text-slate-500">{producto ? `Producto ${producto} · ` : ''}{alms.length ? `Bodegas ${alms.join(' · ')}` : '647 · 540 · ST'} · {fmtN(filas.length)} producto·lote · {fmtPeso(kg)}{r.data?.corte ? ` · corte ${fmtDate(r.data.corte)}` : ''}</p>
      {r.loading ? <LoadingBlock label="Calculando el stock…" /> : r.error ? <ErrorBlock message={r.error} onRetry={r.reload} /> :
        <Table empty={!filas.length} head={<tr><th className={th}>Bodega</th><th className={th}>Producto</th><th className={th}>Lote</th><th className={`${th} text-right`}>Cantidad</th><th className={`${th} text-right`}>Peso</th><th className={th}>Ingreso</th><th className={th}>En bodega</th></tr>}>
          {filas.map(f => <tr key={`${f.bodega}|${f.producto}|${f.lote}`} className="hover:bg-slate-50">
            <td className={td}><p className="font-semibold text-slate-800">{f.bodega}</p><AlmacenTag almacen={aptAlmacen(f.bodega)} /></td>
            <td className={td}><p className="font-mono text-[11px] text-slate-500">{f.producto}</p><p className="max-w-72 text-slate-800">{f.glosa ?? '—'}</p></td>
            <td className={td}><p className="font-semibold">{f.lote ?? '—'}</p><p className="text-[10px] text-slate-500">OT {f.ot}</p></td>
            <td className={tdNum}>{fmtQty(f.qty)} <span className="text-slate-400">{f.unidad ?? ''}</span></td>
            <td className={tdNum}>{f.kg_conocido ? fmtPeso(f.kg) : <span className="text-slate-400">Sin peso</span>}</td>
            <td className={td}>{f.fecha_ingreso ? fmtDate(f.fecha_ingreso) : <span className="text-amber-700">Saldo inicial</span>}</td>
            <td className={td}><DiasPill dias={f.dias_bodega} /></td>
          </tr>)}
        </Table>}
    </Modal>
  )
}

function exportFicha(d: InvContrato) {
  exportAptXlsx(`ot-${d.ot}-${d.corte ?? ''}`, {
    IDs: (d.productos ?? []).map(p => ({ ID: p.producto, Glosa: p.glosa ?? '', Unidad: p.unidad ?? '', Lotes: p.lotes.join(', '),
      Ingresado: p.ingresado, Producido: p.producido, Despachado: p.despachado, 'Otras salidas': p.otras_salidas,
      'Stock 647': p.stock_647, 'Stock 540': p.stock_540, 'Stock ST': p.stock_st, 'Stock total': p.stock, 'Stock kg': p.stock_kg, 'Stock TN': Math.round(p.stock_kg) / 1000,
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
  const [kardexId, setKardexId] = useState('')
  const verKardex = (p: string) => { setKardexId(p); document.getElementById('kardex')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  if (r.loading) return <LoadingBlock label={`Buscando la OT ${q}…`} />
  if (r.error) return <ErrorBlock message={r.error} onRetry={r.reload} />
  const d = r.data
  if (!d) return null
  if (!d.encontrado || !d.resumen) {
    return <>
      <EmptyState title={`La OT ${d.ot} no tiene movimientos en el APT`}>Revise el número o búsquelo en <Link href={`/apt/trazabilidad?q=${encodeURIComponent(q)}`} className="font-semibold text-[#002855] underline">Trazabilidad</Link> (todas las bodegas).</EmptyState>
      <AvanceContrato q={q} ot={d.ot} productos={[]} />
    </>
  }
  const s = d.resumen
  return <>
    <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Contrato / OT</p>
        <h2 className="text-2xl font-black text-[#002855]">{d.ot}</h2>
        <p className="text-sm font-semibold text-slate-700">{s.cliente ?? 'Cliente no identificado'}</p>
        <p className="mt-1 text-xs text-slate-500">{fmtN(s.productos)} ID · {fmtN(s.lotes)} lotes · {fmtN(s.guias)} guías · corte {fmtDate(d.corte)}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => verKardex('')} className="flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]">Ingresos, salidas y saldo</button>
        <Link href={`/apt/estadia?ver=producto&ot=${encodeURIComponent(d.ot)}`} className="flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]">Estadía por ID</Link>
        <Link href={`/apt/trazabilidad?q=${encodeURIComponent(d.ot)}`} className="flex min-h-9 items-center rounded-lg border border-slate-300 bg-white px-3 text-xs font-semibold text-[#002855]">Trazabilidad</Link>
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
    <AvanceContrato q={q} ot={d.ot} cliente={s.cliente} productos={d.productos ?? []} onKardex={verKardex} />
    <div id="kardex" className="scroll-mt-4"><Kardex ot={d.ot} productos={d.productos ?? []} producto={kardexId} onProducto={setKardexId} /></div>
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
