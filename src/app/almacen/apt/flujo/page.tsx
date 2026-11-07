'use client'

import { useMemo, useState } from 'react'
import { ResponsiveContainer, Sankey, Tooltip } from 'recharts'
import { ChartCard, ErrorBlock, LoadingBlock } from '@/components/apt/ui'
import { DiasPill, PeriodBar, Table, td, tdNum, th } from '@/components/inventario/parts'
import { useInvQuery } from '@/components/inventario/useInvQuery'
import { ProductoCell, aptAlmacen, useAmbito } from '@/components/inventario/ambito'
import { invApi } from '@/lib/inventario/api'
import { CLASE_COLOR, CLASE_LABEL, KIND_COLOR, fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import type { InvClase, InvFlow, InvKind } from '@/lib/inventario/types'
import { fmtDate } from '@/lib/apt/format'

type Metric = 'kg' | 'lineas'
type Node = { name: string; color: string }

// Grafo sin ciclos (requisito del diagrama): ingresos por clase → bodegas → salidas por clase. Los traspasos que
// cerrarían un ciclo (A → B y B → A) se omiten del diagrama y se listan en la tabla.
function buildSankey(d: InvFlow, metric: Metric) {
  const nodes: Node[] = []
  const index = new Map<string, number>()
  const kindOf = new Map(d.bodegas.map(b => [b.code, b.kind]))
  const node = (key: string, name: string, color: string) => {
    if (!index.has(key)) { index.set(key, nodes.length); nodes.push({ name, color }) }
    return index.get(key)!
  }
  const adj = new Map<number, Set<number>>()
  const reaches = (from: number, to: number) => {
    const seen = new Set<number>(), stack = [from]
    while (stack.length) {
      const n = stack.pop()!
      if (n === to) return true
      if (seen.has(n)) continue
      seen.add(n)
      adj.get(n)?.forEach(x => stack.push(x))
    }
    return false
  }
  const links: Array<{ source: number; target: number; value: number }> = []
  let omitted = 0
  const val = (x: { kg: number; lineas: number }) => (metric === 'kg' ? x.kg : x.lineas)
  const cand: Array<{ s: number; t: number; v: number }> = []
  const bodegaNode = (code: string) => node(`b:${code}`, code, KIND_COLOR[(kindOf.get(code) ?? 'OTRO') as InvKind])
  d.ingresos.forEach(i => { if (val(i) > 0) cand.push({ s: node(`in:${i.clase}`, `${CLASE_LABEL[i.clase] ?? i.clase} →`, CLASE_COLOR[i.clase] ?? '#94a3b8'), t: bodegaNode(i.bodega), v: val(i) }) })
  d.traspasos.forEach(t => { if (val(t) > 0 && t.origen !== t.destino) cand.push({ s: bodegaNode(t.origen), t: bodegaNode(t.destino), v: val(t) }) })
  d.salidas.forEach(o => { if (val(o) > 0) cand.push({ s: bodegaNode(o.bodega), t: node(`out:${o.clase}`, `→ ${CLASE_LABEL[o.clase] ?? o.clase}`, CLASE_COLOR[o.clase] ?? '#94a3b8'), v: val(o) }) })
  cand.sort((a, b) => b.v - a.v).forEach(c => {
    if (reaches(c.t, c.s)) { omitted++; return }
    if (!adj.has(c.s)) adj.set(c.s, new Set())
    adj.get(c.s)!.add(c.t)
    links.push({ source: c.s, target: c.t, value: c.v })
  })
  return { nodes, links, omitted }
}

function SankeyNode(props: { x?: number; y?: number; width?: number; height?: number; payload?: Node & { value?: number }; containerWidth?: number }) {
  const { x = 0, y = 0, width = 0, height = 0, payload, containerWidth = 0 } = props
  if (!payload) return null
  const right = x + width + 6 + 160 > containerWidth
  return (
    <g>
      <rect x={x} y={y} width={width} height={Math.max(height, 1)} fill={payload.color} rx={2} />
      {height > 6 && <text x={right ? x - 6 : x + width + 6} y={y + height / 2} dy="0.35em" textAnchor={right ? 'end' : 'start'} fontSize={11} fill="#334155">{payload.name}</text>}
    </g>
  )
}

// Ámbito APT: ingresos y salidas de 647 · 540 · ST y los traspasos que entran o salen de ellos
function soloApt(d: InvFlow): InvFlow {
  const traspasos = d.traspasos.filter(t => aptAlmacen(t.origen) || aptAlmacen(t.destino))
  const usadas = new Set(traspasos.flatMap(t => [t.origen, t.destino]))
  return { ...d, traspasos, bodegas: d.bodegas.filter(b => aptAlmacen(b.code) || usadas.has(b.code)),
    ingresos: d.ingresos.filter(i => aptAlmacen(i.bodega)), salidas: d.salidas.filter(o => aptAlmacen(o.bodega)),
    reasignaciones: d.reasignaciones.filter(r => aptAlmacen(r.origen) || aptAlmacen(r.destino)) }
}

// Flujo entre almacenes: de dónde entra el material, cómo se mueve entre bodegas y cómo sale
export default function InventarioFlujoPage() {
  const [period, setPeriod] = useState({ desde: '', hasta: '' })
  const [metric, setMetric] = useState<Metric>('kg')
  const q = useInvQuery(`flow|${period.desde}|${period.hasta}`, () => invApi.flow({ desde: period.desde || undefined, hasta: period.hasta || undefined }))
  const apt = useAmbito() === 'apt'
  const d = useMemo(() => (q.data && apt ? soloApt(q.data) : q.data), [q.data, apt])
  const sk = useMemo(() => (d ? buildSankey(d, metric) : null), [d, metric])
  const clases = (rows: Array<{ clase: InvClase; kg: number; lineas: number }>) => {
    const m = new Map<InvClase, { kg: number; lineas: number }>()
    rows.forEach(r => { const o = m.get(r.clase) ?? { kg: 0, lineas: 0 }; o.kg += r.kg; o.lineas += r.lineas; m.set(r.clase, o) })
    return [...m.entries()].sort((a, b) => b[1].kg - a[1].kg)
  }
  return (
    <div className="space-y-4">
      <PeriodBar desde={period.desde || d?.desde || ''} hasta={period.hasta || d?.hasta || ''} onChange={(a, b) => setPeriod({ desde: a, hasta: b })}>
        <div role="group" aria-label="Medida" className="flex rounded-lg border border-slate-300 p-0.5 text-xs font-semibold">
          {(['kg', 'lineas'] as Metric[]).map(m => <button key={m} type="button" aria-pressed={metric === m} onClick={() => setMetric(m)}
            className={`min-h-9 rounded-md px-3 ${metric === m ? 'bg-[#002855] text-white' : 'text-slate-600'}`}>{m === 'kg' ? 'Peso (kg)' : 'Líneas'}</button>)}
        </div>
        <p className="max-w-lg text-xs text-slate-500">MRO, herramientas y mantenimiento casi no traen peso: para verlos use «Líneas».</p>
      </PeriodBar>
      {q.loading ? <LoadingBlock label="Calculando el flujo…" /> : q.error ? <ErrorBlock message={q.error} onRetry={q.reload} /> : d && sk && <>
        <ChartCard title="Mapa del flujo" subtitle={`${fmtDate(d.desde)} – ${fmtDate(d.hasta)} · ingresos → bodegas → salidas${sk.omitted ? ` · ${sk.omitted} traspaso(s) de retorno no dibujados` : ''}`}>
          {sk.links.length ? <ResponsiveContainer width="100%" height={Math.max(420, sk.nodes.length * 26)}>
            <Sankey data={sk} nodePadding={18} nodeWidth={10} margin={{ left: 8, right: 170, top: 8, bottom: 8 }} link={{ stroke: '#94a3b8', strokeOpacity: 0.35 }}
              node={<SankeyNode />}>
              <Tooltip formatter={v => (metric === 'kg' ? fmtPeso(Number(v)) : `${fmtN(Number(v))} líneas`)} />
            </Sankey>
          </ResponsiveContainer> : <p className="text-sm text-slate-400">Sin movimientos con {metric === 'kg' ? 'peso' : 'líneas'} en el período.</p>}
        </ChartCard>
        <ChartCard title="Traspasos entre bodegas" info="Días en origen: cuánto estuvo en la bodega de origen lo que se traspasó (FIFO). Reasignadas: líneas en que el lote cambió (stock asignado a un contrato).">
          <Table empty={!d.traspasos.length} head={<tr><th className={th}>Origen</th><th className={th}>Destino</th><th className={`${th} text-right`}>Documentos</th><th className={`${th} text-right`}>Líneas</th><th className={`${th} text-right`}>Peso</th><th className={`${th} text-right`}>Reasignadas</th><th className={th}>Días en origen</th></tr>}>
            {d.traspasos.map(t => <tr key={`${t.origen}>${t.destino}`} className="hover:bg-slate-50">
              <td className={td}>{t.origen}</td><td className={td}>{t.destino}</td><td className={tdNum}>{fmtN(t.docs)}</td><td className={tdNum}>{fmtN(t.lineas)}</td>
              <td className={tdNum}>{fmtPeso(t.kg)}</td><td className={tdNum}>{t.reasignadas ? <span className="font-semibold text-violet-700">{fmtN(t.reasignadas)}</span> : '0'}</td>
              <td className={td}><DiasPill dias={t.dias_en_origen} /></td>
            </tr>)}
          </Table>
        </ChartCard>
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard title="Ingresos por origen">
            <Table head={<tr><th className={th}>Clase</th><th className={`${th} text-right`}>Líneas</th><th className={`${th} text-right`}>Peso</th></tr>}>
              {clases(d.ingresos).map(([c, v]) => <tr key={c}><td className={td}>{CLASE_LABEL[c] ?? c}</td><td className={tdNum}>{fmtN(v.lineas)}</td><td className={tdNum}>{fmtPeso(v.kg)}</td></tr>)}
            </Table>
          </ChartCard>
          <ChartCard title="Salidas por destino">
            <Table head={<tr><th className={th}>Clase</th><th className={`${th} text-right`}>Líneas</th><th className={`${th} text-right`}>Peso</th></tr>}>
              {clases(d.salidas).map(([c, v]) => <tr key={c}><td className={td}>{CLASE_LABEL[c] ?? c}</td><td className={tdNum}>{fmtN(v.lineas)}</td><td className={tdNum}>{fmtPeso(v.kg)}</td></tr>)}
            </Table>
          </ChartCard>
        </div>
        <ChartCard title="Reasignaciones de lote" subtitle="Stock de una bodega que pasa a otra con el lote de un contrato (las 300 más recientes)">
          <Table empty={!d.reasignaciones.length} head={<tr><th className={th}>Fecha</th><th className={th}>Documento</th><th className={th}>Origen → destino</th><th className={th}>Producto</th><th className={th}>Lote origen</th><th className={th}>Lote destino</th><th className={`${th} text-right`}>Cantidad</th></tr>}>
            {d.reasignaciones.map((r, i) => <tr key={i}><td className={td}>{fmtDate(r.fecha)}</td><td className={td}>{r.numero}</td><td className={td}>{r.origen} → {r.destino}</td>
              <td className={td}><ProductoCell producto={r.producto} glosa={r.glosa} /></td><td className={td}>{r.lote_origen ?? 'Sin lote'}</td><td className={`${td} font-semibold`}>{r.lote_destino ?? 'Sin lote'}</td><td className={tdNum}>{fmtQty(r.qty)}</td></tr>)}
          </Table>
        </ChartCard>
      </>}
    </div>
  )
}
