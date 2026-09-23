import type { SupabaseClient } from '@supabase/supabase-js'

export const toolAccess = {
  get_pending_dispatches: { scope: 'distribucion', modules: ['despacho', 'torre-control'] },
  get_contract_status: { scope: 'contratos', modules: ['ot', 'clientes', 'contratos-servicios'] },
  get_transport_costs: { scope: 'distribucion', modules: ['despacho', 'caja'] },
  get_inventory_alerts: { scope: 'inventarios', modules: ['mantenimiento-ot'] },
  get_fleet_status: { scope: 'mantenimiento', modules: ['flota', 'mantenimiento-flota'] },
  get_maintenance_alerts: { scope: 'mantenimiento', modules: ['mantenimiento-ot', 'mantenimiento-planes', 'mantenimiento-fallas'] },
  get_delivery_incidents: { scope: 'distribucion', modules: ['despacho', 'torre-control'] },
  get_operational_kpis: { scope: 'gerencia', modules: ['dashboard', 'operaciones-kpis'] },
  prepare_maintenance_action: { scope: 'mantenimiento', modules: ['mantenimiento-ot'] },
} as const

export type AiToolName = keyof typeof toolAccess
type ToolContext = { contractId?: string; dispatchId?: string; vehiclePlate?: string }

const daySchema = {
  type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 90 } },
  required: ['days'], additionalProperties: false,
} as const
const emptySchema = { type: 'object', properties: {}, required: [], additionalProperties: false } as const

export const toolDefinitions = [
  { type: 'function', name: 'get_pending_dispatches', description: 'Despachos pendientes y retrasados durante un periodo de hasta 90 días.', strict: true, parameters: daySchema },
  { type: 'function', name: 'get_contract_status', description: 'Estado y presupuesto del contrato seleccionado o indicado. Usa contract_id null para el contrato de la pantalla; si no hay selección, devuelve una muestra de contratos activos con riesgo presupuestal.', strict: true,
    parameters: { type: 'object', properties: { contract_id: { type: ['string', 'null'] } }, required: ['contract_id'], additionalProperties: false } },
  { type: 'function', name: 'get_transport_costs', description: 'Costos de flete y consumo presupuestal por contrato en el periodo.', strict: true, parameters: daySchema },
  { type: 'function', name: 'get_inventory_alerts', description: 'Repuestos con stock crítico o sin movimiento en el kardex durante 90 días.', strict: true, parameters: emptySchema },
  { type: 'function', name: 'get_fleet_status', description: 'Disponibilidad de unidades y documentos próximos a vencer.', strict: true, parameters: emptySchema },
  { type: 'function', name: 'get_maintenance_alerts', description: 'Planes vencidos o próximos, fallas abiertas, unidades con varios reportes y órdenes pendientes.', strict: true, parameters: emptySchema },
  { type: 'function', name: 'get_delivery_incidents', description: 'Eventos operativos de incidencia, retraso y desvío durante un periodo.', strict: true, parameters: daySchema },
  { type: 'function', name: 'get_operational_kpis', description: 'Indicadores de despachos, costos y retrasos durante un periodo. No calcula tonelaje real sin datos de peso entregado.', strict: true, parameters: daySchema },
  { type: 'function', name: 'prepare_maintenance_action', description: 'Prepara una propuesta de mantenimiento cuando el usuario pide programarlo. Nunca la confirma ni ejecuta. Requiere unidad, tipo, motivo y fecha futura YYYY-MM-DD.', strict: true,
    parameters: { type: 'object', properties: {
      vehicle_plate: { type: 'string' }, type: { type: 'string', enum: ['CORRECTIVO', 'PREVENTIVO'] },
      reason: { type: 'string' }, scheduled_date: { type: 'string' },
    }, required: ['vehicle_plate', 'type', 'reason', 'scheduled_date'], additionalProperties: false } },
  { type: 'function', name: 'query_active_trip', description: 'Consulta el viaje activo, paradas, horario, unidad, contrato y tareas pendientes del conductor autenticado.', strict: true,
    parameters: emptySchema },
  { type: 'function', name: 'prepare_trip_action', description: 'Prepara una acción del viaje. Nunca la ejecuta automáticamente. Usa valores nulos cuando un dato no fue indicado y no lo inventes.', strict: true,
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['CONFIRM_START', 'CONFIRM_ARRIVAL', 'CONFIRM_LOADING', 'CONFIRM_UNLOADING', 'REPORT_DELAY', 'REPORT_INCIDENT', 'REPORT_FAILURE', 'REGISTER_EXPENSE', 'REQUEST_EVIDENCE', 'CONFIRM_DELIVERY', 'REQUEST_RETURN', 'FINISH_TRIP'] },
      description: { type: ['string', 'null'] },
      category: { type: ['string', 'null'] },
      amount: { type: ['number', 'null'] },
      severity: { type: ['string', 'null'], enum: ['BAJA', 'MEDIA', 'ALTA', 'CRITICA', null] },
      can_continue: { type: ['boolean', 'null'] },
    }, required: ['action', 'description', 'category', 'amount', 'severity', 'can_continue'], additionalProperties: false } },
] as const

function sinceDays(value: unknown) {
  const days = Math.max(1, Math.min(90, Number(value) || 7))
  return new Date(Date.now() - days * 86_400_000).toISOString()
}
function rows<T>(data: T[] | null, error: { message: string } | null): T[] {
  if (error) throw new Error('La consulta operacional no está disponible.')
  return data || []
}

export async function executeAiTool(
  name: AiToolName,
  args: Record<string, unknown>,
  supabase: SupabaseClient,
  siteIds: string[],
  context: ToolContext,
) {
  const asOf = new Date().toISOString()
  if (name === 'get_pending_dispatches') {
    const { data, error, count } = await supabase.from('dispatches')
      .select('id, dispatch_number, status, scheduled_departure, vehicle_plate, contract_id', { count: 'exact' })
      .in('site_id', siteIds).gte('scheduled_departure', sinceDays(args.days))
      .not('status', 'in', '("LIQUIDADO","ENTREGADO","CANCELADO")')
      .order('scheduled_departure', { ascending: true }).limit(50)
    const dispatches = rows(data, error)
    let selectedDispatch = null
    if (context.dispatchId && /^[0-9a-f-]{36}$/i.test(context.dispatchId)) {
      const selected = await supabase.from('dispatches')
        .select('id, dispatch_number, status, scheduled_departure, vehicle_plate, contract_id, freight_cost')
        .eq('id', context.dispatchId).in('site_id', siteIds).maybeSingle()
      if (selected.error) throw new Error('El despacho seleccionado no está disponible.')
      selectedDispatch = selected.data
    }
    return { asOf, pendingCount: count, sampleTruncated: (count || 0) > dispatches.length,
      selectedDispatch,
      pendingSample: dispatches.map(item => ({
      ...item, delayed: Boolean(item.scheduled_departure && new Date(item.scheduled_departure).getTime() < Date.now()
        && item.status === 'PROGRAMADO'), url: '/despacho',
    })) }
  }
  if (name === 'get_contract_status') {
    const contractRef = typeof args.contract_id === 'string' ? args.contract_id : context.contractId
    if (!contractRef) {
      const { data, error, count } = await supabase.from('contracts')
        .select('id, code, status, contract_budgets(concept, allocated_pen, reserved_pen, consumed_pen, balance_pen)', { count: 'exact' })
        .in('site_id', siteIds).eq('status', 'ACTIVO').order('code').limit(100)
      const contracts = rows(data, error)
      const risks = contracts.flatMap(contract =>
        (contract.contract_budgets || []).filter(budget =>
          Number(budget.balance_pen) <= 0 ||
          (Number(budget.allocated_pen) > 0 && Number(budget.balance_pen) / Number(budget.allocated_pen) < 0.1))
          .map(budget => ({ contractId: contract.id, code: contract.code, budget, url: '/contratos' })))
      return { asOf, activeContractsInScope: count, sampleTruncated: (count || 0) > contracts.length,
        budgetRiskCandidatesInSample: risks.slice(0, 40),
        note: 'Riesgo aproximado solo por saldo presupuestal; no hay hitos ni fechas de contrato estructurados en esta consulta.' }
    }
    if (contractRef.length > 100) return { asOf, error: 'Referencia de contrato inválida.' }
    const field = /^[0-9a-f-]{36}$/i.test(contractRef) ? 'id' : 'code'
    const { data, error } = await supabase.from('contracts')
      .select('id, code, type, status, total_weight_kg, contract_budgets(concept, allocated_pen, reserved_pen, consumed_pen, balance_pen)')
      .eq(field, contractRef).in('site_id', siteIds).maybeSingle()
    if (error) throw new Error('No se pudo consultar el contrato.')
    return { asOf, contract: data ? { ...data, url: '/contratos' } : null }
  }
  if (name === 'get_transport_costs') {
    const { data, error } = await supabase.rpc('ai_get_transport_costs', {
      p_site_ids: siteIds, p_since: sinceDays(args.days),
    })
    if (error || !data) throw new Error('Costos de transporte no disponibles.')
    const summary = data as { byContract?: Array<{ contract_id: string | null }> }
    const contractIds = (summary.byContract || []).map(item => item.contract_id).filter((id): id is string => Boolean(id))
    let budgets: Array<Record<string, unknown>> = []
    if (contractIds.length) {
      const result = await supabase.from('contract_budgets')
        .select('contract_id, allocated_pen, reserved_pen, consumed_pen, balance_pen')
        .in('contract_id', contractIds).limit(200)
      budgets = rows(result.data, result.error)
    }
    return { ...data, budgetsSample: budgets, budgetsSampleMayBeTruncated: budgets.length === 200,
      contractSampleTruncated: Number(data.contractCount || 0) > (summary.byContract?.length || 0),
      note: 'El total de fletes y el número de despachos son exactos; el detalle muestra los 30 contratos con mayor costo.' }
  }
  if (name === 'get_inventory_alerts') {
    const { data, error } = await supabase.rpc('ai_get_inventory_alerts', { p_site_ids: siteIds })
    if (error || !data) throw new Error('Alertas de inventario no disponibles.')
    return { ...data, sampleTruncated: Number(data.alertCount || 0) > (data.alertsSample?.length || 0),
      note: 'Los totales provienen del stock y kardex. Un repuesto puede aparecer en ambas alertas.',
      url: '/mantenimiento/inventario' }
  }
  if (name === 'get_fleet_status') {
    const { data, error, count } = await supabase.from('vehicles')
      .select('id, plate, status, weight_capacity, soat_expiration, technical_review_expiration', { count: 'exact' })
      .in('site_id', siteIds).limit(150)
    const fleet = rows(data, error)
    let selectedUnit = null
    if (context.vehiclePlate) {
      const selected = await supabase.from('vehicles')
        .select('id, plate, status, weight_capacity, soat_expiration, technical_review_expiration')
        .eq('plate', context.vehiclePlate).in('site_id', siteIds).maybeSingle()
      if (selected.error) throw new Error('La unidad seleccionada no está disponible.')
      selectedUnit = selected.data
    }
    const thirtyDaysOut = Date.now() + 30 * 86_400_000
    return { asOf, total: count, sampled: fleet.length, sampleTruncated: (count || 0) > fleet.length,
      selectedUnit,
      byStatusInSample: fleet.reduce<Record<string, number>>((map, item) => {
      const key = item.status || 'SIN_ESTADO'; map[key] = (map[key] || 0) + 1; return map
    }, {}), expiringDocumentsSample: fleet.filter(item =>
      [item.soat_expiration, item.technical_review_expiration].some(date =>
        date && new Date(date).getTime() <= thirtyDaysOut)).slice(0, 30),
      units: fleet.slice(0, 50).map(item => ({ ...item, url: `/mantenimiento/flota/${encodeURIComponent(item.plate)}` })) }
  }
  if (name === 'get_maintenance_alerts') {
    const [plansResult, vehiclesResult, failuresResult, ordersResult, recentResult] = await Promise.all([
      supabase.from('maintenance_plans').select('id, name, vehicle_type, frequency_days, frequency_km')
        .in('site_id', siteIds).eq('is_active', true).limit(100),
      supabase.from('vehicles').select('id, plate, type, current_mileage, last_maintenance_date, last_maintenance_mileage')
        .in('site_id', siteIds).limit(150),
      supabase.from('vehicle_failures').select('id, vehicle_id, description, criticality, status, report_date')
        .in('site_id', siteIds).in('status', ['ABIERTO', 'EN_REVISION', 'CON_OT']).limit(80),
      supabase.from('maintenance_work_orders').select('id, ot_code, vehicle_id, status, estimated_end_date')
        .in('site_id', siteIds).in('status', ['PENDIENTE', 'EN_PROCESO']).limit(80),
      supabase.from('vehicle_failures').select('vehicle_id', { count: 'exact' })
        .in('site_id', siteIds).gte('report_date', sinceDays(90)).limit(500),
    ])
    const plans = rows(plansResult.data, plansResult.error)
    const vehicles = rows(vehiclesResult.data, vehiclesResult.error)
    const recent = rows(recentResult.data, recentResult.error)
    const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]))
    const counts = recent.reduce<Record<string, number>>((map, item) => {
      if (item.vehicle_id) map[item.vehicle_id] = (map[item.vehicle_id] || 0) + 1
      return map
    }, {})
    const thirtyDaysOut = Date.now() + 30 * 86_400_000
    const dueEstimates = plans.flatMap(plan => vehicles.filter(vehicle => vehicle.type === plan.vehicle_type)
      .map(vehicle => {
        const lastDate = vehicle.last_maintenance_date ? new Date(vehicle.last_maintenance_date).getTime() : null
        const dueDate = lastDate !== null && Number.isFinite(lastDate) && Number(plan.frequency_days) > 0
          ? new Date(lastDate + Number(plan.frequency_days) * 86_400_000).toISOString().slice(0, 10) : null
        const dueKm = vehicle.last_maintenance_mileage !== null && Number(plan.frequency_km) > 0
          ? Number(vehicle.last_maintenance_mileage) + Number(plan.frequency_km) : null
        return { plan: plan.name, plate: vehicle.plate, dueDate, dueKm,
          overdue: Boolean((dueDate && new Date(dueDate).getTime() < Date.now()) ||
            (dueKm !== null && Number(vehicle.current_mileage) >= dueKm)) }
      }))
    return { asOf, samplesMayBeTruncated: plans.length === 100 ||
      vehicles.length === 150 ||
      (failuresResult.data?.length || 0) === 80 || (ordersResult.data?.length || 0) === 80 ||
      (recentResult.count || 0) > recent.length,
      overduePlansEstimate: dueEstimates.filter(item => item.overdue).slice(0, 40),
      plansDueWithin30DaysEstimate: dueEstimates.filter(item => item.dueDate && !item.overdue &&
        new Date(item.dueDate).getTime() <= thirtyDaysOut).slice(0, 40),
      unitsWithThreeOrMoreReportsIn90DaysInSample: Object.entries(counts)
        .filter(([, count]) => count >= 3).map(([vehicleId, count]) =>
          ({ vehiclePlate: vehicleById.get(vehicleId)?.plate || null, count })),
      openFailures: rows(failuresResult.data, failuresResult.error).slice(0, 40)
        .map(item => ({ ...item, vehicle_plate: vehicleById.get(item.vehicle_id)?.plate || null })),
      openOrders: rows(ordersResult.data, ordersResult.error).slice(0, 40)
        .map(item => ({ ...item, vehicle_plate: vehicleById.get(item.vehicle_id)?.plate || null })),
      note: 'Las fechas preventivas son estimaciones por tipo de unidad y última fecha general de mantenimiento.',
      url: '/mantenimiento' }
  }
  if (name === 'get_delivery_incidents') {
    const { data, error, count } = await supabase.from('dispatches')
      .select('id, dispatch_number, status, scheduled_departure, dispatch_events(event_type, description, created_at)', { count: 'exact' })
      .in('site_id', siteIds).gte('scheduled_departure', sinceDays(args.days)).limit(100)
    const dispatches = rows(data, error)
    return { asOf, dispatchesInWindow: count, sampleTruncated: (count || 0) > dispatches.length,
      incidentsSample: dispatches.flatMap(dispatch =>
      (dispatch.dispatch_events || []).filter((event: { event_type: string }) =>
        ['INCIDENCIA', 'RETRASO', 'DESVIO'].includes(event.event_type)).map((event: unknown) => ({
        dispatch: dispatch.dispatch_number, event, url: '/torre-control',
      }))).slice(0, 50) }
  }
  const { data, error } = await supabase.rpc('ai_get_operational_kpis', {
    p_site_ids: siteIds, p_since: sinceDays(args.days),
  })
  if (error) throw new Error('Indicadores no disponibles.')
  return { ...data, note: 'El peso efectivamente despachado no está estructurado en esta consulta.' }
}
