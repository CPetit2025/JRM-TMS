// Eficiencia de Flota: tipos de las funciones fe_* (supabase/migrations/20261003180000_eficiencia_flota.sql)

export type FeClase = 'TRANSPORTE' | 'MONTACARGA' | 'ELEVACION'
export type FeRec =
  | 'Reemplazar' | 'Planificar reemplazo' | 'Vigilar' | 'Consolidar carga' | 'Alta reciente' | 'Mantener' | 'Verificar estado'
  | 'Dar de baja o alquilar' | 'Registrar horómetro'
export interface FeCorte { manual: string | null; combustible: string; mantenimiento: string; rutas: string }
export interface FeFilters { desde?: string; hasta?: string }

export interface FeYear {
  anio: number; meses_km: number; km: number | null; gal: number | null; comb: number | null; mant: number | null; viajes: number | null
  ton: number | null; mant_km: number | null; kmgal: number | null; costo_km: number | null; precio: number | null
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
}
export interface FeEquipo {
  code: string; nombre: string; clase: FeClase; tipo: string | null; anio_fab: number | null; edad: number | null; vida_util: number
  valor_reposicion: number | null; activo: boolean; mant: number; meses_cub: number; costo_anual: number | null; corr_pct: number | null
  mayores: number; dias_fuera: number; ult_registro: string | null; horas_anio: number | null; lecturas: number | null
  horometro: number | null; horometro_fecha: string | null; costo_hora: number | null; score: number; rec: FeRec; motivos: string[]
}
export interface FeParams {
  vida_util: Record<FeClase, number>; horas_min_anio: number; factor_costo: number; tendencia_mant_km: number; volumen_min: number; factor_tkm: number
}
export interface FeResumen {
  desde: string; hasta: string; meses: number; corte: FeCorte; params: FeParams
  medianas: { costo_tkm: number | null; mant_km: number | null; costo_hora: number | null }
  kpis: { km: number | null; gal: number | null; tkm: number | null; ton: number | null; comb: number | null; mant: number | null; viajes: number | null
    activos: number; equipos: number; transporte: number; mant_equipos: number | null; mant_transporte: number | null }
  precio_anio: Record<string, number>
  transporte: FeTransporte[]
  equipos: FeEquipo[]
  cobertura: {
    excel: FeUploadSummary | null; ultima_carga: { archivo: string; fecha: string } | null
    meses: Array<{ mes: string; fuente: string; km: number | null; comb: number | null; mant: number | null; viajes: number | null; ton: number | null }>
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
  unidades: Array<{ code: string; tipo: string | null; viajes: number; ton: number | null; kg_viaje: number | null; m3: number | null; km_viaje: number | null; sin_peso: number }>
  actividad: Array<{ t: string; viajes: number; ton: number | null }>
  descarga: Record<string, number>
  provincias: Array<{ provincia: string; viajes: number }>
  espera_mediana: number | null
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
}
export interface FeDatos {
  can_load: boolean; corte: FeCorte
  settings: { desde: string; corte: string | null; params: FeParams; updated_at: string }
  activos: FeAsset[]
  unidades_tms: Array<{ plate: string; type: string | null }>
  cargas: Array<{ id: string; archivo: string; estado: string; fecha: string; resumen: FeUploadSummary | null }>
  calidad_excel: FeCalidad[] | null
  calidad_tms: FeCalidad[]
  lecturas: Array<{ code: string; fecha: string; horas: number; nota: string | null }>
  cobertura: Array<{ code: string; mes: string; k: boolean | null; c: boolean | null; m: boolean | null; mc: boolean; r: boolean | null; f: string }>
}

export const CLASE_LABEL: Record<FeClase, string> = { TRANSPORTE: 'Transporte', MONTACARGA: 'Montacarga', ELEVACION: 'Elevación' }
export type FeTone = 'crit' | 'warn' | 'info' | 'good' | 'muted'
export const REC_TONE: Record<FeRec, FeTone> = {
  'Reemplazar': 'crit', 'Dar de baja o alquilar': 'crit', 'Planificar reemplazo': 'warn', 'Vigilar': 'warn', 'Consolidar carga': 'warn',
  'Verificar estado': 'muted', 'Registrar horómetro': 'muted', 'Alta reciente': 'info', 'Mantener': 'good',
}
export const REC_ORDER: FeRec[] = ['Reemplazar', 'Dar de baja o alquilar', 'Planificar reemplazo', 'Vigilar', 'Consolidar carga', 'Verificar estado', 'Registrar horómetro', 'Alta reciente', 'Mantener']
