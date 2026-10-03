'use client'

import { useMemo, useRef, useState, type MouseEvent } from 'react'
import { ResponsiveContainer, Sankey } from 'recharts'
import { fmtPct, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, FLOW_COLOR, isAlmacen } from '@/lib/apt/flowColors'
import type { FlowAlmacen, FlowLink } from '@/lib/apt/flowTypes'
import { FlowTip } from './ResumenShared'

// Sankey del flujo de material. Los flujos reales tienen ciclos (647→ST→647, 647↔540, 540→540), y un Sankey debe ser
// acíclico: se arma por capas (fuentes → 647/540 → ST VENTAS → destinos) y los retornos se dibujan como destinos propios.

export type SankeyKey =
  | 'SRC_PRODUCCION' | 'SRC_INICIAL' | 'SRC_DEVOLUCION' | 'SRC_OTRO'
  | '647' | '540' | 'ST'
  | 'CLIENTE' | 'CONSUMO' | 'OUT_OTRO' | 'SALDO' | 'RETORNO' | 'TRASPASO'

const NODE_META: Record<SankeyKey, { label: string; color: string; hint: string }> = {
  SRC_PRODUCCION: { label: 'Producción', color: FLOW_COLOR.PRODUCCION, hint: 'Ingreso de producción del periodo (P/E a 647)' },
  SRC_INICIAL: { label: 'Stock previo', color: FLOW_COLOR.INICIAL, hint: 'Existía antes del primer día cargado; antigüedad real desconocida' },
  SRC_DEVOLUCION: { label: 'Devoluciones', color: FLOW_COLOR.DEVOLUCION, hint: 'Material devuelto por clientes' },
  SRC_OTRO: { label: 'Otros almacenes', color: FLOW_COLOR.OTRO_ALMACEN, hint: 'Ingresos desde almacenes fuera de 647/540/ST' },
  '647': { label: '647 · ALM PT', color: ALMACEN_COLOR['647'], hint: 'Recibe toda la producción' },
  '540': { label: '540 · APT LB', color: ALMACEN_COLOR['540'], hint: 'Stock antiguo y adelantos IPT' },
  ST: { label: 'ST VENTAS', color: ALMACEN_COLOR.ST, hint: 'Solo lo que se guía; ideal: saldo 0' },
  CLIENTE: { label: 'Cliente (guías)', color: FLOW_COLOR.CLIENTE, hint: 'Despachado al cliente con guía' },
  CONSUMO: { label: 'Consumo interno', color: FLOW_COLOR.CONSUMO, hint: 'Vales de consumo (V/C)' },
  OUT_OTRO: { label: 'Otros almacenes', color: FLOW_COLOR.OTRO_ALMACEN, hint: 'Salidas hacia almacenes fuera del flujo' },
  SALDO: { label: 'Saldo al corte', color: FLOW_COLOR.SALDO, hint: 'Sigue en algún almacén a la fecha de corte' },
  RETORNO: { label: 'Retorno a 647/540', color: FLOW_COLOR.RETORNO, hint: 'Sobrante de ST VENTAS devuelto a 647/540 (no se guió)' },
  TRASPASO: { label: 'Traspaso 647↔540', color: FLOW_COLOR.TRASPASO, hint: 'Movimientos entre 647 y 540' },
}

const SOURCE_KEY: Record<string, SankeyKey> = {
  PRODUCCION: 'SRC_PRODUCCION', INICIAL: 'SRC_INICIAL', DEVOLUCION: 'SRC_DEVOLUCION', OTRO_ALMACEN: 'SRC_OTRO',
}
const SINK_KEY: Record<string, SankeyKey> = { CLIENTE: 'CLIENTE', CONSUMO: 'CONSUMO', OTRO_ALMACEN: 'OUT_OTRO', SALDO: 'SALDO' }
const ORDER: SankeyKey[] = ['SRC_PRODUCCION', 'SRC_INICIAL', 'SRC_DEVOLUCION', 'SRC_OTRO', '647', '540', 'ST',
  'CLIENTE', 'SALDO', 'RETORNO', 'TRASPASO', 'CONSUMO', 'OUT_OTRO']

// Convierte un enlace real en uno del grafo acíclico (o null si se descarta)
function mapLink(l: FlowLink): [SankeyKey, SankeyKey] | null {
  const a = l.desde, b = l.hacia
  if (!isAlmacen(a)) {
    const s = SOURCE_KEY[a]
    if (!s) return null
    if (isAlmacen(b)) return [s, b]
    const t = SINK_KEY[b]
    return t ? [s, t] : null
  }
  if (isAlmacen(b)) {
    if (a === b) return null                                // movimientos internos (540→540)
    if (b === 'ST') return [a, 'ST']                        // 647/540 → ST
    if (a === 'ST') return ['ST', 'RETORNO']                // ST → 647/540
    return [a, 'TRASPASO']                                  // 647 ↔ 540
  }
  const t = SINK_KEY[b]
  return t ? [a, t] : null
}

export interface SankeyGraph {
  keys: SankeyKey[]
  data: { nodes: Array<{ name: string; key: SankeyKey }>; links: Array<{ source: number; target: number; value: number }> }
  totalIn: number
}

export function buildSankey(flujos: FlowLink[]): SankeyGraph {
  const agg = new Map<string, number>()
  flujos.forEach(l => {
    const m = mapLink(l)
    if (!m || !(l.tn > 0)) return
    const k = `${m[0]}|${m[1]}`
    agg.set(k, (agg.get(k) ?? 0) + Number(l.tn))
  })
  const used = new Set<SankeyKey>()
  agg.forEach((v, k) => { if (v > 0.0005) k.split('|').forEach(x => used.add(x as SankeyKey)) })
  const keys = ORDER.filter(k => used.has(k))
  const idx = new Map(keys.map((k, i) => [k, i]))
  const links: SankeyGraph['data']['links'] = []
  agg.forEach((v, k) => {
    if (v <= 0.0005) return
    const [s, t] = k.split('|') as [SankeyKey, SankeyKey]
    links.push({ source: idx.get(s)!, target: idx.get(t)!, value: Math.round(v * 1000) / 1000 })
  })
  links.sort((x, y) => x.source - y.source || x.target - y.target)
  const totalIn = links.filter(l => keys[l.source].startsWith('SRC_')).reduce((s, l) => s + l.value, 0)
  return { keys, data: { nodes: keys.map(k => ({ name: NODE_META[k].label, key: k })), links }, totalIn }
}

type Hover =
  | { kind: 'node'; key: SankeyKey; value: number; x: number; y: number; w: number }
  | { kind: 'link'; from: SankeyKey; to: SankeyKey; value: number; fromValue: number; toValue: number; x: number; y: number; w: number }

interface NodeArgs { x: number; y: number; width: number; height: number; index: number; payload: { value: number; depth: number; name: string; key: SankeyKey } }
interface LinkArgs {
  payload: { source: { key: SankeyKey }; target: { key: SankeyKey }; value: number }
  sourceX: number; targetX: number; sourceY: number; targetY: number; sourceControlX: number; targetControlX: number
  linkWidth: number; index: number
}

export function ResumenSankey({ flujos, onNode }: { flujos: FlowLink[]; onNode?: (key: SankeyKey) => void }) {
  const graph = useMemo(() => buildSankey(flujos), [flujos])
  const box = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Hover | null>(null)
  const { keys, data, totalIn } = graph

  if (!data.links.length) return <p className="py-16 text-center text-sm text-slate-400">Sin movimientos para dibujar el flujo.</p>

  const pos = (e: MouseEvent<SVGGraphicsElement>) => {
    const r = box.current?.getBoundingClientRect()
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width } : { x: 0, y: 0, w: 600 }
  }
  const hoverNode = hover?.kind === 'node' ? hover.key : null

  const renderNode = (p: NodeArgs) => {
    const key = p.payload.key
    const meta = NODE_META[key]
    const pct = totalIn > 0 && !key.startsWith('SRC_') ? (p.payload.value / totalIn) * 100 : null
    const tall = p.height >= 22
    const lx = p.x + p.width + 6
    const clickable = !!onNode && (isAlmacen(key) || key === 'CLIENTE' || key === 'RETORNO' || key === 'SALDO')
    return (
      <g key={`n-${key}`} style={{ cursor: clickable ? 'pointer' : 'default' }}>
        <rect x={p.x} y={p.y} width={p.width} height={Math.max(p.height, 1.5)} rx={2} fill={meta.color}
          fillOpacity={hoverNode && hoverNode !== key ? 0.45 : 1} />
        <text x={lx} y={p.y + p.height / 2 + (tall ? -2 : 4)} fontSize={11} fontWeight={700} fill="#0f172a"
          stroke="#fff" strokeWidth={3} paintOrder="stroke" style={{ pointerEvents: 'none' }}>
          {meta.label}
          {!tall && <tspan fontWeight={500} fill="#64748b"> · {fmtTn(p.payload.value)} TN</tspan>}
        </text>
        {tall && (
          <text x={lx} y={p.y + p.height / 2 + 11} fontSize={10.5} fill="#475569" stroke="#fff" strokeWidth={3} paintOrder="stroke"
            style={{ pointerEvents: 'none' }} className="tabular-nums">
            {fmtTn(p.payload.value)} TN{pct !== null ? ` · ${fmtPct(pct)}` : ''}
          </text>
        )}
      </g>
    )
  }

  const renderLink = (p: LinkArgs) => {
    const from = p.payload.source.key, to = p.payload.target.key
    const color = isAlmacen(from) ? ALMACEN_COLOR[from as FlowAlmacen] : NODE_META[from].color
    const isHoverLink = hover?.kind === 'link' && hover.from === from && hover.to === to
    const dim = hover?.kind === 'link' ? !isHoverLink : hoverNode ? hoverNode !== from && hoverNode !== to : false
    const active = isHoverLink || (!!hoverNode && !dim)
    const d = `M${p.sourceX},${p.sourceY} C${p.sourceControlX},${p.sourceY} ${p.targetControlX},${p.targetY} ${p.targetX},${p.targetY}`
    return (
      <path key={`l-${p.index}`} d={d} fill="none" stroke={from === 'SRC_INICIAL' ? '#94a3b8' : color}
        strokeWidth={Math.max(p.linkWidth, 1)} strokeOpacity={active ? 0.6 : dim ? 0.1 : 0.3}
        strokeDasharray={from === 'SRC_INICIAL' ? '6 3' : undefined} style={{ transition: 'stroke-opacity .15s' }} />
    )
  }

  const nodeValue = (k: SankeyKey, side: 'out' | 'in') =>
    data.links.filter(l => keys[side === 'out' ? l.source : l.target] === k).reduce((s, l) => s + l.value, 0)

  return (
    <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
      <ResponsiveContainer width="100%" height={430}>
        <Sankey data={data} nodeWidth={14} nodePadding={26} linkCurvature={0.5} iterations={64} sort={false}
          margin={{ top: 12, right: 150, bottom: 12, left: 8 }}
          node={renderNode as never} link={renderLink as never}
          onMouseEnter={(item, type, e) => {
            const xy = pos(e)
            if (type === 'node') {
              const it = item as unknown as NodeArgs
              setHover({ kind: 'node', key: it.payload.key, value: it.payload.value, ...xy })
            } else {
              const it = item as unknown as LinkArgs
              const from = it.payload.source.key, to = it.payload.target.key
              setHover({ kind: 'link', from, to, value: it.payload.value, fromValue: Math.max(nodeValue(from, 'out'), nodeValue(from, 'in')),
                toValue: Math.max(nodeValue(to, 'in'), nodeValue(to, 'out')), ...xy })
            }
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(item, type) => {
            if (type !== 'node' || !onNode) return
            onNode((item as unknown as NodeArgs).payload.key)
          }}
        />
      </ResponsiveContainer>
      {hover && (
        <div className="pointer-events-none absolute z-20" style={{
          left: Math.min(hover.x + 14, hover.w - 260), top: Math.max(hover.y - 10, 0),
        }}>
          {hover.kind === 'node' ? (
            <FlowTip title={NODE_META[hover.key].label} subtitle={NODE_META[hover.key].hint} rows={[
              ['TN', fmtTn(hover.value), NODE_META[hover.key].color],
              ...(totalIn > 0 ? [['% del ingreso total', fmtPct((hover.value / totalIn) * 100)] as [string, string]] : []),
            ]} />
          ) : (
            <FlowTip title={`${NODE_META[hover.from].label} → ${NODE_META[hover.to].label}`} subtitle={NODE_META[hover.to].hint} rows={[
              ['TN', fmtTn(hover.value), isAlmacen(hover.from) ? ALMACEN_COLOR[hover.from as FlowAlmacen] : NODE_META[hover.from].color],
              [`% de lo que sale de ${NODE_META[hover.from].label}`, hover.fromValue > 0 ? fmtPct((hover.value / hover.fromValue) * 100) : '—'],
              [`% de lo que llega a ${NODE_META[hover.to].label}`, hover.toValue > 0 ? fmtPct((hover.value / hover.toValue) * 100) : '—'],
            ]} />
          )}
        </div>
      )}
    </div>
  )
}
