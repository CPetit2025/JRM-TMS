export type Perspective = 'resumen' | 'transporte' | 'costos' | 'mantenimiento' | 'apt' | 'eficiencia' | 'desempeno'
export type Comparison = 'none' | 'previous' | 'year'
export interface Filters {
  from: string; to: string; compare: Comparison; client: string; contract: string; plate: string
  driver: string; status: string; route: string; site: string; lot: string; family: string; search: string; incident: string
}
export interface AnalysisRow {
  id: string; code: string; date: string; status: string; client: string; contract: string; plate: string
  driver: string; route: string; site: string; clients?: string[]; contracts?: string[]; routes?: string[]
  values: Record<string, number | null>; detail: Record<string, string | number | null>; href?: string
}
export interface Metric { key: string; label: string; value: number | null; unit: string; formula: string; direction?: 'up' | 'down' }
export interface Dataset { source: string; basis: string; rows: AnalysisRow[]; metrics: Metric[]; note?: string; cutoff?: string | null }
export const PERSPECTIVES: Array<{ id: Perspective; label: string; permissions: string[] }> = [
  { id: 'resumen', label: 'Resumen SCM', permissions: ['despacho', 'monitoreo', 'torre-control', 'reportes', 'caja', 'mantenimiento-dashboard', 'apt', 'flota-eficiencia'] },
  { id: 'transporte', label: 'Transporte', permissions: ['despacho', 'monitoreo', 'torre-control', 'reportes'] },
  { id: 'costos', label: 'Costos y contratos', permissions: ['caja'] },
  { id: 'mantenimiento', label: 'Mantenimiento', permissions: ['mantenimiento-dashboard'] },
  { id: 'apt', label: 'Almacenes y APT', permissions: ['apt'] },
  { id: 'eficiencia', label: 'Eficiencia de activos', permissions: ['flota-eficiencia'] },
  { id: 'desempeno', label: 'Desempeño e informes', permissions: ['dashboard'] },
]
export const emptyDimensions = { client: '', contract: '', plate: '', driver: '', status: '', route: '', site: '', lot: '', family: '', search: '', incident: '' }
export function limaToday(now = new Date()): string { return now.toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) }
export function defaults(now = new Date()): Filters {
  const to = limaToday(now)
  return { ...emptyDimensions, from: `${to.slice(0, 7)}-01`, to, compare: 'previous' }
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
export function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && isoDay(d) === s
}
export function validateRange(f: Pick<Filters, 'from' | 'to'>): string | null {
  if (!validDate(f.from) || !validDate(f.to)) return 'Seleccione fechas válidas.'
  return f.from > f.to ? 'La fecha inicial no puede ser posterior a la final.' : null
}
export function comparisonRange(f: Pick<Filters, 'from' | 'to' | 'compare'>): { from: string; to: string } | null {
  if (validateRange(f) || f.compare === 'none') return null
  if (f.compare === 'year') {
    const previousYear = (s: string) => {
      const [y, m, d] = s.split('-').map(Number)
      const last = new Date(Date.UTC(y - 1, m, 0)).getUTCDate()
      return isoDay(new Date(Date.UTC(y - 1, m - 1, Math.min(d, last))))
    }
    return { from: previousYear(f.from), to: previousYear(f.to) }
  }
  const start = new Date(`${f.from}T00:00:00Z`); const end = new Date(`${f.to}T00:00:00Z`)
  const days = (end.getTime() - start.getTime()) / 86400000 + 1
  return { from: isoDay(new Date(start.getTime() - days * 86400000)), to: isoDay(new Date(start.getTime() - 86400000)) }
}
export function presetRange(preset: string, now = new Date()): Pick<Filters, 'from' | 'to'> {
  const to = limaToday(now); const date = new Date(`${to}T00:00:00Z`)
  if (preset === 'today') return { from: to, to }
  if (preset === 'week') date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  else if (preset === 'quarter') date.setUTCMonth(Math.floor(date.getUTCMonth() / 3) * 3, 1)
  else date.setUTCDate(1)
  return { from: isoDay(date), to }
}
export function parseFilters(raw: string | null, now = new Date()): Filters {
  const base = defaults(now)
  if (!raw) return base
  try {
    const obj = JSON.parse(raw)
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return base
    for (const key of Object.keys(base) as Array<keyof Filters>) {
      if (typeof obj[key] === 'string') base[key] = obj[key].slice(0, 200) as never
    }
    if (!['none', 'previous', 'year'].includes(base.compare)) base.compare = 'previous'
    return validateRange(base) ? defaults(now) : base
  } catch { return base }
}
export function applies(p: Perspective): Array<keyof Filters> {
  if (p === 'transporte') return ['client', 'contract', 'plate', 'driver', 'status', 'route', 'incident', 'search']
  if (p === 'costos') return ['contract', 'plate', 'driver', 'status', 'site', 'search']
  if (p === 'mantenimiento') return ['plate']
  if (p === 'eficiencia') return ['plate', 'search']
  if (p === 'apt') return ['client', 'contract', 'lot', 'family']
  return []
}
export function forPerspective(f: Filters, p: Perspective): Filters {
  const out = { ...f, ...emptyDimensions }
  for (const key of applies(p)) out[key] = f[key] as never
  return out
}
export function filterRows(rows: AnalysisRow[], f: Filters): AnalysisRow[] {
  const text = f.search.trim().toLocaleLowerCase('es')
  return rows.filter(r => (!f.client || r.client === f.client || (r.clients || [r.client]).includes(f.client))
    && (!f.contract || (r.contracts || [r.contract]).includes(f.contract))
    && (!f.route || (r.routes || [r.route]).includes(f.route))
    && (!f.plate || r.plate === f.plate) && (!f.driver || r.driver === f.driver)
    && (f.incident !== 'only' || r.values.incident === 1)
    && (!f.status || r.status === f.status) && (!f.site || r.site === f.site)
    && (!text || [r.code, r.client, r.contract, r.plate, r.driver, r.route, r.status, ...Object.values(r.detail)]
      .join(' ').toLocaleLowerCase('es').includes(text)))
}
export function ratio(n: number, d: number): number | null { return d > 0 ? n / d * 100 : null }
export function sum(rows: AnalysisRow[], key: string): number { return rows.reduce((n, r) => n + (r.values[key] ?? 0), 0) }
export function aggregate(p: Perspective, rows: AnalysisRow[]): Metric[] {
  if (p === 'transporte') {
    const completed = rows.filter(r => ['ENTREGADO', 'LIQUIDADO', 'CERRADO', 'RETORNO_COMPLETADO'].includes(r.status)).length
    return [
      { key: 'trips', label: 'Despachos', value: rows.length, unit: '', formula: 'Despachos únicos con salida programada en el período.' },
      { key: 'completed', label: 'Completados', value: completed, unit: '', formula: 'Despachos en ENTREGADO, LIQUIDADO, CERRADO o RETORNO_COMPLETADO.' },
      { key: 'completed_pct', label: 'Avance operativo', value: ratio(completed, rows.length), unit: '%', formula: 'Completados / despachos del período × 100. No mide puntualidad ni OTIF.', direction: 'up' },
      { key: 'incidents', label: 'Con incidencias', value: sum(rows, 'incident'), unit: '', formula: 'Despachos con eventos INCIDENCIA, RETRASO o DESVIO; cada despacho cuenta una vez.', direction: 'down' },
    ]
  }
  if (p === 'costos') {
    const income = sum(rows, 'income'), expenses = sum(rows, 'expenses'), km = sum(rows, 'km')
    return [
      { key: 'income', label: 'Flete + refacturable', value: income, unit: 'S/', formula: 'Suma de flete y gastos refacturables aprobados.' },
      { key: 'expenses', label: 'Gastos aprobados', value: expenses, unit: 'S/', formula: 'Suma de gastos aprobados de los viajes con salida real en el período.' },
      { key: 'margin', label: 'Margen operativo', value: income - expenses, unit: 'S/', formula: 'Flete + refacturable − gastos aprobados. No equivale a utilidad neta.', direction: 'up' },
      { key: 'margin_pct', label: 'Margen sobre ingresos', value: ratio(income - expenses, income), unit: '%', formula: '(Ingresos − gastos) / ingresos × 100; sin ingresos queda sin dato.', direction: 'up' },
      { key: 'cost_km', label: 'Costo por km con registro', value: km > 0 ? rows.filter(r => (r.values.km ?? 0) > 0).reduce((n, r) => n + (r.values.expenses ?? 0), 0) / km : null, unit: 'S/km', formula: 'Gastos de viajes con km positivos / km de esos viajes. Excluye viajes sin km.', direction: 'down' },
    ]
  }
  return []
}
export function formatValue(value: number | null, unit = ''): string {
  if (value === null || !Number.isFinite(value)) return 'Sin datos'
  const number = value.toLocaleString('es-PE', { maximumFractionDigits: unit ? 2 : 0 })
  return unit === 'S/' ? `S/ ${number}` : `${number}${unit ? ` ${unit}` : ''}`
}
export function groups(rows: AnalysisRow[], by: 'date' | 'status' | 'plate' | 'client', grain: 'day' | 'week' | 'month', metric = 'count') {
  const counts = new Map<string, number>()
  for (const row of rows) {
    let label = row[by] || 'Sin dato'
    if (by === 'date' && validDate(label)) {
      if (grain === 'month') label = label.slice(0, 7)
      if (grain === 'week') { const d = new Date(`${label}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); label = isoDay(d) }
    }
    const amount = metric === 'count' ? 1 : row.values[metric]
    if (amount != null) counts.set(label, (counts.get(label) || 0) + amount)
  }
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([label, count]) => ({ label, count }))
}
export async function allPages<T>(fetchPage: (offset: number, size: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null; count?: number | null }>, size = 500): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += size) {
    const { data, error, count } = await fetchPage(offset, size)
    if (error) throw Error(error.message)
    if (!data) throw Error('La fuente no devolvió registros. Reintente la consulta.')
    rows.push(...data)
    if (data.length < size) {
      if (count != null && rows.length < count) throw Error('La fuente limitó el resultado. No se mostrarán totales parciales.')
      return rows
    }
  }
}
