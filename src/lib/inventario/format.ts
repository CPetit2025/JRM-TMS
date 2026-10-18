import type { InvClase, InvKind } from './types'

// Etiquetas y colores del inventario multi-almacén
export const KIND_LABEL: Record<InvKind, string> = {
  MATERIA_PRIMA: 'Materia prima', PRODUCCION: 'Producción', PRODUCTO_TERMINADO: 'Producto terminado', DESPACHO: 'Despacho (ST)',
  PERNERIA: 'Pernería', MRO: 'MRO', MANTENIMIENTO: 'Mantenimiento', HERRAMIENTAS: 'Herramientas', ACTIVOS: 'Activos',
  TERCERO: 'Tercero / servicio', OBRA: 'Obra / cliente', OTRO: 'Otro',
}
export const KIND_COLOR: Record<InvKind, string> = {
  MATERIA_PRIMA: '#7c3aed', PRODUCCION: '#ea580c', PRODUCTO_TERMINADO: '#002855', DESPACHO: '#0d9488', PERNERIA: '#2563eb',
  MRO: '#0891b2', MANTENIMIENTO: '#64748b', HERRAMIENTAS: '#a16207', ACTIVOS: '#475569', TERCERO: '#db2777', OBRA: '#16a34a', OTRO: '#94a3b8',
}
export const KINDS = Object.keys(KIND_LABEL) as InvKind[]

export const CLASE_LABEL: Record<InvClase, string> = {
  PRODUCCION: 'Producción', COMPRA: 'Compra / ingreso', TRASPASO: 'Traspaso', DESPACHO: 'Despacho a cliente', CONSUMO: 'Consumo interno',
  SERVICIO_TERCERO: 'Servicio de terceros', PRESTAMO: 'Préstamo', DEVOLUCION: 'Devolución', AJUSTE: 'Ajuste', OTRO: 'Otro',
}
export const CLASE_COLOR: Record<InvClase, string> = {
  PRODUCCION: '#ea580c', COMPRA: '#7c3aed', TRASPASO: '#2563eb', DESPACHO: '#0d9488', CONSUMO: '#64748b', SERVICIO_TERCERO: '#db2777',
  PRESTAMO: '#a16207', DEVOLUCION: '#16a34a', AJUSTE: '#94a3b8', OTRO: '#cbd5e1',
}
export const CLASES = Object.keys(CLASE_LABEL) as InvClase[]

const nf = (d: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: 0, maximumFractionDigits: d })
const n0 = nf(0), n1 = nf(1), n3 = nf(3)
export const fmtN = (v: number | null | undefined) => (v === null || v === undefined ? '—' : n0.format(Number(v)))
export const fmtN1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : n1.format(Number(v)))
export const fmtQty = (v: number | null | undefined) => (v === null || v === undefined ? '—' : n3.format(Number(v)))
// kg con cambio a TN desde 10 000 kg
export function fmtPeso(kg: number | null | undefined) {
  if (kg === null || kg === undefined) return '—'
  return Math.abs(kg) >= 10000 ? `${n1.format(kg / 1000)} TN` : `${n0.format(kg)} kg`
}
export function fmtDias(d: number | null | undefined) {
  if (d === null || d === undefined) return '—'
  return `${n1.format(Number(d))} d`
}
export function diasClass(d: number | null | undefined) {
  if (d === null || d === undefined) return 'bg-slate-50 text-slate-500 border-slate-200'
  if (d > 30) return 'bg-red-50 text-red-700 border-red-200'
  if (d > 7) return 'bg-amber-50 text-amber-700 border-amber-200'
  return 'bg-emerald-50 text-emerald-700 border-emerald-200'
}
