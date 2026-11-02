export type TrackingMode = 'DIA' | 'SEMANA' | 'MES'
export type TrackingRange = { from: string; to: string }

const dayDate = (value: string) => new Date(`${value}T12:00:00Z`)
const isoDay = (value: Date) => value.toISOString().slice(0, 10)
const shiftDay = (value: string, count: number) => {
  const next = dayDate(value)
  next.setUTCDate(next.getUTCDate() + count)
  return isoDay(next)
}

export function trackingRange(mode: TrackingMode, anchor: string): TrackingRange {
  if (mode === 'DIA') return { from: anchor, to: anchor }
  if (mode === 'SEMANA') {
    const mondayOffset = (dayDate(anchor).getUTCDay() + 6) % 7
    const from = shiftDay(anchor, -mondayOffset)
    return { from, to: shiftDay(from, 6) }
  }
  const [year, month] = anchor.slice(0, 7).split('-').map(Number)
  return { from: `${anchor.slice(0, 7)}-01`, to: isoDay(new Date(Date.UTC(year, month, 0, 12))) }
}

export type ReportStop = {
  request_number: string; sequence?: number; status?: string; type?: string; ot?: string | null; ref_type?: string | null; ref_number?: string | null
  reference_supplier?: string | null; client?: string | null; origin?: string | null; destination?: string | null
  km_leg?: number | null; km_source?: string | null; odo_reading?: number | null; odo_photo?: string | null
  odo_flag?: string | null; guide?: string | null; kg?: number | null
}
export type ReportRoute = {
  dispatch_number: string; status: string; driver: string | null; modalidad: string | null; departure: string
  closed_at?: string | null; km_gps: number | null; km_real?: number | null; km_real_source?: string | null
  km_est?: number | null; odo_start?: number | null; odo_end?: number | null; odo_end_photo?: string | null
  cost_total?: number; cost_applied?: number; cost_pending?: number
  costs?: Array<{ kind: string; amount_pen: number; status: string; request_number?: string | null; ot?: string | null; fuel_gallons?: number | null }>
  stops: DashboardStop[]
}
export type ReportReading = { kind: string; odometer: number; at: string; photo: string | null; flag?: string | null }
export type ReportDay = {
  date: string; drivers: string[] | null; checklists: number; operative: boolean | null
  odo_start: number | null; odo_end: number | null; km_odo: number | null; km_gps: number | null
  routes: number; services: number; tn: number | null; readings: ReportReading[]; dispatches: ReportRoute[]; alerts: string[]
}
export type UnitReport = { plate: string; days: ReportDay[] }
export type PortalStop = {
  dispatch_id: string; dispatch_number: string; request_id: string; request_number: string; scheduled_departure: string
  sequence_order?: number | null
  state: string; dispatch_status?: string; driver_name: string | null; plate: string; modalidad?: string | null
  ot_code?: string | null; reference_type?: string | null; reference_number?: string | null; purchase_order?: string | null
  supplier_name?: string | null; client_name: string | null; pickup_address: string; delivery_address: string
  guide_number: string | null; conformity?: string | null; request_type?: string | null
  documents?: Array<{ id: string; type: 'GUIA_REMISION' | 'PACKING_LIST'; number: string | null; name: string | null }>
  signed_photos?: number; packing_photos?: number
}
export type DashboardStop = ReportStop & { portal?: PortalStop }
export type DashboardRoute = ReportRoute & {
  key: string; day: string; plate: string; portalStops: PortalStop[]; reportStops: DashboardStop[]
  reportDay?: ReportDay; driverName: string
}
export type DriverDay = {
  key: string; date: string; driver: string; routes: DashboardRoute[]; reportDays: Map<string, { plate: string; day: ReportDay }>
  checklists: number; operative: boolean | null; alerts: Set<string>; stops: DashboardStop[]
  serviceCount: number; ots: string[]; weightTn: number | null; kmOdo: number | null; kmGps: number | null
  odometerLabel: string; costsApplied: number; costsPending: number
}
export type DashboardTotals = {
  dispatches: number; routes: number; services: number; kmOdo: number; delivered: number; inProgress: number
}
export type DashboardResult = { groups: DriverDay[]; totals: DashboardTotals }

const finalStates = new Set(['ENTREGADO', 'LIQUIDADO', 'CERRADO', 'COMPLETADO'])
const canceledStates = new Set(['CANCELADO', 'ANULADO', 'ANULADA'])
const movingStates = new Set(['EN RUTA', 'EN_CURSO', 'EN_DESTINO', 'RETORNO', 'RETORNO_COMPLETADO', 'ESPERANDO_AUTORIZACION'])
const clean = (value: string | null | undefined) => (value || '').trim()
const routeKey = (date: string, number: string) => `${date}/${number}`
const groupKey = (date: string, driver: string) => `${date}/${driver.toLocaleLowerCase('es-PE')}`
const number = (value: number | null | undefined) => value == null || !Number.isFinite(Number(value)) ? null : Number(value)
const serviceStatus = (stop: DashboardStop) => {
  const state = (stop.portal?.state || stop.status || '').toUpperCase()
  const routeState = (stop.portal?.dispatch_status || '').toUpperCase()
  if (canceledStates.has(state) || canceledStates.has(routeState)) return 'CANCELADO'
  if (finalStates.has(state)) return 'ENTREGADO'
  if (movingStates.has(state) || movingStates.has(routeState) || ['EN RUTA', 'EN_CURSO', 'EN_DESTINO'].includes(routeState)) return 'EN_PROCESO'
  return 'PROGRAMADO'
}

function stopsFor(route: DashboardRoute): DashboardStop[] {
  const map = new Map<string, DashboardStop>()
  for (const stop of route.reportStops) map.set(stop.request_number, { ...stop, sequence: stop.sequence })
  for (const portal of route.portalStops) {
    const current = map.get(portal.request_number)
    if (current) current.portal = portal
    else map.set(portal.request_number, {
      request_number: portal.request_number, status: portal.state, type: portal.request_type || undefined, ot: portal.ot_code,
      ref_type: portal.reference_type, ref_number: portal.reference_number || portal.purchase_order, client: portal.client_name,
      origin: portal.pickup_address, destination: portal.delivery_address, guide: portal.guide_number, portal,
    })
  }
  return [...map.values()].sort((a, b) => Number(a.portal?.sequence_order || 0) - Number(b.portal?.sequence_order || 0))
}

export function buildDispatchDashboard(
  portalRows: PortalStop[], reports: UnitReport[], range: TrackingRange,
): DashboardResult {
  const groups = new Map<string, DriverDay>()
  const routes = new Map<string, DashboardRoute>()
  const reportDayByPlate = new Map<string, { plate: string; day: ReportDay }>()
  const inRange = (date: string) => date >= range.from && date <= range.to
  const getGroup = (date: string, driverValue: string | null | undefined) => {
    const driver = clean(driverValue) || 'Conductor por asignar'
    const key = groupKey(date, driver)
    let group = groups.get(key)
    if (!group) {
      group = { key, date, driver, routes: [], reportDays: new Map(), checklists: 0, operative: null, alerts: new Set(), stops: [], serviceCount: 0,
        ots: [], weightTn: null, kmOdo: null, kmGps: null, odometerLabel: '—', costsApplied: 0, costsPending: 0 }
      groups.set(key, group)
    }
    return group
  }
  const getRoute = (date: string, dispatchNumber: string, defaults: Partial<DashboardRoute> = {}) => {
    const key = routeKey(date, dispatchNumber)
    let route = routes.get(key)
    if (!route) {
      route = { key, day: date, plate: '', dispatch_number: dispatchNumber, status: 'PROGRAMADO', driver: null, driverName: '', modalidad: null,
        departure: '', closed_at: null, km_gps: null, km_real: null, km_est: null, km_real_source: null, odo_start: null, odo_end: null,
        odo_end_photo: null, cost_total: 0, cost_applied: 0, cost_pending: 0, costs: [], stops: [], portalStops: [], reportStops: [], ...defaults }
      routes.set(key, route)
    } else Object.assign(route, Object.fromEntries(Object.entries(defaults).filter(([, value]) => value !== undefined && value !== null)))
    return route
  }

  for (const report of reports) for (const day of report.days || []) {
    if (!inRange(day.date)) continue
    const dayKey = `${day.date}/${report.plate}`
    reportDayByPlate.set(dayKey, { plate: report.plate, day })
    const dailyRoutes = day.dispatches || []
    if (!dailyRoutes.length && Number(day.checklists || 0) > 0) {
      const names = day.drivers?.length ? day.drivers : ['Conductor no identificado']
      for (const driver of names) {
        const group = getGroup(day.date, driver)
        group.reportDays.set(dayKey, { plate: report.plate, day })
        group.checklists += Number(day.checklists || 0)
        group.operative = day.operative
        for (const alert of day.alerts || []) group.alerts.add(alert)
      }
    }
    for (const source of dailyRoutes) {
      const driver = clean(source.driver) || 'Conductor por asignar'
      const group = getGroup(day.date, driver)
      const route = getRoute(day.date, source.dispatch_number, {
        ...source, day: day.date, plate: report.plate, reportDay: day, driverName: driver,
        portalStops: [], reportStops: (source.stops || []) as DashboardStop[],
      })
      route.reportDay = day
      route.plate = report.plate
      route.driverName = driver
      route.reportStops = source.stops || route.reportStops
      group.routes.push(route)
      group.reportDays.set(dayKey, { plate: report.plate, day })
      group.checklists = Math.max(group.checklists, Number(day.checklists || 0))
      group.operative = day.operative
      for (const alert of day.alerts || []) group.alerts.add(alert)
    }
  }

  for (const portal of portalRows) {
    const date = portal.scheduled_departure.slice(0, 10)
    if (!inRange(date) || !portal.dispatch_number) continue
    const route = getRoute(date, portal.dispatch_number, {
      day: date, driverName: clean(portal.driver_name) || 'Conductor por asignar', plate: portal.plate || '',
      status: portal.dispatch_status || portal.state, driver: portal.driver_name, modalidad: portal.modalidad || null,
      departure: portal.scheduled_departure, portalStops: [], reportStops: [],
    })
    if (!route.portalStops.some(stop => stop.request_id === portal.request_id)) route.portalStops.push(portal)
    const chosenDriver = route.driverName || clean(portal.driver_name) || 'Conductor por asignar'
    route.driverName = chosenDriver
    route.plate ||= portal.plate || ''
    const group = getGroup(date, chosenDriver)
    if (!group.routes.some(item => item.key === route.key)) group.routes.push(route)
  }

  const groupList = [...groups.values()]
  const plateDayOwners = new Map<string, Set<string>>()
  for (const group of groupList) for (const key of group.reportDays.keys()) {
    plateDayOwners.set(key, new Set([...(plateDayOwners.get(key) || []), group.key]))
  }
  const serviceStatusById = new Map<string, { status: string; date: string }>()
  const routeKeys = new Set<string>()
  for (const group of groupList) {
    const uniqueRoutes = [...new Map(group.routes.map(route => [route.key, route])).values()]
    group.routes = uniqueRoutes.sort((a, b) => a.departure.localeCompare(b.departure))
    const stopMap = new Map<string, DashboardStop>()
    for (const route of group.routes) {
      route.stops = stopsFor(route)
      routeKeys.add(route.key)
      for (const stop of route.stops) {
        const id = stop.portal?.request_id || stop.request_number
        const prior = stopMap.get(id)
        if (!prior) stopMap.set(id, stop)
        const status = serviceStatus(stop), scheduled = stop.portal?.scheduled_departure || route.departure
        const current = serviceStatusById.get(id)
        if (!current || scheduled >= current.date) serviceStatusById.set(id, { status, date: scheduled })
        if (stop.ot && !['SIN OT VINCULADA', '—'].includes(stop.ot.toUpperCase())) group.ots.push(stop.ot)
      }
    }
    group.stops = [...stopMap.values()]
    group.serviceCount = group.stops.length
    group.costsApplied = [...new Map(group.routes.map(route => [route.key, route])).values()].reduce((sum, route) => sum + (number(route.cost_applied) || 0), 0)
    group.costsPending = [...new Map(group.routes.map(route => [route.key, route])).values()].reduce((sum, route) => sum + (number(route.cost_pending) || 0), 0)
    const weights = group.stops.map(stop => number(stop.kg)).filter((kg): kg is number => kg != null)
    group.weightTn = weights.length ? weights.reduce((sum, kg) => sum + kg, 0) / 1000 : null
    group.ots = [...new Set(group.ots)].sort((a, b) => a.localeCompare(b, 'es', { numeric: true }))
    group.kmGps = group.routes.some(route => route.km_gps != null)
      ? group.routes.reduce((sum, route) => sum + (number(route.km_gps) || 0), 0) : null

    const routeOdoKm = group.routes.reduce((sum, route) => {
      if (route.km_real_source === 'ODOMETRO' && number(route.km_real) != null) return sum + Number(route.km_real)
      const legs = route.stops.filter(stop => stop.km_source === 'ODOMETRO').reduce((km, stop) => km + (number(stop.km_leg) || 0), 0)
      return sum + legs
    }, 0)
    const dailyOdoKm = [...group.reportDays.entries()].reduce((sum, [key, entry]) =>
      plateDayOwners.get(key)?.size === 1 ? sum + (number(entry.day.km_odo) || 0) : sum, 0)
    group.kmOdo = dailyOdoKm > 0 ? dailyOdoKm : routeOdoKm > 0 ? routeOdoKm : null
    const odoLines = group.routes.map(route => {
      const start = number(route.odo_start), end = number(route.odo_end)
      if (start != null || end != null) return `${route.plate || 'Unidad'} ${start == null ? '—' : start.toLocaleString('es-PE')} → ${end == null ? '—' : end.toLocaleString('es-PE')}`
      return ''
    }).filter(Boolean)
    if (!odoLines.length) for (const { plate, day } of group.reportDays.values()) {
      if (day.odo_start != null || day.odo_end != null) odoLines.push(`${plate} ${day.odo_start == null ? '—' : Number(day.odo_start).toLocaleString('es-PE')} → ${day.odo_end == null ? '—' : Number(day.odo_end).toLocaleString('es-PE')}`)
    }
    group.odometerLabel = [...new Set(odoLines)].join(' · ') || '—'

    for (const route of group.routes) for (const stop of route.stops) {
      const isComplete = ['ENTREGADO', 'LIQUIDADO', 'CERRADO', 'COMPLETADO'].includes((stop.status || '').toUpperCase())
      if (route.modalidad !== 'TERCERO' && isComplete && (!stop.odo_photo || stop.odo_reading == null)) group.alerts.add('EVIDENCIA_INCOMPLETA')
      if (stop.km_source === 'GPS_PARCIAL') group.alerts.add('GPS_PARCIAL')
      if (stop.odo_flag) group.alerts.add(stop.odo_flag === 'SALTO' ? 'ODOMETRO_SALTO' : stop.odo_flag)
    }
  }

  const delivered = [...serviceStatusById.values()].filter(item => item.status === 'ENTREGADO').length
  const inProgress = [...serviceStatusById.values()].filter(item => !['ENTREGADO', 'CANCELADO'].includes(item.status)).length
  const kmSeen = new Set<string>()
  let kmOdo = 0
  for (const report of reports) for (const day of report.days || []) if (inRange(day.date)) {
    const key = `${report.plate}/${day.date}`
    if (kmSeen.has(key)) continue
    kmSeen.add(key)
    kmOdo += number(day.km_odo) || 0
  }
  const scheduledServices = new Set<string>()
  for (const group of groupList) for (const stop of group.stops) scheduledServices.add(stop.portal?.request_id || stop.request_number)
  return {
    groups: groupList.sort((a, b) => b.date.localeCompare(a.date) || a.driver.localeCompare(b.driver, 'es')),
    totals: { dispatches: routeKeys.size, routes: new Set([...routeKeys].map(key => key.split('/').at(-1))).size,
      services: scheduledServices.size, kmOdo, delivered, inProgress },
  }
}
