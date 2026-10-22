// Colores y etiquetas compartidas del flujo multi-almacén (647 · 540 · ST VENTAS).
// Mantener un color fijo por almacén y por origen/destino en todas las pantallas del flujo.
import type { FlowAlmacen, FlowOrigen } from './flowTypes'

export const ALMACEN_COLOR: Record<FlowAlmacen, string> = {
  '647': '#002855', // navy
  '540': '#f59e0b', // ámbar
  ST: '#0d9488',    // teal
}

// Tonos claros (fondos de tarjetas / chips)
export const ALMACEN_BG: Record<FlowAlmacen, string> = {
  '647': '#e6edf5',
  '540': '#fef3c7',
  ST: '#ccfbf1',
}

// Destinos y fuentes que no son almacenes
export const FLOW_COLOR = {
  PRODUCCION: '#16a34a',
  DEVOLUCION: '#ea580c',
  INICIAL: '#94a3b8',
  CLIENTE: '#2563eb',
  CONSUMO: '#a855f7',
  OTRO_ALMACEN: '#94a3b8',
  SALDO: '#64748b',
  RETORNO: '#cf152d',
  TRASPASO: '#b45309',
} as const

// Stock previo (sin fecha): grises/slate; se recomienda aplicarlos con el patrón rayado INICIAL_PATTERN
export const ORIGEN_COLOR: Record<FlowOrigen, string> = {
  PRODUCCION: FLOW_COLOR.PRODUCCION,
  INICIAL_647: '#475569',
  INICIAL_540: '#94a3b8',
  INICIAL_ST: '#cbd5e1',
  DEVOLUCION: FLOW_COLOR.DEVOLUCION,
  OTRO_ALMACEN: FLOW_COLOR.OTRO_ALMACEN,
}

export const STOCK_INICIAL_COLOR = '#cbd5e1'
export const INICIAL_RANGO = 'Stock inicial (sin fecha)'

export const FLOW_ORIGENES: FlowOrigen[] = ['PRODUCCION', 'INICIAL_647', 'INICIAL_540', 'INICIAL_ST', 'DEVOLUCION', 'OTRO_ALMACEN']
export const FLOW_ALMACENES: FlowAlmacen[] = ['647', '540', 'ST']

export const isAlmacen = (v: string): v is FlowAlmacen => v === '647' || v === '540' || v === 'ST'

// Id de un patrón SVG rayado para el stock previo. Definir el <pattern> localmente dentro del <svg> del gráfico.
export const hatchId = (color: string) => `flow-hatch-${color.replace('#', '')}`

// Etiqueta corta de un nodo del flujo (FlowLink.desde / FlowLink.hacia)
const NODE_LABEL: Record<string, string> = {
  PRODUCCION: 'Producción',
  DEVOLUCION: 'Devoluciones',
  OTRO_ALMACEN: 'Otros almacenes',
  INICIAL: 'Stock previo',
  '647': '647 · ALM PT',
  '540': '540 · APT LB',
  ST: 'ST VENTAS',
  CLIENTE: 'Cliente (guías)',
  CONSUMO: 'Consumo interno',
  SALDO: 'Saldo al corte',
  INICIAL_647: 'Stock previo 647',
  INICIAL_540: 'Stock previo 540',
  INICIAL_ST: 'Stock previo ST',
}
export const flowNodeLabel = (key: string) => NODE_LABEL[key] ?? key

export function flowNodeColor(key: string): string {
  if (isAlmacen(key)) return ALMACEN_COLOR[key]
  if (key in ORIGEN_COLOR) return ORIGEN_COLOR[key as FlowOrigen]
  const k = key as keyof typeof FLOW_COLOR
  return FLOW_COLOR[k] ?? '#94a3b8'
}

// Tipos de movimiento de apt_flow_stock.movimientos
const MOV_LABEL: Record<string, string> = {
  PRODUCCION: 'Producción',
  DEVOLUCION: 'Devolución',
  OTRO_ALMACEN: 'Otros almacenes',
  DESDE_647: 'Desde 647',
  DESDE_540: 'Desde 540',
  DESDE_ST: 'Desde ST',
  DESPACHO: 'Despacho (guía)',
  CONSUMO: 'Consumo interno',
  HACIA_647: 'Hacia 647',
  HACIA_540: 'Hacia 540',
  HACIA_ST: 'Hacia ST',
}
export const movTipoLabel = (t: string) => MOV_LABEL[t] ?? t
export function movTipoColor(t: string): string {
  if (t.startsWith('DESDE_') || t.startsWith('HACIA_')) {
    const a = t.slice(t.indexOf('_') + 1)
    if (isAlmacen(a)) return ALMACEN_COLOR[a]
  }
  if (t === 'DESPACHO') return FLOW_COLOR.CLIENTE
  return flowNodeColor(t)
}

// Traspaso "647→ST" → "647 → ST VENTAS"
export function traspasoLabel(k: string): string {
  const [a, b] = k.split('→')
  if (!b) return k
  const s = (x: string) => (x === 'ST' ? 'ST' : x)
  return `${s(a)} → ${s(b)}`
}
