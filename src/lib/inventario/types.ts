// Tipos de las lecturas public.inv_* (inventario multi-almacén)

export type InvKind = 'MATERIA_PRIMA' | 'PRODUCCION' | 'PRODUCTO_TERMINADO' | 'DESPACHO' | 'PERNERIA' | 'MRO' | 'MANTENIMIENTO'
  | 'HERRAMIENTAS' | 'ACTIVOS' | 'TERCERO' | 'OBRA' | 'OTRO'
export type InvClase = 'PRODUCCION' | 'COMPRA' | 'TRASPASO' | 'DESPACHO' | 'CONSUMO' | 'SERVICIO_TERCERO' | 'PRESTAMO' | 'DEVOLUCION'
  | 'AJUSTE' | 'OTRO'

export interface InvStateInfo {
  dirty: boolean
  rebuilt_at: string | null
  data_min: string | null
  data_max: string | null
  model_from: string | null
  snapshot_cutoff: string | null
  stats: { movimientos?: number; capas?: number; consumos?: number; traspasos_enlazados?: number; traspasos_sin_destino?: number
    traspasos_sin_origen?: number; segundos?: number }
  desde?: string
  hasta?: string
}

export interface InvOverview {
  state: InvStateInfo
  bodegas: Array<{ bodega: string; kind: InvKind; stage: number; claves: number; kg: number; kg_libre: number; kg_comprometido: number
    claves_sin_peso: number; claves_inferidas: number; edad_max: number | null }>
  movimientos: Array<{ clase: InvClase; side: 'E' | 'S'; lineas: number; docs: number; kg: number }>
  serie: Array<{ fecha: string; produccion: number; compras: number; despachos: number; consumos: number; traspasos: number }>
  calidad: { sin_peso: number; lineas: number; error_contrato: number; lote_minusculas: number; traspasos_sin_destino: number | null
    traspasos_sin_origen: number | null; claves_inferidas: number; qty_inferida_consumida: number }
  herramientas: { salidas: number; pendientes: number; unidades_pendientes: number
    detalle: Array<{ numero: string; fecha: string; cliente: string | null; producto: string; glosa: string | null; salida: number; devuelto: number; pendiente: number }> }
  terceros: { guias: number; sin_retorno: number; kg_enviado: number; kg_retornado: number
    detalle: Array<{ numero: string; fecha: string; proveedor: string | null; bodega: string; lotes: string | null; kg: number; kg_retorno: number
      ultima: string | null; lotes_retorno: string | null }> }
}

export interface InvStockRow {
  bodega: string; kind: InvKind; producto: string; glosa: string | null; lote: string | null; ot: string | null; cliente: string | null
  unidad: string | null; qty: number; kg: number; kg_conocido: boolean; fecha_ingreso: string | null; fecha_origen: string | null
  dias_bodega: number | null; dias_origen: number | null; inferido: number; foto: number; capas: number
}
export interface InvStock {
  corte: string | null; dirty: boolean; snapshot_cutoff: string | null; total: number
  totales: { kg: number; kg_libre: number; kg_comprometido: number; claves: number; claves_inferidas: number; claves_sin_peso: number }
  filas: InvStockRow[]
}
export interface InvStockFilters { bodegas?: string[]; kinds?: InvKind[]; q?: string; estado?: '' | 'libre' | 'comprometido'; min_dias?: number
  orden?: 'kg' | 'edad' | 'qty'; limit?: number; offset?: number; ambito?: 'apt' }

export interface InvDwell {
  desde: string; hasta: string; corte: string; model_from: string | null
  por_bodega: Array<{ bodega: string; kind: InvKind; stage: number; consumos: number; kg: number; prom_dias: number | null; prom_dias_kg: number | null
    p50: number | null; p90: number | null; max: number | null; pct_sin_fecha: number | null; prom_origen: number | null }>
  por_destino: Array<{ bodega: string; destino: InvClase; consumos: number; kg: number; prom_dias: number | null; prom_origen: number | null }>
  distribucion: Array<{ bodega: string; rango: string; consumos: number; kg: number }>
  antiguedad_stock: Array<{ bodega: string; rango: string; claves: number; kg: number }>
  mas_antiguos: Array<{ bodega: string; producto: string; glosa?: string | null; lote: string | null; qty: number; kg: number; fecha_ingreso: string; dias: number; fecha_origen: string | null }>
  etapas: Array<{ origen: InvClase | null; origen_bodega: string | null; bodega: string; destino: InvClase; consumos: number; kg: number
    prom_bodega: number | null; prom_origen: number | null }>
}

export interface InvFlow {
  desde: string; hasta: string
  bodegas: Array<{ code: string; kind: InvKind; stage: number }>
  traspasos: Array<{ origen: string; destino: string; docs: number; lineas: number; kg: number; reasignadas: number; dias_en_origen: number | null }>
  ingresos: Array<{ clase: InvClase; bodega: string; lineas: number; kg: number }>
  salidas: Array<{ clase: InvClase; bodega: string; lineas: number; kg: number }>
  reasignaciones: Array<{ origen: string; destino: string; numero: string; fecha: string; producto: string; glosa?: string | null; lote_origen: string | null
    lote_destino: string | null; qty: number; kg: number }>
}

export interface InvTraceMove {
  id: number; fecha: string; side: 'E' | 'S'; clase: InvClase; tipodocto: string; bodega: string; kind: InvKind; stage: number; numero: string
  producto: string; glosa: string | null; cantidad: number; unidad: string | null; kg: number | null; lote: string | null; num_rel: string | null
  razon_social: string | null; doc_rel: string | null; ref_numero: string | null; comentario: string | null
}
export interface InvTrace {
  q: string; encontrado: boolean; lotes?: string[]; lotes_buscados?: string[]; lotes_origen?: string[]; lotes_derivados?: string[]
  ops?: string[]; truncado?: boolean
  movimientos?: InvTraceMove[]
  enlaces?: Array<{ out_id: number; in_id: number; qty: number; origen: string; destino: string; lote_origen: string | null; lote_destino: string | null
    numero: string; fecha: string }>
  etapas?: Array<{ bodega: string; kind: InvKind; stage: number; primera: string; ultima: string; entradas_kg: number; salidas_kg: number
    entradas: number; salidas: number }>
  saldo?: Array<{ bodega: string; producto: string; lote: string | null; qty: number; kg: number; fecha_ingreso: string | null; inferido: number }>
  estadia?: Array<{ bodega: string; consumos: number; prom_dias: number | null; max_dias: number | null }>
}

export interface InvStatus {
  can_load: boolean
  state: InvStateInfo
  cobertura: Array<{ side: 'E' | 'S'; desde: string; hasta: string; filas: number; dias: number }>
  huecos: Array<{ side: 'E' | 'S'; desde: string; hasta: string }>
  cargas: Array<{ id: string; side: 'E' | 'S' | 'STOCK'; file_name: string; status: string; desde: string | null; hasta: string | null
    cutoff: string | null; filas: number; total: number; excluidas: Record<string, number>; reemplazadas: number | null
    applied_at: string | null; created_at: string }>
}

export interface InvCatalogs {
  can_load: boolean
  bodegas: Array<{ code: string; name: string; kind: InvKind; stage: number; auto: boolean; movimientos: number }>
  tipos: Array<{ tipodocto: string; clase: InvClase; auto: boolean; movimientos: number }>
}

export type InvCheckState = 'OK' | 'AVISO' | 'FALLA' | 'SIN_DATOS'
export interface InvVerify {
  ok: number; total: number; corte: string | null; desde: string | null; model_from: string | null; snapshot_cutoff: string | null
  checks: Array<{ id: string; titulo: string; valor: number | null; meta: number | null; unidad: string | null; estado: InvCheckState; detalle: string }>
  cuadre: Array<{ bodega: string; kind: InvKind; lineas: number; saldo_inicial_foto: number; saldo_inicial_inferido: number
    entradas_archivo: number; entradas_modelo: number; salidas_archivo: number; salidas_modelo: number
    saldo_calculado: number; saldo_modelo: number; diferencia: number; ok: boolean }>
}

// APT en tres almacenes (647 · 540 · ST): contratos / OT
export type AptAlmacen = '647' | '540' | 'ST'
export interface InvCacheInfo { al_dia: boolean; built_at: string }

export interface InvContratoFila {
  ot: string; cliente: string | null; productos: number; lotes: number; guias: number
  ingresado_kg: number; despachado_kg: number; avance_pct: number | null; stock_kg: number; stock_qty: number
  stock_647_kg: number; stock_540_kg: number; stock_st_kg: number; dias_stock: number | null; a_tiempo_pct: number | null
  primer_ingreso: string | null; ultimo_ingreso: string | null; ultima_salida: string | null; fecha_entrega: string | null
}
export interface InvContratos { corte: string | null; cache?: InvCacheInfo; contratos: InvContratoFila[] }

export interface InvAptResumen {
  corte: string | null; cache?: InvCacheInfo
  almacenes: Array<{ almacen: AptAlmacen; stock_kg: number; kg_libre: number; kg_comprometido: number; claves: number; ots: number
    dias_pond: number | null; antiguedad: Record<'0-30' | '31-60' | '61-90' | '>90' | 'sin fecha', number>
    ingresado_kg: number; despachado_kg: number; ingresado_kg_30: number; despachado_kg_30: number; guias_30: number }>
  top_ot: InvContratoFila[]
}

export interface InvContratoProducto {
  producto: string; glosa: string | null; unidad: string | null; lotes: string[]; guias: number
  ingresado: number; producido: number; despachado: number; otras_salidas: number; diferencia: number
  stock_647: number; stock_540: number; stock_st: number; stock: number; stock_kg: number; inferido: number
  ingresado_kg: number; despachado_kg: number; ultimo_ingreso: string | null; ultima_salida: string | null; dias_apt: number | null
}
export interface InvContratoTms { dispatch_id: string; numero: string | null; estado: string | null; programado: string | null
  salida: string | null; llegada: string | null; placa: string | null; conductor: string | null }
export interface InvContrato {
  ot: string; corte: string | null; encontrado: boolean; stock_al_dia?: boolean
  resumen?: { cliente: string | null; ingresado_kg: number; despachado_kg: number; otras_salidas_kg: number; avance_pct: number | null
    guias: number; productos: number; lotes: number; primer_ingreso: string | null; ultimo_ingreso: string | null; ultima_salida: string | null
    fecha_entrega_min: string | null; fecha_entrega_max: string | null; a_tiempo_pct: number | null
    stock_kg: number; stock_647_kg: number; stock_540_kg: number; stock_st_kg: number }
  productos?: InvContratoProducto[]
  lotes?: Array<{ lote: string; lineas: number; ingresado_kg: number; despachado_kg: number }>
  guias?: Array<{ numero: string; fecha: string; almacen: AptAlmacen; cliente: string | null; lineas: number; cantidad: number; kg: number
    fecha_entrega: string | null; a_tiempo: boolean | null; tms: InvContratoTms | null }>
  sospechosos?: Array<{ ot: string; lotes: string[]; lineas: number }>
}
