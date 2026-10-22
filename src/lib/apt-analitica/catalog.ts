import type { Area, DocClass, Movement } from './types'

// Clasificación de TipoDocto y mapeo de bodegas a áreas. Lo guardado por un administrador (tablas apa_doc_classes y
// apa_areas) tiene prioridad; esto es solo el punto de partida y queda marcado como sugerido.

const EXACT: Record<string, DocClass> = {
  'P/E PRODUCCION ACT.': 'PRODUCCION', 'P/E RETACERIA': 'PRODUCCION',
  'N/INGRESO ALMACEN': 'COMPRA', 'N/INGRESO ACTIVO': 'COMPRA', 'RECEPCION IMPORTACION': 'COMPRA',
  'TRASPASO DE ALMACEN': 'TRASPASO', 'TRASPASO DE ALMACEN APT': 'TRASPASO',
  'DESPACHO VENTAS': 'DESPACHO_VENTA',
  'VALE DE CONSUMO': 'CONSUMO', 'V/C ACTIVOS': 'CONSUMO', 'V/C MANTENIMIENTOS': 'CONSUMO', 'V/C PRODUCCION ACT.': 'CONSUMO',
  'GS SERV TERCEROS': 'SERVICIO_TERCERO', 'PE SERV TERCEROS': 'SERVICIO_TERCERO',
  'SALIDA HERRAMIENTAS': 'PRESTAMO', 'DEV. HERRAMIENTAS': 'DEVOLUCION', 'G/DEV INDIRECTO': 'DEVOLUCION', 'GUIA DE RECOJO': 'DEVOLUCION',
}

export function suggestClass(tipo: string): DocClass {
  const t = tipo.replace(/\s+/g, ' ').trim().toUpperCase()
  if (EXACT[t]) return EXACT[t]
  if (/TRASPASO|TRANSFERENCIA/.test(t)) return 'TRASPASO'
  if (/ANULA/.test(t)) return 'ANULACION'
  if (/AJUSTE|INVENTARIO FISICO|REGULARIZA/.test(t)) return 'AJUSTE'
  if (/DESPACHO VENTA|GUIA DE VENTA|FACTURA/.test(t)) return 'DESPACHO_VENTA'
  if (/^V\/C|VALE DE CONSUMO|CONSUMO/.test(t)) return 'CONSUMO'
  if (/SERV TERCEROS|SERVICIO DE TERCEROS/.test(t)) return 'SERVICIO_TERCERO'
  if (/^DEV|DEVOLUCION|RECOJO/.test(t)) return 'DEVOLUCION'
  if (/^P\/E|PARTE DE ENTRADA|PRODUCCION/.test(t)) return 'PRODUCCION'
  if (/INGRESO|IMPORTACION|COMPRA/.test(t)) return 'COMPRA'
  if (/PRESTAMO|SALIDA HERRAMIENTAS/.test(t)) return 'PRESTAMO'
  return 'SIN_CLASIFICAR'
}

export interface AreaRule { bodega: string; area: Area | null; confirmed: boolean; note?: string | null }

/** Mapeo inicial (editable): las dos primeras confirmadas; Distribución queda pendiente de confirmación del negocio */
export const DEFAULT_AREAS: AreaRule[] = [
  { bodega: '647-04 ALM PT', area: 'APT', confirmed: true, note: 'APT principal' },
  { bodega: '540-04 APT LB', area: 'APT_LB', confirmed: true, note: 'APT LB' },
  { bodega: 'ST-VENTAS-IMD', area: 'DIST', confirmed: false, note: 'Asociación pendiente de confirmación del negocio' },
]

/** Referencia de orden de producción (OT/OP): NumRel cuando DocRel es una orden de producción. No se equipara con el lote. */
export function ordenRef(m: Pick<Movement, 'docRel' | 'numRel'>): string | null {
  if (!m.numRel || !m.docRel) return null
  return /ORDEN DE PRODUCCION|OP INTERNA|^O\.?P\.?$/i.test(m.docRel) ? m.numRel : null
}

/** Referencia comercial: NumRel cuando DocRel es un contrato, subcontrato o pedido de ventas */
export function comercialRef(m: Pick<Movement, 'docRel' | 'numRel'>): string | null {
  if (!m.numRel || !m.docRel) return null
  if (/ERROR DE CONTRATO/i.test(m.docRel)) return null
  return /CONTRATO|PEDIDO/i.test(m.docRel) ? m.numRel : null
}

export const hasErrorContrato = (m: Pick<Movement, 'docRel' | 'numRel' | 'contrato' | 'comentario'>) =>
  [m.docRel, m.numRel, m.contrato, m.comentario].some(v => v && /ERROR DE CONTRATO/i.test(v))
