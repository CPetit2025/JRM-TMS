// Tipos del flujo multi-almacén (647 · 540 · ST VENTAS). Reflejan lo que devuelven las funciones public.apt_flow_*
// de la migración 20261003100000_apt_flujo_multialmacen.sql. Los pesos vienen en TN (3 decimales) y los días ponderados por kg.

export type FlowAlmacen = '647' | '540' | 'ST'
// Origen raíz de lo despachado o del saldo
export type FlowOrigen = 'PRODUCCION' | 'INICIAL_647' | 'INICIAL_540' | 'INICIAL_ST' | 'DEVOLUCION' | 'OTRO_ALMACEN'
export type FlowLayerTipo = 'PRODUCCION' | 'TRASPASO' | 'DEVOLUCION' | 'OTRO_ALMACEN' | 'INICIAL'
export type FlowExitTipo = 'TRASPASO' | 'DESPACHO' | 'CONSUMO' | 'OTRO_ALMACEN'
export type FlowLeadDim = 'cliente' | 'ot' | 'lote' | 'familia' | 'ruta'

// Filtros comunes del flujo (todas opcionales)
export interface FlowFilters {
  desde?: string        // yyyy-mm-dd, fecha del movimiento (por defecto, inicio de los datos)
  hasta?: string        // yyyy-mm-dd (por defecto, fecha de corte)
  clientes?: string[]   // cliente del lote (exacto; '(Sin cliente identificado)' para vacíos)
  lote?: string         // contiene
  ot?: string           // OT madre exacta (16339)
  almacen?: FlowAlmacen // solo apt_flow_stock (lista de lotes)
}

export interface FlowAlmacenCard {
  almacen: FlowAlmacen
  saldo_tn: number
  inicial_tn: number | null      // parte del saldo que viene del stock inicial (sin fecha)
  capas: number
  lotes: number
  edad_pond: number | null       // días desde la producción (ponderado)
  dias_almacen_pond: number | null // días desde que llegó a este almacén (ponderado)
}

export interface FlowLink { desde: string; hacia: string; tn: number }
// desde: PRODUCCION | DEVOLUCION | OTRO_ALMACEN | INICIAL | 647 | 540 | ST
// hacia: 647 | 540 | ST | CLIENTE | CONSUMO | OTRO_ALMACEN | SALDO
// Ojo: hay ciclos (647→ST y ST→647, 647↔540, 540→540); un Sankey necesita separar retornos en nodos propios.

export interface FlowSummary {
  vacio?: boolean
  cutoff: string; data_min: string; desde: string; hasta: string; rebuilt_at: string | null
  kpis: {
    produccion_tn: number; devolucion_tn: number; despacho_tn: number; guias: number; consumo_tn: number; otro_almacen_tn: number
    trazado_pct: number | null                 // % de lo despachado con origen en producción del periodo
    origen_despacho: Partial<Record<FlowOrigen, number>>
    dias_total: number | null; dias_previo: number | null; dias_final: number | null   // producción→guía, producción→llegada al último almacén, último almacén→guía
    st_mismo_dia_pct: number | null; st_detenido_tn: number; retorno_st_tn: number
    cambio_lote_tn: number; asignacion_tn: number
  }
  almacenes: FlowAlmacenCard[]
  flujos: FlowLink[]
  mensual: Array<{ mes: string; produccion_tn: number; despacho: Partial<Record<FlowOrigen, number>>; traspasos: Record<string, number>
    consumo_tn: number; dias_total: number | null }>   // traspasos: claves "647→ST", "540→ST", "ST→647"…
}

export interface FlowLoteSaldo {
  almacen: FlowAlmacen; lote: string; cliente: string | null; tn: number; productos: number; capas: number
  fecha_origen_min: string | null; fecha_llegada_min: string | null; edad_pond: number | null; dias_almacen_pond: number | null
  inicial_tn: number | null; tn_dias: number | null; alerta: boolean | null
}

export interface FlowStock {
  vacio?: boolean
  cutoff: string; desde: string; hasta: string; alert_days: number
  resumen: FlowAlmacenCard[]
  aging: Array<{ almacen: FlowAlmacen; rango: string; orden: number; tn: number }>   // orden -1 = 'Stock inicial (sin fecha)'
  serie: Array<{ fecha: string; '647': number; '540': number; ST: number }>          // saldo al cierre de cada semana
  movimientos: Array<{ mes: string; almacen: FlowAlmacen; sentido: 'INGRESO' | 'SALIDA'; tipo: string; tn: number }>
  // tipo INGRESO: PRODUCCION | DEVOLUCION | OTRO_ALMACEN | DESDE_647 | DESDE_540 | DESDE_ST
  // tipo SALIDA: DESPACHO | CONSUMO | OTRO_ALMACEN | HACIA_647 | HACIA_540 | HACIA_ST
  lotes: FlowLoteSaldo[]   // top 300 por TN×días
}

export interface FlowLeadtime {
  vacio?: boolean
  cutoff: string; desde: string; hasta: string; dim: FlowLeadDim
  kpis: { tn: number; guias: number; dias_total: number | null; dias_previo: number | null; dias_final: number | null
    p50: number | null; p90: number | null; mismo_dia_pct: number | null; sin_traza_tn: number }
  distribucion: { total: Array<{ rango: string; orden: number; tn: number }>; final: Array<{ rango: string; orden: number; tn: number }> }
  mensual: Array<{ mes: string; tn: number; dias_total: number | null; dias_previo: number | null; dias_final: number | null; mismo_dia_pct: number | null }>
  por_dim: Array<{ clave: string; tn: number; guias: number; dias_total: number | null; dias_previo: number | null; dias_final: number | null; max_total: number | null }>
}

export interface FlowSt {
  vacio?: boolean
  cutoff: string; desde: string; hasta: string
  kpis: { despacho_tn: number; mismo_dia_pct: number | null; d1_3_pct: number | null; mas3_pct: number | null; dias_pond: number | null
    saldo_tn: number; detenido_tn: number; detenido_lotes: number; retorno_tn: number; retorno_filas: number; retorno_dias_pond: number | null }
  mensual: Array<{ mes: string; d0: number; d1_3: number; d4_7: number; d8: number; mismo_dia_pct: number | null; retorno_tn: number }>
  detenido: Array<{ layer_id: number; lote: string; producto: string; glosa: string | null; cliente: string | null; desde: string | null
    tipo: FlowLayerTipo; fecha_llegada: string | null; dias: number | null; documento: string | null; tn: number }>
  retornos: Array<{ fecha: string; lote: string; lote_destino: string | null; producto: string; glosa: string | null; hacia: string
    documento: string | null; cliente: string | null; tn: number; dias_st: number | null }>
  retornos_lotes: Array<{ lote: string; cliente: string | null; veces: number; tn: number; dias_st: number | null }>
}

export interface FlowAdelantos {
  vacio?: boolean
  cutoff: string; desde: string; hasta: string
  kpis: { asignacion_tn: number; asignacion_filas: number; asignacion_lotes: number; asignacion_dias_pond: number | null
    asignacion_inicial_tn: number; reasignacion_tn: number; reasignacion_filas: number
    saldo_540_tn: number; inicial_540_tn: number; inicial_540_saldo_tn: number; ingresos_540_tn: number
    ultimo_ingreso_540: string | null; consumo_tn: number }
  mensual: Array<{ mes: string; asignacion_tn: number; reasignacion_tn: number; dias_espera: number | null }>
  cambios: Array<{ fecha: string; clase: 'ASIGNACION' | 'REASIGNACION'; desde: FlowAlmacen; hacia: FlowAlmacen; lote: string; lote_destino: string
    producto: string; glosa: string | null; documento: string | null; cliente: string | null; tn: number; dias_espera: number | null; inicial_tn: number }>
  contratos: Array<{ contrato: string; cliente: string | null; tn: number; lotes_origen: number; primera: string; ultima: string; clase: 'ASIGNACION' | 'REASIGNACION' }>
  mensual_540: Array<{ mes: string; ingresos: Record<string, number>; salidas: Record<string, number>; inicial_despachado_tn: number }>
  saldo_540_origen: Array<{ origen: FlowOrigen; tn: number; lotes: number }>
  consumos: Array<{ fecha: string; almacen: FlowAlmacen; lote: string; producto: string; glosa: string | null; numrel: string | null
    docrel: string | null; documento: string | null; cliente: string | null; tn: number }>
  consumos_resumen: Array<{ almacen: FlowAlmacen; docrel: string; tn: number; filas: number }>
}

export interface FlowTms {
  dispatch_id: string; numero: string | null; estado: string | null; programado: string | null
  salida: string | null; llegada: string | null; placa: string | null; conductor: string | null
}

export interface FlowTraceGuia {
  modo: 'guia'; cutoff: string
  guia: { documento: string; fecha: string; cliente: string | null; tn: number; filas: number; lotes: string[] }
  lineas: Array<{ lote: string; producto: string; glosa: string | null; origen: FlowOrigen; lote_origen: string; almacen_origen: FlowAlmacen
    fecha_origen: string | null; via: FlowAlmacen | null; almacen: FlowAlmacen; fecha_llegada: string | null; fecha_salida: string; tn: number
    dias_total: number | null; dias_previo: number | null; dias_final: number | null }>
  tms: FlowTms | null
}

export interface FlowTraceLote {
  modo: 'lote'; cutoff: string
  lote: { lote: string; cliente: string | null; produccion_tn: number; primera_produccion: string | null; primer_traspaso_st: string | null
    despacho_tn: number; ultima_guia: string | null; saldo_tn: number; dias_total: number | null }
  eventos: Array<{ fecha: string | null; evento: string; tipo: string; almacen: FlowAlmacen; desde?: string | null; hacia?: string | null
    lote_origen?: string | null; lote_destino?: string | null; documento: string | null; cliente?: string | null; tn: number; filas: number }>
  saldo: Array<{ almacen: FlowAlmacen; tn: number; dias: number | null }>
  guias: Array<{ documento: string; fecha: string; cliente: string | null; tn: number }>
  tms: Record<string, FlowTms>   // por número de guía en mayúsculas
}

export interface FlowTraceBuscar {
  modo: 'buscar'; cutoff: string
  guias: Array<{ documento: string; fecha: string; cliente: string | null; tn: number }>
  lotes: Array<{ lote: string; cliente: string | null; tn: number }>
}

export type FlowTrace = FlowTraceGuia | FlowTraceLote | FlowTraceBuscar

export interface FlowQuality {
  cutoff: string | null; data_min: string | null; rebuilt_at: string | null
  stats: { capas?: number; salidas?: number; piezas?: number; rondas?: number; traspasos_sal?: number; traspasos_ent?: number
    traspasos_emparejados?: number; saldo_tn?: Partial<Record<FlowAlmacen, number>> }
  hojas: Array<{ tipo: string; filas: number; validas: number; excluidas: number; tn: number; desde: string | null; hasta: string | null }>
  almacenes: Array<{ almacen: FlowAlmacen; inicial_tn: number; ingresos_tn: number; salidas_tn: number; saldo_tn: number; diferencia_tn: number
    traspasos_sin_destino_tn: number; traspasos_sin_origen_tn: number }>
  alertas: Array<{ nivel: 'error' | 'aviso' | 'info'; area: 'st' | 'almacenes' | 'calidad' | 'adelantos'; mensaje: string }>
  tms: { guias_30d: number; en_tms: number }
  estadia: { saldo_estadia_tn: number; saldo_produccion_flujo_tn: number; explicacion: string }
}

// Etiquetas para la interfaz
export const ALMACEN_LABEL: Record<FlowAlmacen, string> = { '647': '647 · ALM PT', '540': '540 · APT LB', ST: 'ST VENTAS' }
export const ALMACEN_ROL: Record<FlowAlmacen, string> = {
  '647': 'Recibe toda la producción',
  '540': 'Stock antiguo y adelantos IPT (en suspensión)',
  ST: 'Solo lo que se guía; ideal: saldo 0',
}
export const ORIGEN_LABEL: Record<FlowOrigen, string> = {
  PRODUCCION: 'Producción del periodo',
  INICIAL_647: 'Stock previo 647',
  INICIAL_540: 'Stock previo 540',
  INICIAL_ST: 'Stock previo ST',
  DEVOLUCION: 'Devoluciones',
  OTRO_ALMACEN: 'Otros almacenes',
}

// Kardex de trazabilidad (apt_kardex)
export type KardexTipo = 'INICIAL' | 'PRODUCCION' | 'TRASPASO_ENT' | 'TRASPASO_SAL' | 'DESPACHO' | 'CONSUMO' | 'DEVOLUCION'
export type KardexNivel = 'lote_producto' | 'producto' | 'lote' | 'total'
export interface KardexFilters {
  desde?: string; hasta?: string; lote?: string; lote_exacto?: string; ot?: string; clientes?: string[]
  producto?: string; glosa?: string; documento?: string; almacenes?: FlowAlmacen[]; tipos?: KardexTipo[]
}
export interface KardexRow {
  id: number; clave: string; fecha: string; tipo: KardexTipo; documento: string | null; tipodocto: string | null
  almacen: FlowAlmacen; contraparte: string | null; lote: string; lote_rel: string | null; producto: string; glosa: string | null
  cliente: string | null; numrel: string | null; docrel: string | null; unidad: string | null
  cant_in: number | null; cant_out: number | null; kg_in: number | null; kg_out: number | null
  saldo_kg: number; saldo_cant: number | null; saldo_kg_antes: number
}
export interface Kardex {
  desde: string; hasta: string; data_min: string; data_max: string; nivel: KardexNivel; por_almacen: boolean
  total: number; offset: number; limit: number
  resumen: { claves: number; movimientos: number; guias: number; lotes: number; saldo_inicial_tn: number; entradas_tn: number
    salidas_tn: number; saldo_final_tn: number; claves_negativas: number }
  almacenes: Array<{ almacen: FlowAlmacen; inicial_tn: number; entradas_tn: number; salidas_tn: number; saldo_tn: number }>
  tipos: Array<{ tipo: KardexTipo; filas: number; tn: number }>
  filas: KardexRow[]
}
export const KARDEX_TIPO_LABEL: Record<KardexTipo, string> = {
  INICIAL: 'Stock previo', PRODUCCION: 'Ingreso producción', TRASPASO_ENT: 'Traspaso recibido', TRASPASO_SAL: 'Traspaso enviado',
  DESPACHO: 'Guía al cliente', CONSUMO: 'Consumo interno', DEVOLUCION: 'Devolución',
}
