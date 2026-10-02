import type { AptEstado, AptTipoLote } from './types'

// Formatos del módulo APT: TN 2 decimales, KG 0, días enteros, % 1 decimal, fechas dd/mm/aaaa
const nf = (d: number) => new Intl.NumberFormat('es-PE', { minimumFractionDigits: d, maximumFractionDigits: d })
const tnF = nf(2), kgF = nf(0), pctF = nf(1), intF = nf(0)

export const fmtTn = (v: number | null | undefined) => (v === null || v === undefined ? '—' : tnF.format(Number(v)))
export const fmtKg = (v: number | null | undefined) => (v === null || v === undefined ? '—' : kgF.format(Number(v)))
export const fmtInt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : intF.format(Number(v)))
export const fmtDias = (v: number | null | undefined) => (v === null || v === undefined ? '—' : intF.format(Math.round(Number(v))))
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${pctF.format(Number(v))} %`)
export const fmtDec1 = (v: number | null | undefined) => (v === null || v === undefined ? '—' : pctF.format(Number(v)))
export const fmtDate = (v: string | null | undefined) => {
  if (!v) return '—'
  const [y, m, d] = v.slice(0, 10).split('-')
  return d && m && y ? `${d}/${m}/${y}` : v
}
export const fmtDateTime = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'

// Paleta: azul corporativo JRM para volumen, ámbar→rojo para antigüedad (prioridad)
export const APT_COLORS = {
  navy: '#002855',
  red: '#cf152d',
  blue: '#2563eb',
  sky: '#0ea5e9',
  teal: '#0d9488',
  amber: '#f59e0b',
  orange: '#ea580c',
  slate: '#64748b',
  grid: '#e2e8f0',
  in: '#2563eb',
  out: '#0d9488',
  stock: '#002855',
}

// Color por posición del rango de aging (0 = más reciente). Escala verde → amarillo → rojo.
const AGING_SCALE = ['#10b981', '#34d399', '#a3e635', '#facc15', '#f59e0b', '#f97316', '#ef4444', '#b91c1c', '#7f1d1d', '#450a0a']
export function agingColor(index: number, total: number) {
  if (total <= 1) return AGING_SCALE[0]
  const pos = Math.round((index / (total - 1)) * (AGING_SCALE.length - 3))
  return AGING_SCALE[Math.min(Math.max(pos, 0), AGING_SCALE.length - 1)]
}

// Semáforo por días frente al umbral de alerta
export function diasTone(dias: number | null | undefined, alert = 60): 'ok' | 'warn' | 'crit' | 'none' {
  if (dias === null || dias === undefined) return 'none'
  if (dias > alert) return 'crit'
  if (dias > 15) return 'warn'
  return 'ok'
}
export const TONE_CLASS = {
  ok: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  warn: 'bg-amber-50 text-amber-700 border-amber-200',
  crit: 'bg-red-50 text-red-700 border-red-200',
  none: 'bg-slate-50 text-slate-500 border-slate-200',
} as const

export const ESTADO_STYLE: Record<AptEstado, { cls: string; color: string; help: string }> = {
  'En APT': { cls: 'bg-blue-50 text-blue-700 border-blue-200', color: '#2563eb', help: 'Sin salidas todavía, dentro del plazo de alerta' },
  'Salida parcial': { cls: 'bg-amber-50 text-amber-700 border-amber-200', color: '#f59e0b', help: 'Tiene despachos y aún queda saldo' },
  Despachado: { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', color: '#10b981', help: 'Despachado dentro de la tolerancia' },
  'Sin salida identificada': { cls: 'bg-red-50 text-red-700 border-red-200', color: '#dc2626', help: 'Sin ninguna salida y supera el plazo de alerta' },
  'Problema de información': { cls: 'bg-violet-50 text-violet-700 border-violet-200', color: '#7c3aed', help: 'Ingreso sin peso o salida registrada antes del ingreso' },
}

export const TIPO_LABEL: Record<AptTipoLote, string> = { CONTRATO: 'Contrato', SUBCONTRATO: 'Subcontrato', ERROR: 'Error de contrato' }

export const CLASE_SALIDA_LABEL: Record<string, string> = {
  ASIGNADA: 'Despacho de lo ingresado',
  EXCEDE_INGRESO: 'Excede lo ingresado (stock anterior)',
  OTRO_PRODUCTO_DEL_LOTE: 'Otro producto del lote (no ingresó por APT)',
  LOTE_SIN_INGRESO: 'Lote sin ingreso en el periodo',
  SIN_NUMREL: 'Salida sin NumRel',
}
