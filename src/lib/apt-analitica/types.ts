// Analítica logística APT y Distribución: tipos compartidos por la importación, el motor de cálculo y las pantallas.
// Reglas en docs/apt-analitica.md. Los identificadores se guardan como texto tal como vienen (sin quitar ceros,
// puntos, guiones ni sufijos) y los datos ausentes quedan en null: nunca se convierten en cero.

export type Side = 'E' | 'S'
export type RowStatus = 'ACEPTADO' | 'RECHAZADO' | 'REVISION' | 'DESCARTADO'
export type SourceType = 'ENTRADAS' | 'SALIDAS' | 'MOVIMIENTOS' | 'SALDO_INICIAL' | 'COMPROMISOS' | 'RECEPCIONES'
export type Area = 'APT' | 'APT_LB' | 'DIST'
export type DocClass = 'PRODUCCION' | 'COMPRA' | 'TRASPASO' | 'DESPACHO_VENTA' | 'CONSUMO' | 'SERVICIO_TERCERO' | 'PRESTAMO'
  | 'DEVOLUCION' | 'AJUSTE' | 'ANULACION' | 'SIN_CLASIFICAR'
export type SameDayOrder = 'ENTRADAS_PRIMERO' | 'SALIDAS_PRIMERO'

export const AREA_LABEL: Record<Area, string> = { APT: 'APT principal', APT_LB: 'APT LB', DIST: 'Distribución' }
export const CLASS_LABEL: Record<DocClass, string> = {
  PRODUCCION: 'Producción', COMPRA: 'Compra / ingreso', TRASPASO: 'Traspaso entre almacenes', DESPACHO_VENTA: 'Despacho de ventas',
  CONSUMO: 'Consumo', SERVICIO_TERCERO: 'Servicio de terceros', PRESTAMO: 'Préstamo', DEVOLUCION: 'Devolución', AJUSTE: 'Ajuste',
  ANULACION: 'Anulación', SIN_CLASIFICAR: 'Sin clasificar',
}

/** Movimiento normalizado (una línea del archivo original). `qty` es siempre positiva; `cantidad` conserva el signo. */
export interface Movement {
  id: number
  importId: string
  sheet: string
  row: number
  status: RowStatus
  reasons: string[]
  /** 1 = primera aparición de la línea en su archivo; 2, 3… = líneas idénticas dentro del mismo archivo (se conservan) */
  dup: number
  side: Side
  tipo: string
  clase: DocClass
  bodegaRaw: string
  bodega: string
  area: Area | null
  numero: string | null
  fecha: string
  codLegal: string | null
  razonSocial: string | null
  producto: string
  glosa: string | null
  cantidad: number
  qty: number
  unidad: string
  docRel: string | null
  numRel: string | null
  fechaEntrega: string | null
  contrato: string | null
  refTipo: string | null
  refCorrelativo: string | null
  refNumero: string | null
  refFecha: string | null
  lote: string | null
  color: string | null
  comentario: string | null
  pesoUnitario: number | null
  pesoXProducir: number | null
  pesoProducido: number | null
  ccosto: string | null
}

export interface OpeningBalance { bodega: string; producto: string; lote: string | null; unidad: string; cantidad: number; cutoff: string }

export interface UnitConversion { producto: string | null; fromUnit: string; toUnit: string; factor: number; verified: boolean }

export type LinkOrigin = 'SISTEMA' | 'REGLA' | 'MANUAL'
export type LinkKind = 'LOTE' | 'TRASPASO' | 'OT' | 'OP' | 'PEDIDO' | 'CONTRATO' | 'DESPACHO' | 'RECEPCION'
export interface Link {
  id: string
  fromKind: LinkKind; fromRef: string
  toKind: LinkKind; toRef: string
  qty: number | null; unidad: string | null
  origin: LinkOrigin
  note: string | null
  status: 'VIGENTE' | 'ANULADO'
}

export interface Commitment {
  pedido: string; linea: string; producto: string; unidad: string; cantidad: number
  fechaCompromiso: string | null; version: number; estado: 'VIGENTE' | 'CANCELADO'
}
export interface Receipt {
  despacho: string; producto: string; unidad: string; aceptada: number; rechazada: number | null
  fecha: string; motivo: string | null; pedido: string | null; linea: string | null
}

export interface Settings {
  sameDayOrder: SameDayOrder
  /** Límites inferiores de los rangos de antigüedad en días (p. ej. [0, 1, 3, 7, 15, 30]) */
  ageBuckets: number[]
  /** Fecha que el ERP usa como valor predeterminado (no se usa para permanencia) */
  defaultRefDate: string
}
export const DEFAULT_SETTINGS: Settings = { sameDayOrder: 'ENTRADAS_PRIMERO', ageBuckets: [0, 1, 3, 7, 15, 30], defaultRefDate: '2020-03-22' }

export interface Filters {
  from: string | null
  to: string | null
  areas: Area[]
  bodegas: string[]
  clientes: string[]
  productos: string[]
  unidad: string | null
  lotes: string[]
  otop: string[]
  contratos: string[]
  documentos: string[]
  text: string
}
export const EMPTY_FILTERS: Filters = { from: null, to: null, areas: [], bodegas: [], clientes: [], productos: [], unidad: null, lotes: [],
  otop: [], contratos: [], documentos: [], text: '' }

/** Estado de un indicador: calculado con datos completos, estimado (FIFO u otra hipótesis) o no disponible */
export type KpiStatus = 'CALCULADO' | 'ESTIMADO' | 'NO_DISPONIBLE'
export interface Kpi {
  code: string
  label: string
  status: KpiStatus
  value: number | null
  unit: string | null
  /** Texto corto bajo el valor (período, cobertura) */
  hint?: string
  definition: string
  formula: string
  numerator?: { label: string; value: number | null }
  denominator?: { label: string; value: number | null }
  exclusions: string[]
  coverage?: number | null
  missing?: string
  /** Movimientos que sustentan el valor */
  recordIds: number[]
  /** Códigos de incidencias de calidad que afectan el resultado */
  issues: string[]
}
