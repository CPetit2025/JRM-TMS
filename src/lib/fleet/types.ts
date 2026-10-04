// Eficiencia de Flota: tipos de las funciones fe_* (migraciones 20261003180000_eficiencia_flota y 20261004100000_eficiencia_flota_v2)

export type FeClase = 'TRANSPORTE' | 'MONTACARGA' | 'ELEVACION'
export type FeRec =
  | 'Reemplazar' | 'Planificar reemplazo' | 'Vigilar' | 'Reasignar carga' | 'Alta reciente' | 'Mantener' | 'Verificar estado'
  | 'Dar de baja o alquilar' | 'Registrar horómetro'
export interface FeCorte { manual: string | null; combustible: string; mantenimiento: string; rutas: string }
export interface FeFilters { desde?: string; hasta?: string }
export type FeGrupo = 'TRACTO' | 'CAMION' | 'GRUA' | 'LIVIANO' | 'MONTACARGA' | 'ELEVACION'
export type FeConfianza = 'Alta' | 'Media' | 'Baja'
// Decisión económica: costo de seguir un año más frente al costo anual equivalente de una unidad nueva
export interface FeEcon { seguir: number; nuevo: number; ahorro: number; anios: number | null; capital_nuevo: number; operacion_nueva: number }

export interface FeYear {
  anio: number; meses_km: number; km: number | null; gal: number | null; comb: number | null; mant: number | null; viajes: number | null
  ton: number | null; mant_km: number | null; kmgal: number | null; costo_km: number | null; precio: number | null
  mant_amort?: number | null; mant_km_sl?: number | null
}
export interface FeTransporte {
  code: string; nombre: string; tipo: string | null; marca: string | null; anio_fab: number | null; edad: number | null; vida_util: number
  capacidad_kg: number | null; valor_reposicion: number | null; activo: boolean; solo_tms: boolean
  meses_km: number | null; km: number | null; gal: number | null; comb: number | null; mant: number | null; kmgal: number | null
  comb_km: number | null; mant_km: number | null; costo_km: number | null
  meses_t: number | null; ton: number | null; tkm: number | null; viajes: number | null; costo_t: number | null; costo_tkm: number | null
  comb_tkm: number | null; mant_tkm: number | null; kg_viaje: number | null; m3: number | null; viajes_mes: number | null; ton_mes: number | null
  km_tot: number | null; gal_tot: number | null; comb_tot: number | null; mant_tot: number | null; viajes_tot: number | null; ton_tot: number | null
  mayores: number | null; dias_fuera: number | null; ult_uso: string | null; meses_con_km: number; meses_con_comb: number; meses_con_rutas: number
  glp: boolean | null; km_anio: number | null; tend_mant_km: number | null; score: number; rec: FeRec; motivos: string[]; anios: FeYear[]
  // v2: precio constante, mantenimiento devengado, mano de obra, grupo, asignación, economía e integración
  grupo: FeGrupo; vehicle_id: string | null; valor: number | null; valor_ref: boolean; residual: number | null
  capacidad: number | null; capacidad_fuente: 'ficha' | 'flota' | 'p95' | null; llenado: number | null; ociosa: boolean | null
  comb_c: number | null; mant_a: number | null; otros: number | null; mo: number | null
  costo_km_real: number | null; costo_km_total: number | null; costo_tkm_total: number | null; costo_tkm_real: number | null; mo_tkm: number | null
  kmgal_grupo: number | null; mant_km_grupo: number | null; costo_km_grupo: number | null; n_grupo: number | null
  rend_rel: number | null; mant_rel: number | null; mant_km_joven: number | null; confianza: FeConfianza
  mant_anual: number | null; mant_anual_sl: number | null; comb_anual: number | null
  econ: FeEcon | null; econ_bajo: FeEcon | null; econ_alto: FeEcon | null
  fallas: number | null; corr_pct: number | null; neum: number | null; horas_viaje: number | null; espera_viaje: number | null
  programados_pct: number | null; prev_a_tiempo: number | null; prev_evaluados: number | null
}
export interface FeEquipo {
  code: string; nombre: string; clase: FeClase; tipo: string | null; anio_fab: number | null; edad: number | null; vida_util: number
  valor_reposicion: number | null; activo: boolean; mant: number; meses_cub: number; costo_anual: number | null; corr_pct: number | null
  mayores: number; dias_fuera: number; ult_registro: string | null; horas_anio: number | null; lecturas: number | null
  horometro: number | null; horometro_fecha: string | null; costo_hora: number | null; score: number; rec: FeRec; motivos: string[]
  grupo: FeGrupo; vehicle_id: string | null; valor: number | null; valor_ref: boolean; mant_caja: number; fallas: number
  propiedad_anual: number | null; costo_propio_anual: number | null; costo_propio_hora: number | null; alquiler_anual: number | null
  horas_equilibrio: number | null; mant_joven: number | null; econ: FeEcon | null; econ_bajo: FeEcon | null; econ_alto: FeEcon | null
}
export interface FeCurva { d1: number; d: number; piso: number }
export interface FeParams {
  vida_util: Record<FeClase, number>; horas_min_anio: number; factor_costo: number; tendencia_mant_km: number; volumen_min: number; factor_tkm: number
  tasa_capital: number; tasa_baja: number; tasa_alta: number
  reventa: Record<'PESADO' | 'LIVIANO' | 'MONTACARGA' | 'ELEVACION', FeCurva>
  valor_ref: Record<FeGrupo, number>
  conductor_mes: number; ayudante_mes: number; factor_cargas: number; horas_mes: number
  alquiler_hora: number; precio_ref: number | null; precio_ref_glp: number | null
  amortizar_meses: number; mejora_nuevo: number; mant_nuevo_pct: number; rendimiento_min: number; factor_mant: number
}
export interface FeResumen {
  desde: string; hasta: string; meses: number; corte: FeCorte; params: FeParams
  medianas: { costo_hora: number | null }
  precio_ref: number | null; precio_ref_glp: number | null; tasas: [number, number, number]
  mano_obra: { conductor_mes: number; ayudante_hora: number }; alquiler_hora: number
  grupos: Partial<Record<FeGrupo, { n: number; kmgal: number | null; mant_km: number | null; costo_km: number | null }>>
  kpis: { km: number | null; gal: number | null; tkm: number | null; ton: number | null; comb: number | null; comb_c: number | null; mant: number | null
    mant_amort: number | null; mant_correctivo: number | null; neumaticos: number | null; otros: number | null; mo: number | null; viajes: number | null
    activos: number; equipos: number; transporte: number; mant_equipos: number | null; mant_transporte: number | null
    ahorro_reemplazo: number | null; ahorro_alquiler: number | null }
  precio_anio: Record<string, number>
  transporte: FeTransporte[]
  equipos: FeEquipo[]
  cobertura: {
    excel: FeUploadSummary | null; ultima_carga: { archivo: string; fecha: string } | null
    meses: Array<{ mes: string; fuente: string; km: number | null; comb: number | null; mant: number | null; viajes: number | null; ton: number | null }>
    vinculados: number
  }
}
export interface FeMensualRow {
  code: string; clase: FeClase; mes: string; fuente: string; km: number | null; gal: number | null; comb: number | null; mant: number | null
  mant_cubierto: boolean; viajes: number | null; kg: number | null; tkm: number | null; m3: number | null; dias_fuera: number | null
  sin_peso: number | null; kmgal: number | null; costo_km: number | null
}
export interface FeRutas {
  desde: string; hasta: string; corte: FeCorte
  mensual: Array<{ mes: string; viajes: number; ton: number | null; fuente: string }>
  unidades: Array<{ code: string; tipo: string | null; viajes: number; ton: number | null; kg_viaje: number | null; m3: number | null; km_viaje: number | null; sin_peso: number
    horas_viaje: number | null; espera_viaje: number | null; viajes_dia: number | null; horas_dia: number | null; programados: number | null }>
  actividad: Array<{ t: string; viajes: number; ton: number | null }>
  descarga: Record<string, number>
  provincias: Array<{ provincia: string; viajes: number }>
  espera_mediana: number | null
  clientes: FeCostoServir[]
  distritos: Array<{ nombre: string; viajes: number; ton: number | null; costo: number | null; costo_t: number | null; km_viaje: number | null; horas_viaje: number | null }>
  productividad: {
    viajes: number; con_horas: number; horas_viaje: number | null; espera_viaje: number | null; espera_pct: number | null; espera_costo: number | null
    no_programados: number; programado_dato: number; costo_total: number | null; clientes: number; distritos: number; conductor_hora: number; ayudante_hora: number
  }
}
export interface FeCostoServir {
  nombre: string; viajes: number; ton: number | null; costo: number | null; costo_t: number | null; costo_viaje: number | null
  espera_h: number | null; espera_viaje: number | null; no_programados: number; km_viaje: number | null; viajes_costeados: number
}
export interface FeRecambios {
  corte: FeCorte; hoy: string
  activos: Array<{ code: string; nombre: string; clase: FeClase; tipo: string | null; anio_fab: number | null; activo: boolean; desde: string; hasta: string; meses: number }>
}
export interface FeCalidad { fuente: string; problema: string; casos: number; monto?: number; tratamiento?: string; efecto?: string }
export interface FeUploadSummary {
  mantenimiento: number; combustible_meses: number; viajes: number; activos: number; calidad: FeCalidad[]
  mant_desde: string | null; mant_hasta: string | null; comb_desde: string | null; comb_hasta: string | null; rutas_desde: string | null; rutas_hasta: string | null
}
export interface FeAsset {
  code: string; nombre: string | null; clase: FeClase; tipo: string | null; marca: string | null; anio_fab: number | null; capacidad_kg: number | null
  valor_reposicion: number | null; vida_util: number | null; vehicle_plate: string | null; activo: boolean; alias: string[]; editado: boolean
  vehicle_id: string | null; vinculo?: string | null; grupo?: FeGrupo
}
export interface FeUnidadFlota { id: string; plate: string | null; type: string | null; internal_code: string | null; year: string | null; weight_capacity: string | null }
export interface FeDatos {
  can_load: boolean; corte: FeCorte
  settings: { desde: string; corte: string | null; params: FeParams; updated_at: string }
  activos: FeAsset[]
  unidades_tms: FeUnidadFlota[]
  cargas: Array<{ id: string; archivo: string; estado: string; fecha: string; resumen: FeUploadSummary | null }>
  calidad_excel: FeCalidad[] | null
  calidad_tms: FeCalidad[]
  lecturas: Array<{ code: string; fecha: string; horas: number; nota: string | null }>
  cobertura: Array<{ code: string; mes: string; k: boolean | null; c: boolean | null; m: boolean | null; mc: boolean; r: boolean | null; f: string }>
}

export const CLASE_LABEL: Record<FeClase, string> = { TRANSPORTE: 'Transporte', MONTACARGA: 'Montacarga', ELEVACION: 'Elevación' }
export const GRUPO_LABEL: Record<FeGrupo, string> = {
  TRACTO: 'Tracto', CAMION: 'Camión', GRUA: 'Camión grúa', LIVIANO: 'Liviano', MONTACARGA: 'Montacarga', ELEVACION: 'Elevación',
}
export type FeTone = 'crit' | 'warn' | 'info' | 'good' | 'muted'
export const REC_TONE: Record<FeRec, FeTone> = {
  'Reemplazar': 'crit', 'Dar de baja o alquilar': 'crit', 'Planificar reemplazo': 'warn', 'Vigilar': 'warn', 'Reasignar carga': 'warn',
  'Verificar estado': 'muted', 'Registrar horómetro': 'muted', 'Alta reciente': 'info', 'Mantener': 'good',
}
export const REC_ORDER: FeRec[] = ['Reemplazar', 'Dar de baja o alquilar', 'Planificar reemplazo', 'Reasignar carga', 'Vigilar', 'Verificar estado', 'Registrar horómetro', 'Alta reciente', 'Mantener']
