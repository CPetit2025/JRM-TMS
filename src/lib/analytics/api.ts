import { createClient } from '@/lib/supabase/client'
import { aptApi } from '@/lib/apt/api'
import type { AptCapa, AptFilters } from '@/lib/apt/types'
import { fleetApi } from '@/lib/fleet/api'
import { aggregate, allPages, filterRows, type AnalysisRow, type Dataset, type Filters, type Metric, type Perspective } from './model'

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const array = (v: unknown) => Array.isArray(v) ? v.map(object) : []
const relation = (v: unknown) => Array.isArray(v) ? object(v[0]) : object(v)
const text = (v: unknown) => v == null ? '' : String(v)
const number = (v: unknown): number | null => v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v)
const date = (v: unknown) => {
  if (!v) return ''
  const d = new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) : ''
}
const baseRow = (r: Record<string, unknown>): AnalysisRow => ({
  id: text(r.id), code: text(r.dispatch_number || r.plate || r.code), date: '', status: text(r.status), client: '', contract: '',
  plate: text(r.vehicle_plate || r.plate), driver: text(r.driver_name || r.driver_id), route: '', site: text(r.site_id), values: {}, detail: {},
})

export function transportRow(r: Record<string, unknown>): AnalysisRow {
  const requests = array(r.dispatch_requests).map(x => relation(x.transport_requests))
  const contracts = [...new Set(requests.map(x => text(relation(x.contracts).code)).filter(Boolean))]
  const clients = [...new Set(requests.map(x => text(relation(relation(x.contracts).clients).business_name)).filter(Boolean))]
  const routes = [...new Set(requests.map(x => [text(x.pickup_address), text(x.delivery_address)].filter(Boolean).join(' → ')).filter(Boolean))]
  const incident = array(r.dispatch_events).some(x => ['INCIDENCIA', 'RETRASO', 'DESVIO'].includes(text(x.event_type)))
  return { ...baseRow(r), date: date(r.scheduled_departure), client: clients.join(' · '), contract: contracts.join(' · '), route: routes.join(' · '),
    clients, contracts, routes, values: { requests: requests.length, incident: incident ? 1 : 0 },
    detail: { 'Despacho': text(r.dispatch_number), 'Salida programada': text(r.scheduled_departure), 'Estado': text(r.status),
      'Cliente(s)': clients.join(' · '), 'Contrato(s)': contracts.join(' · '), 'Ruta(s)': routes.join(' · '),
      'Solicitudes vinculadas': requests.length, 'Incidencia registrada': incident ? 'Sí' : 'No' }, href: '/despacho' }
}

export async function loadDataset(p: Perspective, f: Filters): Promise<Dataset> {
  const supabase = createClient()
  const start = `${f.from}T00:00:00-05:00`
  const end = `${f.to}T23:59:59.999999-05:00`
  if (p === 'transporte') {
    const data = await allPages<Record<string, unknown>>((offset, size) => supabase.from('dispatches')
      .select('id, dispatch_number, driver_name, vehicle_plate, status, scheduled_departure, dispatch_requests(transport_requests(pickup_address,delivery_address,contracts(code,clients(business_name)))),dispatch_events(event_type)', { count: 'exact' })
      .gte('scheduled_departure', start).lte('scheduled_departure', end).order('scheduled_departure').order('id').range(offset, offset + size - 1))
    const rows = data.map(transportRow)
    return { source: 'dispatches · dispatch_requests · dispatch_events', basis: 'Salida programada (Lima)', rows, metrics: aggregate(p, rows), note: 'Solo despachos con salida programada en el rango. Las incidencias reflejan eventos registrados del viaje, incluso posteriores a esa salida.' }
  }
  if (p === 'costos') {
    const data = await allPages<Record<string, unknown>>((offset, size) => supabase.from('vw_trip_profitability').select('*', { count: 'exact' })
      .gte('departure_at', start).lte('departure_at', end).order('departure_at').order('dispatch_id').range(offset, offset + size - 1))
    // Catálogos visibles bajo RLS: códigos legibles, sin usar una clave de servicio.
    const [contracts, sites, drivers] = await Promise.all([
      allPages<Record<string, unknown>>((o, n) => supabase.from('contracts').select('id,code', { count: 'exact' }).order('id').range(o, o + n - 1)),
      allPages<Record<string, unknown>>((o, n) => supabase.from('sites').select('id,name', { count: 'exact' }).order('id').range(o, o + n - 1)),
      allPages<Record<string, unknown>>((o, n) => supabase.from('drivers').select('id,first_name,last_name', { count: 'exact' }).order('id').range(o, o + n - 1)),
    ])
    const labels = (items: Record<string, unknown>[], key: string) => new Map(items.map(x => [text(x.id), text(x[key])]))
    const codes = labels(contracts, 'code'), siteNames = labels(sites, 'name')
    const people = new Map(drivers.map(x => [text(x.id), `${text(x.first_name)} ${text(x.last_name)}`.trim()]))
    const rows = data.map(r => {
      const income = (number(r.freight) ?? 0) + (number(r.billable) ?? 0), expenses = number(r.expenses) ?? 0
      const km = number(r.km)
      return { ...baseRow(r), id: text(r.dispatch_id), date: date(r.departure_at), contract: codes.get(text(r.contract_id)) || text(r.contract_id),
        site: siteNames.get(text(r.site_id)) || text(r.site_id), driver: people.get(text(r.driver_id)) || text(r.driver_id),
        values: { income, expenses, margin: income - expenses, km: km && km > 0 ? km : null },
        detail: { 'Flete': number(r.freight), 'Refacturable': number(r.billable), 'Gastos aprobados': expenses, 'Margen': income - expenses,
          'Km registrados': km && km > 0 ? km : null, 'Liquidación': text(r.settlement_status || 'Abierta'), 'Salida real': text(r.departure_at) }, href: '/caja/liquidaciones' }
    })
    return { source: 'vw_trip_profitability (gastos aprobados)', basis: 'Salida real (Lima)', rows, metrics: aggregate(p, rows), note: 'Margen operativo de los viajes, no utilidad neta. Los viajes sin kilómetros no entran en el costo por km.' }
  }
  if (p === 'mantenimiento') {
    const { data, error } = await supabase.rpc('get_cmms_kpis', { p_start: f.from, p_end: f.to, p_plates: f.plate ? [f.plate] : null })
    if (error) throw Error(error.message)
    if (!data) throw Error('Mantenimiento no devolvió resultados.')
    const d = object(data), costs = object(d.costs)
    const metric = (key: string, label: string, value: unknown, unit: string, formula: string, direction?: 'up' | 'down'): Metric => ({ key, label, value: number(value), unit, formula, direction })
    const rows = array(d.per_vehicle).map(r => ({ ...baseRow(r), id: text(r.plate), date: f.to,
      values: { availability: number(r.availability_pct), failures: number(r.failures), cost: number(r.cost), km: number(r.km), downtime: number(r.downtime_hours) },
      detail: { 'Tipo': text(r.type), 'Disponibilidad %': number(r.availability_pct), 'Horas fuera de servicio': number(r.downtime_hours),
        'Fallas': number(r.failures), 'MTBF (h)': number(r.mtbf_hours), 'Costo': number(r.cost), 'Km': number(r.km), 'Costo/km': number(r.cost_per_km) },
      href: `/mantenimiento/flota/${encodeURIComponent(text(r.plate))}` }))
    return { source: 'get_cmms_kpis', basis: 'Eventos e intervalos del rango (Lima)', rows, metrics: [
      metric('availability', 'Disponibilidad', d.availability_pct, '%', '1 − horas fuera de servicio / (unidades × horas del rango); intervalos fusionados.', 'up'),
      metric('mtbf', 'MTBF', d.mtbf_hours, 'h', 'Horas disponibles de la flota / fallas reportadas en el rango.', 'up'),
      metric('mttr', 'MTTR', d.mttr_hours, 'h', 'Promedio de indisponibilidad de OT correctivas o de emergencia cerradas en el rango.', 'down'),
      metric('preventive', 'Participación preventiva', d.preventive_pct, '%', 'OT preventivas cerradas / OT preventivas, correctivas y de emergencia cerradas × 100.', 'up'),
      metric('tco', 'Costo total del período', costs.total, 'S/', 'Libro de costos de las unidades visibles en el rango.'),
    ], note: 'Estado de cada unidad: fotografía actual. Disponibilidad y costos: rango elegido. Una placa sin datos no se sustituye por la flota completa.' }
  }
  if (p === 'apt') {
    const filters: AptFilters = { ingreso_desde: f.from, ingreso_hasta: f.to, cliente: f.client || undefined,
      contrato: f.contract || undefined, lote: f.lot || undefined, familias: f.family ? [f.family] : undefined }
    const dashboard = await aptApi.dashboard(filters, 'dia')
    const layers: AptCapa[] = []
    for (let offset = 0; ; offset += 500) {
      const page = await aptApi.detail<AptCapa>(filters, 'capa', 'fecha_ingreso', false, 500, offset)
      layers.push(...page.rows)
      if (layers.length >= page.total) break
      if (!page.rows.length) throw Error('El detalle APT está incompleto. Reintente la consulta.')
    }
    const k = dashboard.kpis
    const rows = layers.map(r => ({ ...baseRow({ id: r.id }), code: r.lote, date: r.fecha_ingreso, status: r.estado, client: '', contract: r.numrel_op || '',
      values: { tn_in: r.tn_in, tn_out: r.tn_out, tn_saldo: r.tn_saldo, days: r.dias_saldo },
      detail: { 'Lote': r.lote, 'Producto': r.producto, 'Familia': r.familia, 'Ingreso': r.fecha_ingreso,
        'Toneladas ingresadas': r.tn_in, 'Toneladas despachadas': r.tn_out, 'Toneladas saldo': r.tn_saldo, 'Días con saldo': r.dias_saldo,
        'Problema de información': r.problema_info ? 'Sí' : 'No' }, href: `/apt/lote/${encodeURIComponent(r.lote)}?f=${encodeURIComponent(JSON.stringify(filters))}` }))
    return { source: 'apt_dashboard · apt_detail (FIFO)', basis: 'Cohorte por fecha de ingreso', rows, cutoff: dashboard.cutoff, metrics: [
      { key: 'tn_in', label: 'Toneladas ingresadas', value: k.tn_ingresadas, unit: 't', formula: 'Toneladas de capas con ingreso en el rango elegido.' },
      { key: 'tn_out', label: 'Toneladas despachadas', value: k.tn_despachadas, unit: 't', formula: 'Salidas FIFO asignadas a las capas de ingreso seleccionadas hasta el corte de datos.' },
      { key: 'balance', label: 'Saldo de la cohorte', value: k.tn_saldo, unit: 't', formula: 'Ingresos − salidas asignadas, según fecha de corte; no es saldo histórico al fin del rango.' },
      { key: 'aging', label: 'Estadía ponderada', value: k.aging_pond, unit: 'días', formula: 'Toneladas-día / toneladas con saldo, según el corte.', direction: 'down' },
      { key: 'critical', label: 'Lotes críticos', value: k.lotes_criticos, unit: '', formula: 'Lotes con saldo que superan el umbral de estadía configurado.', direction: 'down' },
    ], note: 'Fechas filtran ingresos. Las salidas y el saldo llegan hasta el corte de la fuente, incluso si es posterior al fin del rango. Cliente, contrato y lote siguen la búsqueda del modelo APT.' }
  }
  if (p === 'eficiencia') {
    const d = await fleetApi.resumen({ desde: `${f.from.slice(0, 7)}-01`, hasta: `${f.to.slice(0, 7)}-01` })
    const rows: AnalysisRow[] = [...d.transporte.map(r => ({ ...baseRow({ id: r.code, code: r.code, plate: r.code }), date: f.to, status: r.rec,
      values: { km: r.km, cost_km: r.costo_km_total, cost_tkm: r.costo_tkm_total },
      detail: { 'Activo': r.nombre, 'Grupo': r.grupo, 'Costo total/km': r.costo_km_total, 'Costo total/t·km': r.costo_tkm_total,
        'Confianza': r.confianza, 'Recomendación': r.rec, 'Motivos': r.motivos.join(' · '), 'Km registrados': r.km }, href: `/eficiencia-flota/transporte?d=${f.from.slice(0, 7)}&h=${f.to.slice(0, 7)}` })),
      ...d.equipos.map(r => ({ ...baseRow({ id: r.code, code: r.code, plate: r.code }), date: f.to, status: r.rec,
        values: { cost_hour: r.costo_propio_hora }, detail: { 'Activo': r.nombre, 'Grupo': r.grupo, 'Costo propio/hora': r.costo_propio_hora,
          'Horas por año': r.horas_anio, 'Recomendación': r.rec, 'Motivos': r.motivos.join(' · ') }, href: `/eficiencia-flota/equipos?d=${f.from.slice(0, 7)}&h=${f.to.slice(0, 7)}` }))]
    return { source: 'fe_resumen (modelo económico existente)', basis: 'Meses completos del modelo de flota', rows, metrics: [],
      note: `Modelo mensual: ${d.desde} a ${d.hasta}. Costos normalizados y anualizados según sus parámetros; no equivalen a gastos contables. Fuente de combustible hasta ${d.corte.combustible || 'sin dato'}.` }
  }
  throw Error('Perspectiva no disponible.')
}
export function filteredDataset(p: Perspective, data: Dataset, f: Filters): Dataset {
  if (p === 'apt' || p === 'mantenimiento') return data
  const rows = filterRows(data.rows, f)
  return { ...data, rows, metrics: p === 'eficiencia' ? [
    { key: 'assets', label: 'Activos analizados', value: rows.length, unit: '', formula: 'Activos del modelo que cumplen los filtros.' },
    { key: 'km', label: 'Km registrados', value: rows.some(r => r.values.km != null) ? rows.reduce((n, r) => n + (r.values.km ?? 0), 0) : null, unit: 'km', formula: 'Kilómetros registrados de unidades de transporte; equipos con horómetro no aportan km.' },
  ] : aggregate(p, rows) }
}
