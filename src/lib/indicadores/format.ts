import type { Equipo, EstadoDatos, EstadoKpi, Frecuencia, KpiResultado } from './api'

export const FRECUENCIAS: Array<[Frecuencia, string]> = [['SEMANAL', 'Semanal'], ['QUINCENAL', 'Quincenal'], ['MENSUAL', 'Mensual']]
export const EQUIPOS: Array<[Equipo, string]> = [['TRANSPORTE', 'Transporte'], ['DESPACHO', 'Despacho'], ['INVENTARIO', 'Inventario'], ['AUDITORIA', 'Auditoría']]
export const equipoTxt = (e: string) => EQUIPOS.find(x => x[0] === e)?.[1] || e

export const ESTADOS_DATOS: Array<[EstadoDatos, string]> = [['ACTIVO', 'Activo'], ['PARCIAL', 'Parcial'], ['PENDIENTE_CAPTURA', 'Pendiente de captura'], ['PENDIENTE_INTEGRACION', 'Pendiente de integración']]

export const MOTIVOS: Array<[string, string]> = [
  ['FALLA_GPS', 'Falla de GPS o de señal'], ['ERROR_REGISTRO', 'Error de registro'], ['OLVIDO_REGISTRO', 'Olvido de registro'],
  ['DOC_MAL_CLASIFICADO', 'Documento mal clasificado'], ['CAMBIO_CLIENTE', 'Cambio pedido por el cliente'],
  ['EXCLUIR_PRUEBA', 'Prueba o duplicado (excluir)'], ['OTRO', 'Otro'],
]
export const motivoTxt = (m: string) => MOTIVOS.find(x => x[0] === m)?.[1] || m

/** Semáforo. Solo CUMPLE/ALERTA/NO_CUMPLE llevan verde/ámbar/rojo: los estados sin evaluación nunca se pintan como resultado. */
export const ESTADO: Record<EstadoKpi, { label: string; badge: string; text: string; dot: string; evaluado: boolean }> = {
  CUMPLE: { label: 'Cumple', badge: 'bg-emerald-50 text-emerald-800 border-emerald-200', text: 'text-emerald-700', dot: '#047857', evaluado: true },
  ALERTA: { label: 'Alerta', badge: 'bg-amber-50 text-amber-800 border-amber-200', text: 'text-amber-700', dot: '#b45309', evaluado: true },
  NO_CUMPLE: { label: 'No cumple', badge: 'bg-red-50 text-red-800 border-red-200', text: 'text-red-700', dot: '#b91c1c', evaluado: true },
  DATOS_INSUFICIENTES: { label: 'Datos insuficientes', badge: 'bg-sky-50 text-sky-800 border-sky-200', text: 'text-slate-400', dot: '#94a3b8', evaluado: false },
  SIN_REGISTROS: { label: 'Sin registros', badge: 'bg-slate-100 text-slate-700 border-slate-200', text: 'text-slate-400', dot: '#94a3b8', evaluado: false },
  PENDIENTE_DATOS: { label: 'Pendiente de datos', badge: 'bg-slate-100 text-slate-700 border-slate-200', text: 'text-slate-400', dot: '#94a3b8', evaluado: false },
}
export const estadoInfo = (e: string) => ESTADO[e as EstadoKpi] || ESTADO.PENDIENTE_DATOS

/** Texto explícito para los estados que no se evalúan (regla de honestidad visual). */
export function estadoNota(k: Pick<KpiResultado, 'estado' | 'nota_datos' | 'cobertura'>): string | null {
  if (k.estado === 'PENDIENTE_DATOS') return `Pendiente de datos${k.nota_datos ? `: ${k.nota_datos}` : ''}`
  if (k.estado === 'SIN_REGISTROS') return 'Sin registros en el periodo'
  if (k.estado === 'DATOS_INSUFICIENTES') return `Datos insuficientes: cobertura ${num(k.cobertura)} %`
  return null
}

export const num = (v: number | null | undefined, decimales = 1) =>
  v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('es-PE', { minimumFractionDigits: decimales, maximumFractionDigits: decimales })

/** Valor con su unidad: 1 decimal; los conteos ('n') sin decimales forzados. */
export function valorTxt(v: number | null | undefined, unidad: string): string {
  if (v == null) return '—'
  const n = unidad === 'n' ? Number(v).toLocaleString('es-PE', { maximumFractionDigits: 1 }) : num(v)
  if (unidad === '%') return `${n} %`
  if (unidad === 'n') return n
  if (unidad === 'S/ por km') return `S/ ${n} por km`
  return `${n} ${unidad}`
}
export const metaTxt = (k: Pick<KpiResultado, 'meta' | 'sentido' | 'unidad'>) => k.meta == null ? 'Sin meta' : `${k.sentido === 'MENOR' ? '≤' : '≥'} ${valorTxt(k.meta, k.unidad)}`

export const fechaTxt = (d: string | null | undefined) => d ? new Date(d.length === 10 ? `${d}T12:00:00` : d).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Lima' }) : '—'
export const fechaHoraTxt = (d: string | null | undefined) => d ? new Date(d).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Lima' }) : '—'

/** Contexto del registro (`dims`) como «clave: valor» compactos; omite nulos y vacíos. */
export function dimsTxt(dims: Record<string, unknown> | null | undefined): string[] {
  return Object.entries(dims || {}).flatMap(([k, v]) => {
    if (v == null || v === '') return []
    const clave = k.replace(/_/g, ' ')
    if (typeof v === 'number') return [`${clave}: ${v.toLocaleString('es-PE', { maximumFractionDigits: 2 })}`]
    if (typeof v === 'boolean') return [`${clave}: ${v ? 'sí' : 'no'}`]
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return [`${clave}: ${fechaHoraTxt(v)}`]
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return [`${clave}: ${fechaTxt(v)}`]
    return [`${clave}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`]
  })
}

export const estadoPeriodoTxt =(estado: string, version: number | null, provisional: boolean) =>
  estado === 'CERRADO' ? `Cerrado v${version ?? 1}` : estado === 'REABIERTO' ? `Reabierto${provisional ? ' · provisional' : ''}` : `Abierto${provisional ? ' · provisional' : ''}`
