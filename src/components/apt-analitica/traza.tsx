'use client'

import { useMemo, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { comercialRef, ordenRef } from '@/lib/apt-analitica/catalog'
import { fromDatasetRow } from '@/lib/apt-analitica/dataset'
import type { TransferKey } from '@/lib/apt-analitica/engine'
import { AREA_LABEL, CLASS_LABEL, type Movement } from '@/lib/apt-analitica/types'
import { useAnalitica } from './context'
import { FlowSankey, type FlowLink, type FlowNode } from './charts'
import { Card, Empty, Notice, Segmented, fmtDate, fmtNum } from './ui'

type Field = 'auto' | 'documento' | 'orden' | 'pedido' | 'lote' | 'producto'
const FIELD_LABEL: Record<Field, string> = { auto: 'Cualquiera', documento: 'Documento', orden: 'OT / OP', pedido: 'Pedido / contrato', lote: 'Lote', producto: 'Producto' }

function matchField(m: Movement, q: string, f: Field) {
  const eq = (v: string | null | undefined) => !!v && v.toUpperCase() === q
  switch (f) {
    case 'documento': return eq(m.numero)
    case 'orden': return eq(ordenRef(m))
    case 'pedido': return eq(m.contrato) || eq(comercialRef(m))
    case 'lote': return eq(m.lote)
    case 'producto': return eq(m.producto)
    default: return eq(m.numero) || eq(m.lote) || eq(m.numRel) || eq(m.contrato) || eq(m.producto)
  }
}

/** Diagrama bipartito origen → destino de los traspasos (una unidad); evita ciclos separando los lados */
export function transferFlow(transfers: TransferKey[], movements: Map<number, Movement>, unit: string | null) {
  const nodes: FlowNode[] = []
  const idx = new Map<string, number>()
  const node = (name: string) => { if (!idx.has(name)) { idx.set(name, nodes.length); nodes.push({ name }) } return idx.get(name)! }
  const acc = new Map<string, FlowLink>()
  for (const t of transfers) {
    if (t.unidad !== unit) continue
    const sBy = new Map<string, number>(), eBy = new Map<string, number>()
    for (const id of t.ids) { const m = movements.get(id); if (!m) continue; const map = m.side === 'S' ? sBy : eBy; map.set(m.bodega, (map.get(m.bodega) ?? 0) + m.qty) }
    const status = t.status === 'CONCILIADA' ? 'CONCILIADA' : 'PENDIENTE'
    const eTotal = [...eBy.values()].reduce((a, b) => a + b, 0)
    for (const [sb, sq] of sBy) {
      if (!eTotal) { const k = `${sb}|(sin entrada)|P`; const l = acc.get(k) ?? { source: node(`${sb} · origen`), target: node('(sin entrada registrada)'), value: 0, status: 'PENDIENTE' as const }; l.value += sq; acc.set(k, l); continue }
      for (const [eb, eq] of eBy) {
        const k = `${sb}|${eb}|${status}`
        const l = acc.get(k) ?? { source: node(`${sb} · origen`), target: node(`${eb} · destino`), value: 0, status }
        l.value += Math.min(sq, eTotal) * (eq / eTotal)
        acc.set(k, l)
      }
    }
    if (!sBy.size) for (const [eb, eq] of eBy) {
      const k = `(sin salida)|${eb}|P`
      const l = acc.get(k) ?? { source: node('(sin salida registrada)'), target: node(`${eb} · destino`), value: 0, status: 'PENDIENTE' as const }
      l.value += eq; acc.set(k, l)
    }
  }
  return { nodes, links: [...acc.values()] }
}

export function TrazaTab() {
  const { base, cat, analysis, setRawRow, openDrill } = useAnalitica()
  const supabase = useMemo(() => createClient(), [])
  const [q, setQ] = useState('')
  const [field, setField] = useState<Field>('auto')
  const [query, setQuery] = useState<{ q: string; f: Field } | null>(null)
  const [extra, setExtra] = useState<Movement[] | null>(null)
  const [loadingAll, setLoadingAll] = useState(false)

  const result = useMemo(() => {
    if (!query) return null
    const Q = query.q.trim().toUpperCase()
    const direct = base.accepted.filter(m => matchField(m, Q, query.f))
    const seen = new Set(direct.map(m => m.id))
    const merged = [...direct, ...(extra ?? []).filter(m => !seen.has(m.id) && matchField(m, Q, query.f))].sort((a, b) => a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : a.id - b.id)
    const ids = new Set(merged.map(m => m.id))
    const lots = new Set(merged.map(m => m.lote).filter(Boolean) as string[])
    const transfers = base.transfers.filter(t => t.ids.some(id => ids.has(id)))
    // Lotes relacionados por traspaso (cambio de lote en la misma clave): inferidos, no confirmados
    const related: Array<{ from: string[]; to: string[]; numero: string; fecha: string; producto: string; status: string }> = transfers
      .filter(t => t.lotChange).map(t => ({ from: t.lotsS, to: t.lotsE, numero: t.numero, fecha: t.fecha, producto: t.producto, status: t.status }))
    return { list: merged, lots, transfers, related }
  }, [query, base, extra])
  const { meta } = useAnalitica()
  const links = useMemo(() => !result ? [] : (meta?.links ?? []).filter(l => [l.fromRef, l.toRef].some(r => r.toUpperCase() === query?.q.trim().toUpperCase() || result.lots.has(r))), [result, meta, query])
  const unit = result?.list[0]?.unidad ?? analysis.unit
  const flowAll = useMemo(() => transferFlow(analysis.transfersInScope, base.byId, analysis.unit), [analysis, base])
  const flowSel = useMemo(() => result ? transferFlow(result.transfers, base.byId, unit) : null, [result, base, unit])

  const searchAll = async () => {
    if (!query) return
    setLoadingAll(true)
    const { data, error } = await supabase.rpc('apa_trace_rows', { p_q: query.q, p_limit: 3000 })
    setLoadingAll(false)
    if (error) return
    setExtra(((data ?? []) as unknown[][]).map(r => fromDatasetRow(r as never, cat)))
  }

  return <div className="space-y-4">
    <Card title="Buscar trazabilidad" subtitle="Documento, OT/OP, pedido o contrato, lote o producto (coincidencia exacta del identificador, sin igualar lote con OT ni pedido)">
      <form className="flex flex-wrap items-end gap-2" onSubmit={e => { e.preventDefault(); if (q.trim().length >= 2) { setExtra(null); setQuery({ q, f: field }) } }}>
        <label className="min-w-[14rem] flex-1"><span className="mb-0.5 block text-[10px] font-bold uppercase text-slate-500">Identificador</span>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="p. ej. 16339-S001, ND98-00000800, 2893-002" className="h-9 w-full rounded-lg border border-slate-300 px-2 text-sm" /></label>
        <Segmented label="Campo" value={field} onChange={setField} options={(Object.keys(FIELD_LABEL) as Field[]).map(id => ({ id, label: FIELD_LABEL[id] }))} />
        <button type="submit" className="flex h-9 items-center gap-1 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white"><Search className="h-4 w-4" aria-hidden />Buscar</button>
      </form>
    </Card>
    {result && <>
      {result.list.length === 0 ? <Empty title="Sin coincidencias en las bodegas del análisis">
        <button type="button" onClick={() => void searchAll()} className="mt-1 font-semibold text-[#002855]">{loadingAll ? 'Buscando…' : 'Buscar en todas las bodegas'}</button></Empty> : <>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          <span><b className="text-slate-900">{result.list.length.toLocaleString('es-PE')}</b> eventos · {result.lots.size} lote(s) · {result.transfers.length} clave(s) de traspaso</span>
          {extra === null && <button type="button" onClick={() => void searchAll()} className="font-semibold text-[#002855]">{loadingAll ? 'Buscando…' : 'Incluir todas las bodegas (origen fuera del APT)'}</button>}
          <button type="button" onClick={() => openDrill(`Trazabilidad de ${query!.q}`, result.list.map(m => m.id))} className="font-semibold text-[#002855]">Abrir en el explorador</button>
        </div>
        {(result.related.length > 0 || links.length > 0) && <Card title="Equivalencias de lote" subtitle="Inferidas: cambio de lote dentro de una misma clave de traspaso (pendientes de confirmar). Registradas: tabla de equivalencias.">
          <ul className="space-y-1 text-xs">
            {result.related.map((r, i) => <li key={`r${i}`} className="flex flex-wrap items-center gap-2"><span className="rounded border border-dashed border-amber-400 px-1.5 py-0.5 font-semibold text-amber-800">Inferido</span>
              <span>{r.from.join(', ')} → {r.to.join(', ')}</span><span className="text-slate-500">traspaso {r.numero} del {fmtDate(r.fecha)} · {r.producto} · {r.status === 'CONCILIADA' ? 'cantidades conciliadas' : 'con diferencia'}</span></li>)}
            {links.map(l => <li key={l.id} className="flex flex-wrap items-center gap-2"><span className={`rounded border px-1.5 py-0.5 font-semibold ${l.status === 'ANULADO' ? 'border-slate-300 text-slate-500 line-through' : 'border-emerald-300 text-emerald-800'}`}>
              {l.origin === 'SISTEMA' ? 'Sistema fuente' : l.origin === 'REGLA' ? 'Regla verificada' : 'Asignación manual'}</span>
              <span>{l.fromKind} {l.fromRef} → {l.toKind} {l.toRef}{l.qty ? ` · ${fmtNum(l.qty)} ${l.unidad ?? ''}` : ''}</span>{l.note && <span className="text-slate-500">{l.note}</span>}</li>)}
          </ul></Card>}
        <div className="grid gap-4 xl:grid-cols-5">
          <Card className="xl:col-span-2" title="Línea de tiempo" subtitle="Eventos por fecha (cantidades en su unidad)">
            <ol className="relative max-h-[32rem] space-y-3 overflow-y-auto border-l-2 border-slate-200 pl-4">
              {result.list.slice(0, 300).map(m => <li key={m.id} className="relative">
                <span className={`absolute -left-[1.4rem] top-0.5 flex h-4 w-4 items-center justify-center rounded-full ${m.side === 'E' ? 'bg-[#2a78d6]' : 'bg-[#eb6834]'}`} aria-hidden>
                  {m.side === 'E' ? <ArrowDownLeft className="h-3 w-3 text-white" /> : <ArrowUpRight className="h-3 w-3 text-white" />}</span>
                <p className="text-xs font-bold text-slate-800">{fmtDate(m.fecha)} · {m.side === 'E' ? 'Entrada' : 'Salida'} · {CLASS_LABEL[m.clase]}</p>
                <p className="text-xs text-slate-700">{fmtNum(m.qty)} {m.unidad} · {m.bodega}{m.area ? ` (${AREA_LABEL[m.area]})` : ''}</p>
                <p className="text-[11px] text-slate-500">{m.tipo} {m.numero} · lote {m.lote ?? 'sin lote'}{m.numRel ? ` · ${m.docRel ?? ''} ${m.numRel}` : ''}</p>
              </li>)}
              {result.list.length > 300 && <li className="text-xs text-slate-500">… y {result.list.length - 300} eventos más (ver tabla).</li>}
            </ol>
          </Card>
          <Card className="xl:col-span-3" title="Eventos" subtitle="Cada fila abre su registro original (archivo, hoja y fila)">
            <div className="max-h-[32rem] overflow-auto"><table className="w-full min-w-[44rem] text-xs">
              <thead className="sticky top-0 bg-white"><tr className="text-left text-slate-600"><th className="py-1">Fecha</th><th>Mov.</th><th>Bodega</th><th>Documento</th><th>Producto</th><th>Lote</th>
                <th className="text-right">Cantidad</th><th>Und.</th><th>Referencias</th></tr></thead>
              <tbody>{result.list.map(m => <tr key={m.id} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setRawRow(m.id)}>
                <td className="py-1">{fmtDate(m.fecha)}</td><td className={m.side === 'E' ? 'text-[#1d5fae]' : 'text-[#b6461c]'}>{m.side === 'E' ? 'Entrada' : 'Salida'}</td><td>{m.bodega}</td>
                <td>{m.tipo}<span className="block text-[10px] text-slate-500">{m.numero}</span></td><td>{m.producto}</td><td>{m.lote ?? '—'}</td>
                <td className="text-right tabular-nums">{fmtNum(m.qty)}</td><td>{m.unidad}</td><td className="text-[10px] text-slate-600">{[m.docRel && `${m.docRel} ${m.numRel ?? ''}`, m.contrato && `Contrato ${m.contrato}`].filter(Boolean).join(' · ')}</td></tr>)}</tbody>
            </table></div>
          </Card>
        </div>
        {flowSel && <Card title={`Flujo entre almacenes de la búsqueda · ${unit ?? ''}`} subtitle="Línea continua: traspaso conciliado. Punteada: pendiente, con diferencia o sin el otro lado.">
          <FlowSankey nodes={flowSel.nodes} links={flowSel.links} unit={unit} /></Card>}
      </>}
    </>}
    <Card title={`Diagrama de flujos entre almacenes · ${analysis.unit ?? ''}`} subtitle="Traspasos del alcance filtrado, de la bodega de origen a la de destino. Una sola unidad; los vínculos pendientes se distinguen con línea punteada.">
      <FlowSankey nodes={flowAll.nodes} links={flowAll.links} unit={analysis.unit} />
    </Card>
    {!result && <Notice>Busque un identificador para ver su línea de tiempo, los lotes relacionados y el flujo entre almacenes.</Notice>}
  </div>
}
