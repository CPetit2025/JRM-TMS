import type { SupabaseClient } from '@supabase/supabase-js'

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

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
  get_cmms_kpis: { scope: 'mantenimiento', modules: ['mantenimiento-dashboard', 'mantenimiento-flota', 'mantenimiento-ot'] },
  get_cmms_brief: { scope: 'mantenimiento', modules: ['mantenimiento-dashboard', 'mantenimiento-flota', 'mantenimiento-ot', 'mantenimiento-fallas'] },
  explain_unit_availability: { scope: 'mantenimiento', modules: ['mantenimiento-flota', 'mantenimiento-ot', 'despacho'] },
  get_transport_requests: { scope: 'contratos', modules: ['solicitudes', 'ot', 'despacho-aprobacion'] },
  quote_freight: { scope: 'contratos', modules: ['solicitudes', 'ot', 'tarifas', 'despacho'] },
  find_dispatch: { scope: 'distribucion', modules: ['despacho', 'torre-control', 'documentario', 'monitoreo'] },
  get_compliance_alerts: { scope: 'distribucion', modules: ['despacho', 'documentario', 'torre-control', 'flota', 'mantenimiento-flota'] },
  get_cash_status: { scope: 'caja', modules: ['caja', 'caja-aprobacion', 'caja-anticipos', 'caja-liquidaciones', 'caja-fondos'] },
  get_contract_expenses: { scope: 'contratos', modules: ['contratos-servicios', 'ot', 'clientes'] },
  prepare_office_action: { scope: 'contratos', modules: ['contratos-servicios', 'ot', 'clientes', 'solicitudes', 'despacho-aprobacion'] },
} as const

export type AiToolName = keyof typeof toolAccess
type ToolContext = { contractId?: string; dispatchId?: string; vehiclePlate?: string }
const UUID = /^[0-9a-f-]{36}$/i
// Código de OT sin comodines de ILIKE: búsqueda exacta sin distinguir mayúsculas
const literal = (value: string) => value.replace(/[%_\\]/g, char => `\\${char}`)

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
  { type: 'function', name: 'get_cmms_kpis', description: 'KPI de mantenimiento calculados con datos reales en los últimos N días: disponibilidad, MTBF, MTTR, backlog, preventivo vs correctivo, costo/km, costo/hora, costo de mantenimiento por unidad, neumáticos, TCO y fallas recurrentes, con detalle por unidad.', strict: true, parameters: daySchema },
  { type: 'function', name: 'get_cmms_brief', description: 'Situación actual del CMMS: unidades bloqueadas o no disponibles y sus motivos, mantenimientos que vencen, unidades más costosas (365 días), fallas recurrentes, repuestos bajo el mínimo, talleres con más retrabajos y anomalías detectadas (picos de costo, tendencia de fallas, neumáticos, documentos).', strict: true, parameters: emptySchema },
  { type: 'function', name: 'explain_unit_availability', description: 'Explica por qué una unidad está o no disponible según el motor de elegibilidad: motivos bloqueantes, observaciones y verificaciones (OT, fallas críticas, preventivos, documentos, viaje activo).', strict: true,
    parameters: { type: 'object', properties: { vehicle_plate: { type: 'string' } }, required: ['vehicle_plate'], additionalProperties: false } },
  { type: 'function', name: 'get_transport_requests', description: 'Solicitudes de transporte creadas en los últimos N días: conteo por estado, observadas por partida (con motivo), pendientes de aprobación, próximas a su fecha requerida y detalle con costo referencial. Filtros opcionales por estado exacto (p. ej. OBSERVADA, PENDIENTE DE APROBACIÓN, APROBADA) y por código de OT/contrato.', strict: true,
    parameters: { type: 'object', properties: {
      days: { type: 'integer', minimum: 1, maximum: 90 }, status: { type: ['string', 'null'] }, contract_code: { type: ['string', 'null'] },
    }, required: ['days', 'status', 'contract_code'], additionalProperties: false } },
  { type: 'function', name: 'quote_freight', description: 'Cotiza con el Tarifario de Transporte el costo referencial de un flete para una OT/contrato hacia un distrito (y opcionalmente peso y tipo de unidad). Devuelve desglose, total y tarifas faltantes. Usa contract_code null para la OT de la pantalla.', strict: true,
    parameters: { type: 'object', properties: {
      contract_code: { type: ['string', 'null'] }, district: { type: 'string' },
      weight_kg: { type: ['number', 'null'] }, vehicle_class: { type: ['string', 'null'] },
    }, required: ['contract_code', 'district', 'weight_kg', 'vehicle_class'], additionalProperties: false } },
  { type: 'function', name: 'find_dispatch', description: 'Busca un despacho por número (p. ej. DSP-000123) o placa y devuelve estado, conductor, paradas, últimos eventos, documentos cargados (guías, packing list) y estado de caja (anticipos, gastos, liquidación). Usa reference null para el despacho seleccionado en pantalla.', strict: true,
    parameters: { type: 'object', properties: { reference: { type: ['string', 'null'] } }, required: ['reference'], additionalProperties: false } },
  { type: 'function', name: 'get_compliance_alerts', description: 'Cumplimiento documentario: documentos de unidades vencidos o por vencer (SOAT, revisión técnica, etc.), licencias y documentos de conductores que vencen en 30 días y despachos abiertos sin guía de remisión cargada.', strict: true, parameters: emptySchema },
  { type: 'function', name: 'get_cash_status', description: 'Situación de Caja: saldos de cajas y fondos (bajo mínimo), gastos pendientes u observados por aprobar, anticipos esperando aprobación o vencidos sin rendir y viajes con liquidación atrasada.', strict: true, parameters: emptySchema },
  { type: 'function', name: 'get_contract_expenses', description: 'Lista los gastos registrados de una OT y de sus subcontratos y errores (montacargas, grúa, estiba, otros) con su id, tipo, monto, fecha, guía y estado. Úsalo antes de corregir el monto de un gasto.', strict: true,
    parameters: { type: 'object', properties: { contract_code: { type: 'string' } }, required: ['contract_code'], additionalProperties: false } },
  { type: 'function', name: 'prepare_office_action', description: 'Prepara (NO ejecuta) una acción de registro o edición para que el usuario la confirme: REGISTER_CONTRACT_EXPENSE (gasto de OT/subcontrato/error: contract_code, service_type MONTACARGA|GRUA|ESTIBA|MANIOBRA|PEAJE|PENALIDAD|ERROR|OTROS, amount, hours si es montacargas, service_date, provider_name, provider_ruc, referral_guide, description), UPDATE_EXPENSE_AMOUNT (expense_id de get_contract_expenses, amount), CREATE_CONTRACT (code, contract_type CONTRATO|OT_INDEPENDIENTE|SUBCONTRATO|ERROR, parent_code para subcontrato/error, client por razón social o RUC, budget, weight_tons, destination_district, destination_address), CHANGE_REQUEST_STATUS (request_number, new_status APROBADA|RECHAZADA|REPROGRAMADA|CANCELADA, required_date si reprograma). Usa null en lo que no se indicó; no inventes datos. Anular gastos no se hace desde aquí.', strict: true,
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['REGISTER_CONTRACT_EXPENSE', 'UPDATE_EXPENSE_AMOUNT', 'CREATE_CONTRACT', 'CHANGE_REQUEST_STATUS'] },
      contract_code: { type: ['string', 'null'] }, service_type: { type: ['string', 'null'] }, amount: { type: ['number', 'null'] },
      hours: { type: ['number', 'null'] }, service_date: { type: ['string', 'null'] }, provider_name: { type: ['string', 'null'] },
      provider_ruc: { type: ['string', 'null'] }, referral_guide: { type: ['string', 'null'] }, description: { type: ['string', 'null'] },
      expense_id: { type: ['string', 'null'] }, code: { type: ['string', 'null'] }, contract_type: { type: ['string', 'null'] },
      parent_code: { type: ['string', 'null'] }, client: { type: ['string', 'null'] }, budget: { type: ['number', 'null'] },
      weight_tons: { type: ['number', 'null'] }, destination_district: { type: ['string', 'null'] }, destination_address: { type: ['string', 'null'] },
      request_number: { type: ['string', 'null'] }, new_status: { type: ['string', 'null'] }, required_date: { type: ['string', 'null'] },
    }, required: ['action', 'contract_code', 'service_type', 'amount', 'hours', 'service_date', 'provider_name', 'provider_ruc', 'referral_guide',
      'description', 'expense_id', 'code', 'contract_type', 'parent_code', 'client', 'budget', 'weight_tons', 'destination_district',
      'destination_address', 'request_number', 'new_status', 'required_date'], additionalProperties: false } },
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
      .not('status', 'in', '("LIQUIDADO","CERRADO","ENTREGADO","CANCELADO")')
      .order('scheduled_departure', { ascending: true }).limit(50)
    const dispatches = rows(data, error)
    // Abiertos más antiguos que la ventana consultada (quedaron sin cerrar)
    const stale = await supabase.from('dispatches').select('id', { count: 'exact', head: true })
      .in('site_id', siteIds).lt('scheduled_departure', sinceDays(args.days))
      .not('status', 'in', '("LIQUIDADO","CERRADO","ENTREGADO","CANCELADO")')
    let selectedDispatch = null
    if (context.dispatchId && /^[0-9a-f-]{36}$/i.test(context.dispatchId)) {
      const selected = await supabase.from('dispatches')
        .select('id, dispatch_number, status, scheduled_departure, vehicle_plate, contract_id, freight_cost')
        .eq('id', context.dispatchId).in('site_id', siteIds).maybeSingle()
      if (selected.error) throw new Error('El despacho seleccionado no está disponible.')
      selectedDispatch = selected.data
    }
    return { asOf, pendingCount: count, sampleTruncated: (count || 0) > dispatches.length,
      openOlderThanWindow: stale.error ? null : stale.count,
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
    // Fuente real: proyecciones preventivas calculadas en BD (F5), backlog unificado (F3) y OT (F4)
    const [projectionsResult, failuresResult, ordersResult, recentResult] = await Promise.all([
      supabase.from('vw_maintenance_projections')
        .select('plan_id, vehicle_plate, plan_name, alert_status, due_driver, km_remaining, hours_remaining, days_remaining, projected_due_date, open_work_order_code')
        .in('site_id', siteIds).neq('alert_status', 'NORMAL').order('projected_days', { ascending: true }).limit(100),
      supabase.from('vw_maintenance_backlog').select('id, vehicle_plate, description, severity, status, reported_at, age_days')
        .in('site_id', siteIds).order('priority_score', { ascending: false }).limit(80),
      supabase.from('vw_work_orders').select('id, ot_code, vehicle_plate, status, order_type, estimated_end_date, downtime_hours')
        .in('site_id', siteIds).not('status', 'in', '(CERRADA,CANCELADA)').limit(80),
      supabase.from('maintenance_requests').select('vehicle_plate', { count: 'exact' })
        .in('site_id', siteIds).gte('reported_at', sinceDays(90)).limit(500),
    ])
    const projections = rows(projectionsResult.data, projectionsResult.error)
    const recent = rows(recentResult.data, recentResult.error)
    const counts = recent.reduce<Record<string, number>>((map, item) => {
      if (item.vehicle_plate) map[item.vehicle_plate] = (map[item.vehicle_plate] || 0) + 1
      return map
    }, {})
    return { asOf, samplesMayBeTruncated: projections.length === 100 ||
      (failuresResult.data?.length || 0) === 80 || (ordersResult.data?.length || 0) === 80 ||
      (recentResult.count || 0) > recent.length,
      overduePlans: projections.filter(item => item.alert_status === 'VENCIDO').slice(0, 40),
      plansDueSoon: projections.filter(item => item.alert_status !== 'VENCIDO').slice(0, 40),
      unitsWithThreeOrMoreReportsIn90DaysInSample: Object.entries(counts)
        .filter(([, count]) => count >= 3).map(([vehiclePlate, count]) => ({ vehiclePlate, count })),
      openFailures: rows(failuresResult.data, failuresResult.error).slice(0, 40),
      openOrders: rows(ordersResult.data, ordersResult.error).slice(0, 40),
      note: 'Vencimientos calculados en la base de datos por km, horómetro o fecha (lo primero que ocurra) con la lectura real de cada unidad.',
      url: '/mantenimiento/preventivos' }
  }
  if (name === 'get_cmms_kpis') {
    const days = Math.max(1, Math.min(365, Number(args.days) || 30))
    const end = new Date()
    const start = new Date(end.getTime() - (days - 1) * 86_400_000)
    const ymd = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
    const { data, error } = await supabase.rpc('get_cmms_kpis', { p_start: ymd(start), p_end: ymd(end), p_plates: null })
    if (error) throw new Error('KPI de mantenimiento no disponibles.')
    return { asOf, ...data, definitions: {
      availability_pct: '100 × (1 − horas fuera de servicio por OT (intervalos fusionados) / (unidades × horas del periodo))',
      mtbf_hours: '(horas disponibles del periodo) / fallas reportadas no descartadas',
      mttr_hours: 'promedio de horas fuera de servicio de las OT correctivas/emergencia cerradas en el periodo',
      cost_per_km: 'costos del libro por activo / km reales (lecturas de odómetro)' }, url: '/mantenimiento' }
  }
  if (name === 'get_cmms_brief') {
    const { data, error } = await supabase.rpc('get_cmms_copilot_brief', { p_plates: null })
    if (error) throw new Error('Resumen de mantenimiento no disponible.')
    return { asOf, ...data, url: '/mantenimiento/copiloto' }
  }
  if (name === 'explain_unit_availability') {
    const plate = String(args.vehicle_plate || context.vehiclePlate || '').trim().toUpperCase()
    if (!plate) return { error: 'Indique la placa de la unidad.' }
    const { data: vehicle } = await supabase.from('vehicles').select('plate, status, is_blocked, block_reason').eq('plate', plate).maybeSingle()
    if (!vehicle) return { error: `No encontré la unidad ${plate} en su alcance.` }
    const { data, error } = await supabase.rpc('check_asset_eligibility', { p_plate: plate, p_context: 'RELEASE' })
    if (error) throw new Error('Motor de elegibilidad no disponible.')
    return { asOf, vehicle, eligibility: data, url: `/mantenimiento/flota/${encodeURIComponent(plate)}` }
  }
  if (name === 'get_transport_requests') {
    let contractId: string | null = null
    const code = typeof args.contract_code === 'string' ? args.contract_code.trim().slice(0, 60) : ''
    if (code) {
      const found = await supabase.from('contracts').select('id').ilike('code', literal(code)).limit(1).maybeSingle()
      if (!found.data) return { asOf, error: `No encontré la OT ${code} en su alcance.` }
      contractId = found.data.id
    }
    let query = supabase.from('transport_requests').select('*, contracts(code, clients(business_name))', { count: 'exact' })
      .gte('created_at', sinceDays(args.days)).order('created_at', { ascending: false }).limit(300)
    if (typeof args.status === 'string' && args.status.trim()) query = query.eq('status', args.status.trim().toUpperCase())
    if (contractId) query = query.eq('contract_id', contractId)
    const { data, error, count } = await query
    const list = rows(data as Row[] | null, error)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
    const soon = new Date(Date.now() + 3 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
    const open = (r: Row) => !['COMPLETADA', 'CANCELADA', 'RECHAZADA', 'ENTREGADA', 'CERRADA'].includes(String(r.status))
    const brief = (r: Row) => ({
      request_number: r.request_number, status: r.status, required_date: r.required_date,
      delivery_district: r.delivery_district, contract: r.contracts?.code ?? null, client: r.contracts?.clients?.business_name ?? null,
      referential_freight_pen: Number(r.service_cost || 0), unloading_estimate_pen: Number(r.unloading_estimate_pen || 0),
      budget_observation: r.budget_observation ?? null, url: '/solicitudes',
    })
    return { asOf, totalInWindow: count, sampleTruncated: (count || 0) > list.length,
      byStatus: list.reduce<Record<string, number>>((map, r) => { const k = String(r.status || 'SIN_ESTADO'); map[k] = (map[k] || 0) + 1; return map }, {}),
      observed: list.filter(r => r.status === 'OBSERVADA').slice(0, 20).map(brief),
      awaitingApproval: list.filter(r => r.status === 'PENDIENTE DE APROBACIÓN').slice(0, 20).map(brief),
      overdueOrDueSoon: list.filter(r => open(r) && r.required_date && String(r.required_date) <= soon).slice(0, 20)
        .map(r => ({ ...brief(r), overdue: String(r.required_date) < today })),
      latest: list.slice(0, 15).map(brief),
      note: 'El costo de la solicitud es referencial (lo calcula el tarifario); el costo real del flete se fija al programar en Despacho.' }
  }
  if (name === 'quote_freight') {
    const code = typeof args.contract_code === 'string' ? args.contract_code.trim().slice(0, 60) : ''
    let contract: Row | null = null
    if (code) contract = (await supabase.from('contracts').select('id, code').ilike('code', literal(code)).limit(1).maybeSingle()).data
    else if (context.contractId && UUID.test(context.contractId)) contract = (await supabase.from('contracts').select('id, code').eq('id', context.contractId).maybeSingle()).data
    if (!contract) return { asOf, error: code ? `No encontré la OT ${code} en su alcance.` : 'Indique el código de la OT o contrato.' }
    const district = String(args.district || '').trim().slice(0, 80)
    if (!district) return { asOf, error: 'Indique el distrito de destino.' }
    const { data, error } = await supabase.rpc('quote_transport', {
      p_contract_id: contract.id, p_stops: [{ district }],
      p_weight_kg: typeof args.weight_kg === 'number' && args.weight_kg > 0 ? args.weight_kg : null,
      p_vehicle_class: typeof args.vehicle_class === 'string' && args.vehicle_class.trim() ? args.vehicle_class.trim() : null,
    })
    if (error) throw new Error('El tarifario no está disponible para su usuario.')
    return { asOf, contract: contract.code, district, quote: data, url: '/maestros/tarifas',
      note: 'Costo referencial según el tarifario vigente; no incluye ajustes del despacho real.' }
  }
  if (name === 'find_dispatch') {
    const raw = typeof args.reference === 'string' ? args.reference.trim() : ''
    let query = supabase.from('dispatches').select('*').in('site_id', siteIds).order('created_at', { ascending: false }).limit(5)
    if (raw) {
      if (UUID.test(raw)) query = query.eq('id', raw)
      else {
        const ref = raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 30)
        if (!ref) return { asOf, error: 'Indique el número de despacho o la placa.' }
        query = query.or(`dispatch_number.ilike.%${ref}%,vehicle_plate.ilike.%${ref}%`)
      }
    } else if (context.dispatchId && UUID.test(context.dispatchId)) query = query.eq('id', context.dispatchId)
    else return { asOf, error: 'Indique el número de despacho o la placa.' }
    const { data, error } = await query
    const found = rows(data as Row[] | null, error)
    if (!found.length) return { asOf, error: `No encontré despachos para "${raw}" en su alcance.` }
    const d = found[0]
    const safe = async <T,>(p: PromiseLike<{ data: T | null; error: unknown }>) => { try { const r = await p; return r.error ? null : r.data } catch { return null } }
    const [driver, events, docs, stops, cash] = await Promise.all([
      d.driver_id ? safe(supabase.from('drivers').select('first_name, last_name, phone').eq('id', d.driver_id).maybeSingle()) : null,
      safe(supabase.from('dispatch_events').select('event_type, description, created_at').eq('dispatch_id', d.id).order('created_at', { ascending: false }).limit(10)),
      safe(supabase.from('dispatch_documents').select('doc_type, document_number, uploaded_at').eq('dispatch_id', d.id).is('voided_at', null)),
      safe(supabase.from('dispatch_requests').select('sequence_order, status, transport_requests(request_number, delivery_district, delivery_address)').eq('dispatch_id', d.id).order('sequence_order')),
      safe(supabase.from('vw_caja_trip_status').select('advances_delivered, advances_requested, expenses_count, pending_count, observed_count, balance, settlement_code, settlement_status, overdue').eq('dispatch_id', d.id).maybeSingle()),
    ])
    const pick = (keys: string[]) => Object.fromEntries(keys.filter(k => k in d).map(k => [k, d[k]]))
    return { asOf, dispatch: { ...pick(['id', 'dispatch_number', 'status', 'vehicle_plate', 'scheduled_departure', 'departure_at', 'returned_at',
        'freight_cost', 'estimated_distance_km', 'last_gps_at', 'created_at']), url: '/torre-control' },
      driver, stops, recentEvents: events, documents: docs,
      hasGuide: Array.isArray(docs) ? docs.some((x: Row) => x.doc_type === 'GUIA_REMISION') : null,
      cash, otherMatches: found.slice(1).map(x => ({ dispatch_number: x.dispatch_number, status: x.status, vehicle_plate: x.vehicle_plate })),
      note: 'El estado LIQUIDADO se muestra al usuario como CERRADO (cierre operativo de la ruta).' }
  }
  if (name === 'get_compliance_alerts') {
    const in30 = new Date(Date.now() + 30 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
    const [vehicleDocs, licenses, driverDocs, openTrips] = await Promise.all([
      supabase.from('vw_document_alerts').select('vehicle_plate, document_type, expiration_date, days_remaining, status')
        .in('site_id', siteIds).neq('status', 'VIGENTE').order('expiration_date').limit(60),
      supabase.from('drivers').select('first_name, last_name, license_number, license_expiration')
        .eq('is_active', true).lte('license_expiration', in30).order('license_expiration').limit(50),
      supabase.from('driver_documents').select('doc_type, expiry_date, drivers(first_name, last_name)')
        .eq('is_active', true).lte('expiry_date', in30).order('expiry_date').limit(50),
      supabase.from('dispatches').select('id, dispatch_number, status, vehicle_plate, scheduled_departure')
        .in('site_id', siteIds).in('status', ['PROGRAMADO', 'EN_CURSO', 'EN RUTA']).order('scheduled_departure').limit(100),
    ])
    const trips = openTrips.error ? [] : (openTrips.data || [])
    let withoutGuide: Row[] = []
    if (trips.length) {
      const guides = await supabase.from('dispatch_documents').select('dispatch_id').in('dispatch_id', trips.map(t => t.id))
        .eq('doc_type', 'GUIA_REMISION').is('voided_at', null)
      if (!guides.error) {
        const has = new Set((guides.data || []).map(g => g.dispatch_id))
        withoutGuide = trips.filter(t => !has.has(t.id)).slice(0, 40).map(t => ({ ...t, url: '/despacho/documentos' }))
      }
    }
    return { asOf,
      vehicleDocuments: vehicleDocs.error ? 'no disponible' : vehicleDocs.data,
      driverLicenses: licenses.error ? 'no disponible' : licenses.data,
      driverDocuments: driverDocs.error ? 'no disponible' : driverDocs.data,
      openDispatchesWithoutGuide: openTrips.error ? 'no disponible' : withoutGuide,
      note: 'Vencidos y por vencer en 30 días. Estados de unidad: VENCIDO, POR_VENCER (≤15 días), PROXIMO (≤30 días).' }
  }
  if (name === 'get_cash_status') {
    const [boxes, expenses, advances, trips] = await Promise.all([
      supabase.from('vw_cash_box_balances').select('code, name, box_type, balance, min_balance, last_movement_at')
        .eq('is_active', true).in('site_id', siteIds).order('code').limit(50),
      supabase.from('dispatch_expenses').select('status, amount', { count: 'exact' }).in('status', ['PENDIENTE', 'OBSERVADO']).limit(1000),
      supabase.from('vw_caja_advances').select('code, status, amount, driver_name, dispatch_number, reason_label, awaiting_approval, overdue, requested_at, due_at')
        .or('awaiting_approval.eq.true,overdue.eq.true').order('requested_at', { ascending: false }).limit(40),
      supabase.from('vw_caja_trip_status').select('dispatch_number, vehicle_plate, dispatch_status, advances_delivered, pending_count, observed_count, balance')
        .eq('overdue', true).in('site_id', siteIds).limit(40),
    ])
    const exp = expenses.error ? [] : (expenses.data || [])
    const boxRows = boxes.error ? [] : (boxes.data || [])
    return { asOf,
      boxes: boxes.error ? 'no disponible' : boxRows.map(b => ({ ...b, belowMinimum: Number(b.balance) < Number(b.min_balance) })),
      expensesToReview: expenses.error ? 'no disponible' : {
        total: expenses.count, sampleTruncated: (expenses.count || 0) > exp.length,
        byStatus: exp.reduce<Record<string, { count: number; amount: number }>>((map, e) => {
          const k = String(e.status); map[k] = map[k] || { count: 0, amount: 0 }; map[k].count++; map[k].amount += Number(e.amount || 0); return map
        }, {}), url: '/caja/aprobaciones' },
      advancesNeedingAttention: advances.error ? 'no disponible' : advances.data,
      tripsWithOverdueSettlement: trips.error ? 'no disponible' : trips.data,
      url: '/caja' }
  }
  if (name === 'get_contract_expenses') {
    const code = typeof args.contract_code === 'string' ? args.contract_code.trim().slice(0, 60) : ''
    const root = code ? (await supabase.from('contracts').select('id, code').ilike('code', literal(code)).limit(1).maybeSingle()).data : null
    if (!root) return { asOf, error: `No encontré la OT ${code} en su alcance.` }
    const children = await supabase.from('contracts').select('id').eq('parent_contract_id', root.id)
    const ids = [root.id, ...((children.data || []) as Array<{ id: string }>).map(c => c.id)]
    const { data, error } = await supabase.from('contract_services')
      .select('id, service_type, amount_pen, service_date, status, provider_name, referral_guide, hours, dispatch_id, contracts!contract_id(code)')
      .in('contract_id', ids).order('service_date', { ascending: false }).limit(60)
    const list = rows(data as Row[] | null, error)
    return { asOf, contract: root.code, expenses: list.map(e => ({ id: e.id, contract: e.contracts?.code, type: e.service_type,
      amount_pen: Number(e.amount_pen || 0), date: e.service_date, status: e.status, provider: e.provider_name, guide: e.referral_guide,
      hours: e.hours, from_dispatch: Boolean(e.dispatch_id) })), url: '/contratos/servicios' }
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
