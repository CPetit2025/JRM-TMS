// Control de Jornada de Transporte: tipos y cálculos compartidos por la tabla de jornadas, el detalle y el reporte
// mensual (docs/control-jornada-plan.md). Los datos vienen de unit_daily_report / fleet_workdays.
import { formatKm } from '@/lib/odometer'

export type Stop = { request_id?: string; sequence: number; status: string; request_number: string; type: string; ot: string | null; client: string | null; reference_supplier: string | null; origin: string | null; destination: string | null
  km_leg: number | null; km_source: 'GPS_COMPLETO' | 'ODOMETRO' | 'GPS_PARCIAL' | 'SIN_DATO' | null; odo_reading: number | null; odo_photo: string | null; odo_flag: string | null; guide: string | null; kg: number | null; kg_source: 'APT' | 'DECLARADO' | null; ref_type: 'OS' | 'OC' | 'RQ' | null; ref_number: string | null }
export type Dispatch = { id?: string; dispatch_number: string; status: string; driver: string | null; modalidad: string | null; departure: string; km_gps: number | null; km_real_source: 'GPS' | 'ODOMETRO' | null
  km_real: number | null; km_est: number | null; cost_total: number; cost_applied: number; cost_pending: number
  costs?: Array<{ kind: string; amount_pen: number; basis: string; status: string; request_number: string | null; ot: string | null; expense_type: string | null; fuel_gallons: number | null; fuel_odometer: number | null; estimated: boolean }>; stops: Stop[] }
export type Reading = { kind: 'INICIO' | 'CIERRE'; odometer: number; at: string; photo: string; flag: string | null }
export type Day = { date: string; drivers: string[] | null; checklists: number; operative: boolean | null; odo_start: number | null; odo_end: number | null
  end_source: 'CIERRE' | 'SIGUIENTE_INICIO' | null; km_odo: number | null; km_gps: number | null; km_real: number | null; km_est: number | null; routes: number; services: number; ots: number; clients: number
  cost_total: number; cost_applied: number; cost_pending: number; tn: number | null; tn_apt: number | null; readings: Reading[]; dispatches: Dispatch[]; alerts: string[] }
export type Report = { success: boolean; error?: string; plate: string; type: string | null; current_odometer: number | null; from: string; to: string
  totals: { days_active: number; routes: number; services: number; ots: number; km_odo: number; km_gps: number; km_real: number; km_est: number; cost_total: number; cost_applied: number; cost_pending: number; days_with_odo: number; tn: number; tn_apt: number; checklists: number }
  days: Day[] }

export const ALERTS: Record<string, { label: string; tone: string }> = {
  SIN_CHECKLIST: { label: 'Ruta sin checklist', tone: 'bg-red-100 text-red-800' },
  SIN_ODOMETRO: { label: 'Sin odómetro', tone: 'bg-amber-100 text-amber-800' },
  SIN_CIERRE: { label: 'Sin cierre', tone: 'bg-blue-100 text-blue-800' },
  KM_SIN_RUTA: { label: 'Km sin ruta', tone: 'bg-orange-100 text-orange-800' },
  GPS_INCOMPLETO: { label: 'GPS incompleto', tone: 'bg-amber-100 text-amber-800' },
  ODOMETRO_RETROCEDE: { label: 'Odómetro retrocede', tone: 'bg-red-100 text-red-800' },
  ODOMETRO_SALTO: { label: 'Salto de odómetro', tone: 'bg-red-100 text-red-800' },
}
export const iso = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
export const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: 'short' })
export const fmtTime = (d: string) => new Date(d).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })
export const tn = (v: number | null | undefined) => v == null ? '—' : `${Number(v).toLocaleString('es-PE', { maximumFractionDigits: 2 })} t`
export const TYPE: Record<string, string> = { DESPACHO: 'Entrega', RECOJO: 'Recojo', TRASLADO: 'Traslado' }
export const num = (v: number | null | undefined) => v == null ? null : Number(v)

// El odómetro se concilia por jornada; no debe confundirse con los km atribuibles a una ruta.
export type KmSource = 'GPS' | 'REAL' | 'ESTIMADO'
export const KM_SOURCE: Record<KmSource, string> = { GPS: 'GPS', REAL: 'Real de ruta', ESTIMADO: 'Estimado' }
export function bestKm(d: Day): { km: number; source: KmSource } | null {
  const options: Array<[number | null, KmSource]> = [[num(d.km_real), 'REAL'], [num(d.km_gps), 'GPS'], [num(d.km_est), 'ESTIMADO']]
  const hit = options.find(([km]) => km != null && km > 0)
  return hit ? { km: hit[0]!, source: hit[1] } : null
}

export type View = 'DIA' | 'SEMANA' | 'MES'
export const addDays = (d: string, n: number) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }
export const weekStart = (d: string) => addDays(d, -((new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7))
export const MONTH = new Intl.DateTimeFormat('es-PE', { month: 'long', year: 'numeric', timeZone: 'UTC' })
export const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', timeZone: 'UTC' })

export type Period = { key: string; label: string; from: string; to: string; days: number; km: number; bySource: Partial<Record<KmSource, number>>; daysNoKm: number
  routes: number; services: number; tn: number; ot: Set<string>; os: Set<string>; oc: Set<string>; rq: Set<string> }
export type Ref = { kind: 'OT' | 'OS' | 'OC' | 'RQ'; number: string; clients: Set<string>; ots: Set<string>; services: number; routes: Set<string>; first: string; last: string; kg: number; km: number; cost: number }

export function summarize(days: Day[], view: Exclude<View, 'DIA'>) {
  const periods = new Map<string, Period>()
  for (const d of days) {
    const key = view === 'MES' ? d.date.slice(0, 7) : weekStart(d.date)
    let p = periods.get(key)
    if (!p) {
      const label = view === 'MES' ? MONTH.format(new Date(`${key}-01T12:00:00Z`)) : `Semana del ${shortDate(key)} al ${shortDate(addDays(key, 6))}`
      p = { key, label: label.charAt(0).toUpperCase() + label.slice(1), from: d.date, to: d.date, days: 0, km: 0, bySource: {}, daysNoKm: 0, routes: 0, services: 0, tn: 0,
        ot: new Set(), os: new Set(), oc: new Set(), rq: new Set() }
      periods.set(key, p)
    }
    p.to = d.date
    const km = bestKm(d)
    if (d.routes || d.checklists || d.readings.length) { p.days += 1; if (!km) p.daysNoKm += 1 }
    if (km) { p.km += km.km; p.bySource[km.source] = (p.bySource[km.source] || 0) + km.km }
    p.routes += d.routes; p.services += d.services; p.tn += Number(d.tn || 0)
    for (const x of d.dispatches) for (const s of x.stops) {
      if (s.ot) p.ot.add(s.ot)
      if (s.ref_type && s.ref_number) ({ OS: p.os, OC: p.oc, RQ: p.rq })[s.ref_type]?.add(s.ref_number)
    }
  }
  return [...periods.values()]
}

export function references(days: Day[]) {
  const refs = new Map<string, Ref>()
  const touch = (kind: Ref['kind'], number: string, d: Day, x: Dispatch, s: Stop) => {
    const key = `${kind}:${number}`
    let r = refs.get(key)
    if (!r) { r = { kind, number, clients: new Set(), ots: new Set(), services: 0, routes: new Set(), first: d.date, last: d.date, kg: 0, km: 0, cost: 0 }; refs.set(key, r) }
    if (s.client) r.clients.add(s.client)
    if (kind !== 'OT' && s.ot) r.ots.add(s.ot)
    r.services += 1; r.routes.add(x.dispatch_number); r.last = d.date; r.kg += Number(s.kg || 0); r.km += Number(s.km_leg || 0)
    r.cost += (x.costs || []).filter(c => c.request_number === s.request_number && c.status !== 'ANULADO').reduce((sum, c) => sum + Number(c.amount_pen || 0), 0)
  }
  for (const d of days) for (const x of d.dispatches) for (const s of x.stops) {
    if (s.ot) touch('OT', s.ot, d, x, s)
    if (s.ref_type && s.ref_number) touch(s.ref_type, s.ref_number, d, x, s)
  }
  const order = { OT: 0, OS: 1, OC: 2, RQ: 3 }
  return [...refs.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.number.localeCompare(b.number, 'es', { numeric: true }))
}
// OT, OC, OS y RQ atendidas en el día (de los servicios de sus rutas)
export function dayRefs(d: Day) {
  const r = { OT: new Set<string>(), OC: new Set<string>(), OS: new Set<string>(), RQ: new Set<string>() }
  for (const x of d.dispatches) for (const s of x.stops) { if (s.ot) r.OT.add(s.ot); if (s.ref_type && s.ref_number) r[s.ref_type]?.add(s.ref_number) }
  return r
}
// Ahorro por consolidación (consolidation_savings, el mismo de Control presupuestal): solo servicios aprovechados valorizados
export type Saving = { value: number; marginal: number; saving: number }
export type SavingRow = { dispatch_number: string; state: string; standalone_pen: number | null; marginal_pen: number | null; saving_pen: number | null }
export function savingsByRoute(rows: SavingRow[]) {
  const m = new Map<string, Saving>()
  for (const r of rows) if (r.state === 'VALORIZADO') {
    const x = m.get(r.dispatch_number) || { value: 0, marginal: 0, saving: 0 }
    x.value += Number(r.standalone_pen || 0); x.marginal += Number(r.marginal_pen || 0); x.saving += Number(r.saving_pen || 0)
    m.set(r.dispatch_number, x)
  }
  return m
}
export const daySaving = (d: Day, m: Map<string, Saving> | null) => !m ? null : d.dispatches.reduce<Saving | null>((acc, x) => {
  const v = m.get(x.dispatch_number); if (!v) return acc
  return { value: (acc?.value || 0) + v.value, marginal: (acc?.marginal || 0) + v.marginal, saving: (acc?.saving || 0) + v.saving }
}, null)
export const soles = (v: number | null | undefined) => v == null ? '—' : Number(v).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const sourceText = (p: Period) => (Object.entries(p.bySource) as Array<[KmSource, number]>).filter(([, km]) => km > 0)
  .map(([s, km]) => `${KM_SOURCE[s]} ${formatKm(Math.round(km * 10) / 10)}`).join(' · ')


// ---- Control de Jornada (fleet_workdays) ----
export type JornadaStatus = 'SIN_OPERACION' | 'ABIERTA' | 'EN_REVISION' | 'CERRADA'
export const STATUS: Record<JornadaStatus, { label: string; tone: string; row: string }> = {
  CERRADA: { label: 'Cerrada', tone: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200', row: '' },
  ABIERTA: { label: 'Abierta', tone: 'bg-blue-100 text-blue-800 ring-1 ring-blue-200', row: '' },
  EN_REVISION: { label: 'En revisión', tone: 'bg-amber-100 text-amber-900 ring-1 ring-amber-200', row: '' },
  SIN_OPERACION: { label: 'Sin operación', tone: 'bg-slate-100 text-slate-600', row: 'text-slate-400' },
}
export type Incident = { source: 'EVENTO' | 'RECHAZO' | 'UNIDAD'; id: string; type: string; at: string; detail: string | null; dispatch_number: string | null }
export type DaySaving = { value: number; marginal: number; saving: number; valued: number; pending: number }
export type JornadaRow = Day & { plate: string; unit_type: string | null; status: JornadaStatus | null
  refs: { OT: string[]; OC: string[]; OS: string[]; RQ: string[] }; incidents: Incident[]; saving: DaySaving | null }
export type FleetUnit = { plate: string; type: string | null; status: string | null; current_odometer: number | null
  maintenance: Array<{ kind: 'SOLICITUD' | 'PLAN'; detail: string; at?: string; due_date?: string; due_km?: number }> }
export type Fleet = { success: boolean; error?: string; savings_available: boolean; units: FleetUnit[]; rows: JornadaRow[] }

/** Filtros y orden de la tabla: la misma regla para la tabla y para «anterior / siguiente» del detalle */
export type JornadaFilters = { conductor: string; unidad: string; estado: string; q: string; orden: string }
export const filtersFrom = (p: URLSearchParams): JornadaFilters => ({ conductor: p.get('conductor') || '', unidad: p.get('unidad') || p.get('plate') || '',
  estado: p.get('estado') || '', q: (p.get('q') || '').toLowerCase(), orden: p.get('orden') || 'fecha:desc' })
const SORTS: Record<string, (r: JornadaRow) => number | string> = {
  fecha: r => r.date, km: r => Number(r.km_odo ?? -1), carga: r => Number(r.tn ?? -1), costo: r => Number(r.saving?.marginal ?? -1),
  ahorro: r => Number(r.saving?.saving ?? -1e12), conductor: r => (r.drivers || [])[0] || '', gps: r => Number(r.km_gps ?? -1), rutas: r => r.routes,
  apt: r => Number(r.tn_apt ?? -1), estado: r => ['ABIERTA', 'EN_REVISION', 'CERRADA', 'SIN_OPERACION'].indexOf(r.status || 'SIN_OPERACION'),
}
export function applyFilters(rows: JornadaRow[], f: JornadaFilters) {
  // Sin operación solo con una unidad elegida o si se pide ese estado (con toda la flota sería ruido)
  const list = rows.filter(r => (r.status !== 'SIN_OPERACION' || f.unidad || f.estado === 'SIN_OPERACION')
    && (!f.unidad || r.plate === f.unidad) && (!f.estado || r.status === f.estado)
    && (!f.conductor || (r.drivers || []).includes(f.conductor))
    && (!f.q || [r.plate, ...(r.drivers || []), ...r.refs.OT, ...r.refs.OC, ...r.refs.OS, ...r.refs.RQ].join(' ').toLowerCase().includes(f.q)))
  const [key, dir] = f.orden.split(':'); const get = SORTS[key] || SORTS.fecha; const sign = dir === 'asc' ? 1 : -1
  return list.sort((a, b) => { const x = get(a), y = get(b); return (x < y ? -1 : x > y ? 1 : 0) * sign || a.plate.localeCompare(b.plate) })
}
/** Alertas de la columna Estado: las de fleet_workdays más checklist con observaciones, fin inferido e incidencias.
 *  «Sin cierre» con la jornada abierta ya lo dice el estado. El resultado del checklist no es el cierre de la jornada. */
export function rowAlerts(r: JornadaRow) {
  const out = r.alerts.filter(a => !(a === 'SIN_CIERRE' && r.status === 'ABIERTA')).map(a => ({ key: a, label: ALERTS[a]?.label || a }))
  if (r.operative === false) out.push({ key: 'CHECKLIST_OBS', label: 'Checklist con observaciones' })
  if (r.end_source === 'SIGUIENTE_INICIO') out.push({ key: 'FIN_INFERIDO', label: 'Odómetro fin inferido (inicio del día siguiente)' })
  if (r.incidents.length) out.push({ key: 'INCIDENCIAS', label: `${r.incidents.length} incidencia(s)` })
  return out
}
export const jornadaKey = (r: { plate: string; date: string }) => `${r.plate}/${r.date}`
/** Una unidad en períodos mayores a 3 meses: el reporte por unidad (sin estado ni ahorro) */
export const fromUnitReport = (plate: string, type: string | null, days: Day[]): JornadaRow[] => days.map(d => {
  const r = dayRefs(d)
  return { ...d, plate, unit_type: type, status: null, refs: { OT: [...r.OT], OC: [...r.OC], OS: [...r.OS], RQ: [...r.RQ] }, incidents: [], saving: null }
})

// ---- Reporte mensual de flota (Vista 3): todo sale de las mismas filas que la tabla ----
export type UnitMonthStatus = 'CERRADA' | 'EN_PROCESO' | 'CON_INCIDENCIAS' | 'SIN_OPERACION'
export type UnitMonth = { plate: string; type: string | null; driver: string | null; routes: number; km_odo: number; km_gps: number; tn: number; tn_apt: number
  cost: number; saving: number; savingValued: boolean; jornadas: number; closed: number; incidents: number; status: UnitMonthStatus; maintenance: number }
export type MonthWeek = { label: string; from: string; to: string; routes: number; tn: number }
const sumOf = <T,>(xs: T[], get: (x: T) => number | null | undefined) => xs.reduce((s, x) => s + Number(get(x) || 0), 0)
const r2 = (v: number) => Math.round(v * 100) / 100

/** Semanas de lunes a domingo recortadas al mes: la suma de las semanas es el total del mes */
export function monthWeeks(month: string): MonthWeek[] {
  const first = `${month}-01`, next = new Date(`${first}T12:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1)
  const last = addDays(next.toISOString().slice(0, 10), -1), out: MonthWeek[] = []
  for (let from = first, i = 1; from <= last; i++) {
    const to = [addDays(from, 6 - ((new Date(`${from}T12:00:00Z`).getUTCDay() + 6) % 7)), last].sort()[0]
    out.push({ label: `Sem. ${i}`, from, to, routes: 0, tn: 0 }); from = addDays(to, 1)
  }
  return out
}

export function monthlySummary(fleet: Fleet, month: string) {
  const rows = fleet.rows.filter(r => r.date.startsWith(month))
  const active = rows.filter(r => r.status !== 'SIN_OPERACION')
  const weeks = monthWeeks(month)
  for (const r of active) { const w = weeks.find(x => r.date >= x.from && r.date <= x.to); if (w) { w.routes += r.routes; w.tn = r2(w.tn + Number(r.tn || 0)) } }
  // Incidencias: cada una una vez por su registro de origen
  const incidentKeys = new Set(rows.flatMap(r => r.incidents.map(i => `${i.source}:${i.id}`)))
  const units: UnitMonth[] = fleet.units.map(u => {
    const ur = active.filter(r => r.plate === u.plate)
    const drivers = new Map<string, number>(); for (const r of ur) for (const d of r.drivers || []) drivers.set(d, (drivers.get(d) || 0) + 1)
    const incidents = new Set(ur.flatMap(r => r.incidents.map(i => `${i.source}:${i.id}`))).size
    const closed = ur.filter(r => r.status === 'CERRADA').length
    // Estado del mes (D3): con incidencias > en proceso (abiertas o en revisión) > cerrada
    const status: UnitMonthStatus = !ur.length ? 'SIN_OPERACION' : incidents ? 'CON_INCIDENCIAS' : closed < ur.length ? 'EN_PROCESO' : 'CERRADA'
    return { plate: u.plate, type: u.type, driver: [...drivers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      routes: sumOf(ur, r => r.routes), km_odo: r2(sumOf(ur, r => r.km_odo)), km_gps: r2(sumOf(ur, r => r.km_gps)), tn: r2(sumOf(ur, r => r.tn)), tn_apt: r2(sumOf(ur, r => r.tn_apt)),
      cost: r2(sumOf(ur, r => r.cost_total)), saving: r2(sumOf(ur, r => r.saving?.valued ? r.saving.saving : 0)), savingValued: ur.some(r => r.saving?.valued),
      jornadas: ur.length, closed, incidents, status, maintenance: u.maintenance.length }
  })
  // Conductor con más actividad: rutas que manejó (y sus km por ruta)
  const byDriver = new Map<string, { routes: number; km: number }>()
  for (const r of active) for (const x of r.dispatches) if (x.driver) {
    const d = byDriver.get(x.driver) || { routes: 0, km: 0 }; d.routes += 1; d.km += Number(x.km_real ?? x.km_gps ?? 0); byDriver.set(x.driver, d)
  }
  const alerts = new Map<string, Array<{ plate: string; date: string }>>()
  for (const r of active) for (const a of r.alerts) alerts.set(a, [...(alerts.get(a) || []), { plate: r.plate, date: r.date }])
  const operating = units.filter(u => u.jornadas)
  return {
    rows, weeks, units, operating,
    totals: { activeUnits: operating.length, availableUnits: fleet.units.filter(u => u.status !== 'FUERA_DE_SERVICIO').length,
      routes: sumOf(active, r => r.routes), km_odo: r2(sumOf(active, r => r.km_odo)), km_gps: r2(sumOf(active, r => r.km_gps)), tn: r2(sumOf(active, r => r.tn)),
      tn_apt: r2(sumOf(active, r => r.tn_apt)), cost: r2(sumOf(active, r => r.cost_total)), saving: r2(sumOf(active, r => r.saving?.valued ? r.saving.saving : 0)),
      savingPending: sumOf(active, r => r.saving?.pending), incidents: incidentKeys.size, jornadas: active.length, closed: active.filter(r => r.status === 'CERRADA').length },
    topKm: [...operating].sort((a, b) => b.km_odo - a.km_odo)[0] || null,
    topDriver: [...byDriver.entries()].sort((a, b) => b[1].routes - a[1].routes)[0] || null,
    alerts: [...alerts.entries()].sort((a, b) => b[1].length - a[1].length),
  }
}
