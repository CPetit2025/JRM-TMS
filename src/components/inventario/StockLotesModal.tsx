'use client'

import { useMemo, useRef, useState } from 'react'
import { Download, Loader2, Printer, Search } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { SortTh } from '@/components/apt/PphShared'
import { DiasPill, Table, td, tdNum, th } from '@/components/inventario/parts'
import { AlmacenTag, aptAlmacen } from '@/components/inventario/ambito'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { invApi } from '@/lib/inventario/api'
import { fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import { fmtDate } from '@/lib/apt/format'
import { fecha } from '@/lib/inventario/avance-contrato-excel'
import { conItems, type StockItemFila } from '@/lib/inventario/avance-contrato'
import { imprimirHoja } from './imprimir'
import { SincProponer } from './SincProponer'

const COLS: Array<{ k: keyof StockItemFila; l: string; left?: boolean }> = [
  { k: 'bodega', l: 'Bodega', left: true }, { k: 'items', l: 'Ítem', left: true }, { k: 'producto', l: 'Producto', left: true }, { k: 'lote', l: 'Lote', left: true },
  { k: 'qty', l: 'Stock' }, { k: 'kg', l: 'Peso' }, { k: 'despachado', l: 'Despachado' }, { k: 'pendiente', l: 'Pendiente' },
  { k: 'ultimo_despacho', l: 'Último despacho', left: true }, { k: 'fecha_ingreso', l: 'Ingreso', left: true }, { k: 'dias_bodega', l: 'En bodega' },
]
const TEXTO = ['bodega', 'items', 'producto', 'lote']

export function StockLotesModal({ ot, cliente, producto, alms, onClose, onFicha }: {
  ot: string; cliente?: string | null; producto?: string; alms: string[]; onClose: () => void; onFicha: () => void
}) {
  // Se busca por la OT (va en el lote) con el tope del servidor; producto y bodega se filtran aquí.
  // Sin filtro «comprometido»: inv_stock deja sin OT lotes como 16067-S004D que la lista sí cuenta.
  const r = useInvQuery(`stock-ot|${ot}`, () => invApi.stock({ q: ot, ambito: 'apt', orden: 'kg', limit: 2000, offset: 0 }))
  const li = useInvQuery(`contrato-lineas|${ot}`, () => invApi.contratoLineas(ot))
  const [q, setQ] = useState('')
  const [sort, setSort] = useState({ k: 'kg', desc: true })
  const [reporte, setReporte] = useState(false)
  // Sinceramiento: quien puede proponer marca los lotes que físicamente no existen
  const sinc = useInvQuery('sinc', () => invApi.sinc())
  const puede = !!sinc.data?.puede_proponer
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [proponer, setProponer] = useState(false)
  const kf = (f: { bodega: string; producto: string; lote: string | null }) => `${f.bodega}|${f.producto}|${f.lote}`
  const truncado = (r.data?.total ?? 0) > (r.data?.filas.length ?? 0)
  const filas = useMemo(() => {
    const deOt = (s: string | null) => !!s && s.toUpperCase().startsWith(ot) && !/\d/.test(s[ot.length] ?? '')
    const base = (r.data?.filas ?? []).filter(f => (deOt(f.ot) || deOt(f.lote)) && (!producto || f.producto === producto)
      && (!alms.length || alms.includes(aptAlmacen(f.bodega) ?? '')))
    const t = q.trim().toUpperCase()
    const out = conItems(base, li.data?.lineas ?? []).filter(f => !t || `${f.bodega} ${f.items} ${f.producto} ${f.glosa ?? ''} ${f.lote ?? ''}`.toUpperCase().includes(t))
    const val = (f: StockItemFila) => f[sort.k as keyof StockItemFila] as string | number | null
    // Vacíos al final; empate por peso
    return out.sort((a, b) => {
      const x = val(a), y = val(b)
      if (x === y) return b.kg - a.kg
      if (x === null || x === '') return 1
      if (y === null || y === '') return -1
      const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'es', { numeric: true })
      return sort.desc ? -d : d
    })
  }, [r.data, li.data, ot, producto, alms, q, sort])
  const kg = filas.reduce((t, f) => t + (f.kg_conocido ? f.kg : 0), 0)
  const onSort = (k: string) => setSort(s => ({ k, desc: s.k === k ? !s.desc : !TEXTO.includes(k) }))
  const filtros = [producto && `Producto ${producto}`, alms.length ? `Bodegas ${alms.join(' · ')}` : '647 · 540 · ST', q.trim() && `Búsqueda «${q.trim()}»`].filter(Boolean) as string[]
  const loading = r.loading || li.loading
  const elegidas = filas.filter(f => sel.has(kf(f)) && f.lote)
  const toggle = (k: string) => setSel(s => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  return (
    <Modal isOpen onClose={onClose} title={`Stock disponible · OT ${ot}`} maxWidth="max-w-[min(96vw,1400px)]"
      footer={<div className="flex flex-wrap justify-between gap-2">
        <div className="flex flex-wrap gap-2"><button type="button" onClick={onFicha} className="min-h-9 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-[#002855]">Ver ficha de la OT</button>
          {puede && <button type="button" onClick={() => setProponer(true)} disabled={!elegidas.length} title="Marque los lotes que físicamente no existen" className="min-h-9 rounded-lg border border-red-300 bg-white px-4 text-sm font-semibold text-[#cf152d] disabled:opacity-50">{sinc.data?.puede_autorizar ? 'Sincerar a SF' : 'Proponer sinceramiento'}{elegidas.length ? ` (${elegidas.length})` : ''}</button>}</div>
        <button type="button" onClick={() => setReporte(true)} disabled={!filas.length} className="flex min-h-9 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50"><Printer className="h-4 w-4" aria-hidden /> Reporte (vista previa)</button>
      </div>}>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <label className="flex min-h-9 w-72 items-center gap-2 rounded-lg border border-slate-300 px-2 text-sm"><Search className="h-4 w-4 text-slate-400" aria-hidden />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Ítem, producto, glosa, lote o bodega" aria-label="Filtrar el stock" className="w-full outline-none" /></label>
        <p className="text-xs text-slate-500">{filtros.join(' · ')} · {fmtN(filas.length)} producto·lote · {fmtPeso(kg)}{r.data?.corte ? ` · corte ${fmtDate(r.data.corte)}` : ''}</p>
      </div>
      <p className="mb-3 text-[11px] text-slate-500">Stock: saldo físico al corte en la bodega (FIFO por bodega · producto · lote). Despachado, pendiente y último despacho son del ítem del contrato (ERP).</p>
      {truncado && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">La búsqueda superó {fmtN(r.data?.filas.length ?? 0)} filas: puede faltar stock; vea la ficha de la OT.</p>}
      {li.error && <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">No se pudieron leer los ítems del contrato: {li.error}</p>}
      {loading ? <LoadingBlock label="Calculando el stock…" /> : r.error ? <ErrorBlock message={r.error} onRetry={r.reload} /> :
        <Table empty={!filas.length} head={<tr>{puede && <th className={th}><span className="sr-only">Elegir para sincerar</span></th>}{COLS.map(c => <SortTh key={c.k} label={c.l} k={c.k} sort={sort.k} desc={sort.desc} onSort={onSort} align={c.left ? 'left' : 'right'} />)}</tr>}>
          {filas.map(f => <tr key={kf(f)} className={sel.has(kf(f)) ? 'bg-red-50' : 'hover:bg-slate-50'}>
            {puede && <td className={td}><input type="checkbox" checked={sel.has(kf(f))} disabled={!f.lote} onChange={() => toggle(kf(f))} aria-label={`Sincerar el lote ${f.lote ?? ''} de ${f.bodega}`} className="h-4 w-4" /></td>}
            <td className={td}><p className="font-semibold text-slate-800">{f.bodega}</p><AlmacenTag almacen={aptAlmacen(f.bodega)} /></td>
            <td className={`${td} font-semibold text-[#002855]`}>{f.items || <span className="font-normal text-slate-400">Sin ítem</span>}</td>
            <td className={td}><p className="font-mono text-[11px] text-slate-500">{f.producto}</p><p className="max-w-72 text-slate-800">{f.glosa ?? '—'}</p></td>
            <td className={td}><p className="font-semibold">{f.lote ?? '—'}</p></td>
            <td className={tdNum}>{fmtQty(f.qty)} <span className="text-slate-400">{f.unidad ?? ''}</span></td>
            <td className={tdNum}>{f.kg_conocido ? fmtPeso(f.kg) : <span className="text-slate-400">Sin peso</span>}</td>
            <td className={tdNum}>{f.despachado === null ? '—' : fmtQty(f.despachado)}</td>
            <td className={`${tdNum} font-semibold`}>{f.pendiente === null ? '—' : fmtQty(f.pendiente)}</td>
            <td className={td}>{fmtDate(f.ultimo_despacho)}</td>
            <td className={td}>{f.fecha_ingreso ? fmtDate(f.fecha_ingreso) : <span className="text-amber-700">Saldo inicial</span>}</td>
            <td className={td}><DiasPill dias={f.dias_bodega} /></td>
          </tr>)}
        </Table>}
      {proponer && <SincProponer ot={ot} cliente={cliente} filas={elegidas} puedeAutorizar={!!sinc.data?.puede_autorizar} onClose={() => setProponer(false)} onDone={() => { setSel(new Set()); sinc.reload() }} />}
      {reporte && <ReporteStock filas={filas} meta={{ ot, cliente: cliente ?? null, corte: r.data?.corte ?? null, corteErp: li.data?.corte ?? null, filtros, generado: new Date() }} onClose={() => setReporte(false)} />}
    </Modal>
  )
}

type Meta = { ot: string; cliente: string | null; corte: string | null; corteErp: string | null; filtros: string[]; generado: Date }
const HEAD = ['BODEGA', 'ÍTEM', 'PRODUCTO', 'GLOSA', 'LOTE', 'UNIDAD', 'STOCK', 'PESO (KG)', 'DESPACHADO', 'PENDIENTE', 'ÚLT. DESPACHO', 'INGRESO', 'DÍAS']
const celdas = (f: StockItemFila) => [f.bodega, f.items, f.producto, f.glosa ?? '', f.lote ?? '', f.unidad ?? '', f.qty, f.kg_conocido ? f.kg : null,
  f.despachado, f.pendiente, f.ultimo_despacho ? fmtDate(f.ultimo_despacho) : '', f.fecha_ingreso ? fmtDate(f.fecha_ingreso) : 'Saldo inicial', f.dias_bodega]
const NUM = new Set([6, 7, 8, 9, 12])

/** Vista previa del reporte con la plantilla corporativa horizontal; imprime exactamente lo que se ve o lo descarga en Excel */
function ReporteStock({ filas, meta, onClose }: { filas: StockItemFila[]; meta: Meta; onClose: () => void }) {
  const hoja = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const kg = filas.reduce((t, f) => t + (f.kg_conocido ? f.kg : 0), 0)
  const imprimir = () => imprimirHoja(hoja.current, `Stock disponible OT ${meta.ot}`, 'landscape')
  const descargar = async () => {
    setBusy(true); setError('')
    try { await descargarExcel(filas, meta, kg) } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo generar el Excel') } finally { setBusy(false) }
  }
  return <Modal isOpen onClose={onClose} title="Vista previa del reporte" maxWidth="max-w-[min(96vw,1500px)]"
    footer={<div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-slate-500">Horizontal · A4 · {fmtN(filas.length)} filas · mismo filtro y orden que la tabla</p>
      <div className="flex gap-2">{error && <p role="alert" className="self-center text-xs text-red-700">{error}</p>}
        <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cerrar</button>
        <button type="button" disabled={busy} onClick={() => void descargar()} className="flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-[#002855] disabled:opacity-60">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Download className="h-4 w-4" aria-hidden />} Excel</button>
        <button type="button" onClick={imprimir} className="flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white"><Printer className="h-4 w-4" aria-hidden /> Imprimir</button></div>
    </div>}>
    <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-200 p-4">
      <div ref={hoja} className="mx-auto w-max min-w-full bg-white p-5 shadow-lg" style={{ fontFamily: 'Calibri, Carlito, system-ui, sans-serif' }}>
        <div className="flex items-stretch gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-jrm-sia.png" alt="JRM" className="h-14 w-auto object-contain" />
          <div className="flex-1"><p className="text-xl font-bold text-[#002855]">STOCK DISPONIBLE POR LOTE</p><p className="text-sm font-bold text-[#d71920]">OT {meta.ot}{meta.cliente ? ` · ${meta.cliente}` : ''}</p></div>
          <div className="space-y-0.5 text-right text-[10px] text-slate-900">
            <p><b className="text-slate-500">Corte stock:</b> {fecha(meta.corte)}</p><p><b className="text-slate-500">Corte contrato ERP:</b> {fecha(meta.corteErp)}</p><p><b className="text-slate-500">Generado:</b> {fecha(meta.generado)}</p>
            <p className="max-w-72"><b className="text-slate-500">Filtros:</b> {meta.filtros.join(' · ') || 'Ninguno'}</p></div>
        </div>
        <div className="mt-2 h-1 bg-[#002855]" /><div className="mb-3 h-0.5 bg-[#d71920]" />
        <table className="w-full border-collapse text-[10px] text-slate-900">
          <thead><tr>{HEAD.map((h, i) => <th key={h} className={`border border-slate-200 bg-[#002855] px-1.5 py-1 text-white ${NUM.has(i) ? 'text-right' : 'text-left'}`}>{h}</th>)}</tr></thead>
          <tbody>
            {filas.map((f, idx) => <tr key={`${f.bodega}|${f.producto}|${f.lote}`} className={`border-b border-slate-200 align-top ${idx % 2 ? '' : 'bg-[#fbfcfe]'}`}>
              {celdas(f).map((v, i) => <td key={i} className={`px-1.5 py-0.5 ${NUM.has(i) ? 'text-right tabular-nums' : ''} ${i === 1 ? 'font-bold text-[#002855]' : ''} ${i === 3 ? 'max-w-72' : ''}`}>
                {v === null || v === '' ? '—' : typeof v === 'number' ? v.toLocaleString('es-PE', { maximumFractionDigits: 3 }) : v}</td>)}
            </tr>)}
            <tr className="border-t-2 border-[#002855] bg-[#e8eef7] font-bold text-[#002855]"><td colSpan={7} className="px-1.5 py-1">TOTAL · {fmtN(filas.length)} producto·lote</td>
              <td className="px-1.5 text-right">{kg.toLocaleString('es-PE', { maximumFractionDigits: 1 })}</td><td colSpan={5} /></tr>
          </tbody>
        </table>
        <p className="mt-2 text-[9px] text-slate-500">Stock: saldo físico al corte (FIFO por bodega · producto · lote). Despachado, pendiente y último despacho: ítem del contrato según el ERP.</p>
      </div>
    </div>
  </Modal>
}

async function descargarExcel(filas: StockItemFila[], meta: Meta, kg: number) {
  const ExcelJS = (await import('exceljs')).default
  const logo = await fetch('/logo-jrm-sia.png').then(r => (r.ok ? r.arrayBuffer() : null)).catch(() => null)
  const wb = new ExcelJS.Workbook(); wb.creator = 'JRM TMS'; wb.created = meta.generado
  const ws = wb.addWorksheet('Stock por lote', { views: [{ state: 'frozen', ySplit: 6, showGridLines: false }] })
  ws.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, horizontalCentered: true, printTitlesRow: '6:6',
    margins: { left: 0.3, right: 0.3, top: 0.45, bottom: 0.5, header: 0.2, footer: 0.25 } } as never
  ws.headerFooter = { oddFooter: `&L&8JRM · Stock disponible OT ${meta.ot}&C&8Página &P de &N&R&8Generado ${fecha(meta.generado)}` }
  const n = HEAD.length
  ;[14, 12, 20, 44, 14, 8, 10, 11, 11, 11, 12, 12, 7].forEach((w, i) => { ws.getColumn(i + 1).width = w })
  for (let r = 1; r <= 3; r++) ws.getRow(r).height = 22
  ws.mergeCells(1, 1, 3, 2)
  if (logo) ws.addImage(wb.addImage({ buffer: logo, extension: 'png' }), { tl: { col: 0.15, row: 0.2 }, ext: { width: 150, height: 70 }, editAs: 'oneCell' })
  ws.mergeCells(1, 3, 2, n - 3); ws.mergeCells(3, 3, 3, n - 3)
  const t = ws.getCell(1, 3); t.value = 'STOCK DISPONIBLE POR LOTE'; t.font = { size: 18, bold: true, color: { argb: 'FF002855' } }; t.alignment = { vertical: 'middle' }
  const s = ws.getCell(3, 3); s.value = `OT ${meta.ot}${meta.cliente ? ` · ${meta.cliente}` : ''}`; s.font = { size: 11, bold: true, color: { argb: 'FFD71920' } }
  ;[['Corte stock', fecha(meta.corte)], ['Corte contrato ERP', fecha(meta.corteErp)], ['Generado', `${fecha(meta.generado)} · Filtros: ${meta.filtros.join(' · ') || 'Ninguno'}`]].forEach(([k, v], i) => {
    ws.mergeCells(i + 1, n - 2, i + 1, n)
    const c = ws.getCell(i + 1, n - 2); c.value = `${k}: ${v}`; c.font = { size: 9 }; c.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true }
  })
  ws.getRow(4).height = 5; ws.getRow(5).height = 3
  for (let c = 1; c <= n; c++) {
    ws.getCell(4, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002855' } }
    ws.getCell(5, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD71920' } }
  }
  const h = ws.getRow(6); h.values = HEAD; h.height = 20
  h.eachCell(c => { c.font = { size: 9, bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002855' } }; c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true } })
  filas.forEach(f => {
    const row = ws.addRow(celdas(f)); row.font = { size: 9 }
    NUM.forEach(i => { const c = row.getCell(i + 1); c.numFmt = '#,##0.###'; c.alignment = { horizontal: 'right' } })
    row.getCell(2).font = { size: 9, bold: true, color: { argb: 'FF002855' } }
  })
  const tot = ws.addRow(['TOTAL', `${filas.length} producto·lote`, '', '', '', '', '', kg]); tot.font = { size: 9, bold: true, color: { argb: 'FF002855' } }; tot.getCell(8).numFmt = '#,##0.0'
  const url = URL.createObjectURL(new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))
  const a = document.createElement('a'); a.href = url; a.download = `Stock-disponible-OT-${meta.ot}.xlsx`; a.click(); URL.revokeObjectURL(url)
}
