// Supabase simulado para capturas del manual: datos de demostración, sin conexión a producción.
const http = require('node:http')
const PORT = 54321
const UID = '11111111-1111-4111-8111-111111111111'
const SITE = '22222222-2222-4222-8222-222222222222'
const now = new Date()
const iso = d => new Date(d).toISOString()
const day = n => { const d = new Date(now); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
const clients = [
  { id: 'c1', business_name: 'MINERA ANDINA DEL SUR S.A.C.', tax_id: '20512345678', country_code: 'PE', country_name: 'Perú', is_active: true },
  { id: 'c2', business_name: 'CONSTRUCTORA LOS ANDES S.A.', tax_id: '20498765432', country_code: 'PE', country_name: 'Perú', is_active: true },
  { id: 'c3', business_name: 'AGROINDUSTRIAL PACÍFICO S.A.C.', tax_id: '20601234567', country_code: 'PE', country_name: 'Perú', is_active: true },
]
const budget = (a, b) => [{ concept: 'PARTIDA_TRANSPORTE', allocated_pen: a, balance_pen: b }]
let contracts = [
  { id: 'k1', code: '16540', type: 'CONTRATO', status: 'ACTIVO', parent_contract_id: null, client_id: 'c1', destination_address: 'Km 45 Panamericana Sur, Proyecto Andino', destination_department: 'LIMA', destination_province: 'CAÑETE', destination_district: 'CHILCA', clients: { business_name: clients[0].business_name }, contract_budgets: budget(25000, 18400) },
  { id: 'k1s', code: '16540-S001', type: 'SUBCONTRATO', status: 'ACTIVO', parent_contract_id: 'k1', client_id: 'c1', destination_address: null, destination_department: null, destination_province: null, destination_district: null, clients: { business_name: clients[0].business_name }, contract_budgets: [] },
  { id: 'k2', code: '16552', type: 'CONTRATO', status: 'ACTIVO', parent_contract_id: null, client_id: 'c2', destination_address: 'Av. Los Ingenieros 455, Ate', destination_department: 'LIMA', destination_province: 'LIMA', destination_district: 'ATE', clients: { business_name: clients[1].business_name }, contract_budgets: budget(12000, 9300) },
  { id: 'k3', code: '16561', type: 'CONTRATO', status: 'ACTIVO', parent_contract_id: null, client_id: 'c3', destination_address: 'Fundo San José s/n, Chincha', destination_department: 'ICA', destination_province: 'CHINCHA', destination_district: 'CHINCHA ALTA', clients: { business_name: clients[2].business_name }, contract_budgets: budget(8000, 7100) },
]
const suppliers = [
  { id: 's1', tax_id: '20100070970', business_name: 'ACEROS INDUSTRIALES DEL PERÚ S.A.', category: 'MATERIALES', contact_name: 'Rosa Quispe', contact_phone: '987654321', contact_email: 'ventas@acerosind.pe', notes: null, is_active: true,
    supplier_locations: [{ id: 'sl1', supplier_id: 's1', name: 'Almacén Lurín', address: 'Av. Industrial 1200, Lurín', department: 'LIMA', province: 'LIMA', district: 'LURIN', is_active: true }] },
]
const reqBase = { site_id: SITE, requester_name: 'Ana Torres', department: 'LOGÍSTICA', cargo_description: 'Estructuras metálicas', estimated_weight: 1800, created_by: UID, attention_mode: 'TRANSPORTE_JRM', delivery_zone: 'LIMA', unloading_required: false, service_cost: 450, transport_request_components: [], suppliers: null, request_client: null }
let requests = [
  { ...reqBase, id: 'r1', request_number: 'RT-2026-0412', status: 'PENDIENTE DE APROBACIÓN', request_type: 'DESPACHO', contract_id: 'k1', required_date: day(2), required_at: iso(day(2) + 'T14:00:00Z'), created_at: iso(now - 3600e3), pickup_address: 'Planta Chilca', pickup_district: 'CHILCA', delivery_address: contracts[0].destination_address, delivery_district: 'CHILCA', contracts: { code: '16540', clients: { business_name: clients[0].business_name } } },
  { ...reqBase, id: 'r2', request_number: 'RT-2026-0409', status: 'APROBADA', request_type: 'DESPACHO', contract_id: 'k2', required_date: day(1), required_at: iso(day(1) + 'T15:00:00Z'), created_at: iso(now - 86400e3), pickup_address: 'Planta Chilca', pickup_district: 'CHILCA', delivery_address: contracts[2].destination_address, delivery_district: 'ATE', contracts: { code: '16552', clients: { business_name: clients[1].business_name } } },
  { ...reqBase, id: 'r3', request_number: 'RT-2026-0405', status: 'ASIGNADA', request_type: 'RECOJO', contract_id: null, reference_type: 'OC', reference_number: '57724', supplier_id: 's1', required_date: day(0), required_at: iso(day(0) + 'T16:00:00Z'), created_at: iso(now - 2 * 86400e3), pickup_address: 'Av. Industrial 1200, Lurín', pickup_district: 'LURIN', delivery_address: 'Planta Chilca', delivery_district: 'CHILCA', suppliers: { business_name: suppliers[0].business_name }, contracts: null },
  { ...reqBase, id: 'r4', request_number: 'RT-2026-0398', status: 'OBSERVADA', budget_observation: 'Partida insuficiente: Contratos debe ampliarla', request_type: 'DESPACHO', contract_id: 'k3', required_date: day(3), required_at: iso(day(3) + 'T13:00:00Z'), created_at: iso(now - 3 * 86400e3), pickup_address: 'Planta Chilca', pickup_district: 'CHILCA', delivery_address: contracts[3].destination_address, delivery_district: 'CHINCHA ALTA', delivery_zone: 'PROVINCIA', contracts: { code: '16561', clients: { business_name: clients[2].business_name } } },
  { ...reqBase, id: 'r5', request_number: 'RT-2026-0390', status: 'ENTREGADA', request_type: 'DESPACHO', contract_id: 'k1', required_date: day(-4), required_at: iso(day(-4) + 'T14:00:00Z'), created_at: iso(now - 6 * 86400e3), pickup_address: 'Planta Chilca', pickup_district: 'CHILCA', delivery_address: contracts[0].destination_address, delivery_district: 'CHILCA', contracts: { code: '16540', clients: { business_name: clients[0].business_name } } },
]
const perms = ['solicitudes:write', 'despacho-aprobacion:write', 'despacho:write', 'ot:write', 'clientes:write', 'contratos:write']
const profile = { id: UID, email: 'ana.torres@jrm.pe', full_name: 'Ana Torres', first_name: 'Ana', last_name: 'Torres', is_active: true, employee_type: 'ADMINISTRATIVO', role_id: 'role1', roles: { name: 'Administrador', permissions: perms } }
const rpc = {
  get_transport_lead_time_settings: () => ({ enabled: true, zones: { LIMA: { enabled: true, hours: 24 }, PROVINCIA: { enabled: true, hours: 48 }, EXTERIOR: { enabled: true, hours: 72 } }, version: 3 }),
  quote_transport: () => ({ freight_total: 520, unloading_total: 0, total: 520, client_total: 624, vehicle_class: 'CAMIÓN 10 TN', missing: [], lines: [{ concept: 'FLETE', description: 'Flete Chilca → destino', quantity: 1, unit_rate: 520, amount: 520 }] }),
  get_transport_request_component_options: (b) => contracts.filter(c => c.id === b.p_root_id || c.parent_contract_id === b.p_root_id).map(c => ({ contract_id: c.id, code: c.code, component_type: c.parent_contract_id ? 'SUBCONTRATO' : 'OT_MADRE', status: 'ACTIVO', destination_address: c.destination_address, allocated_pen: c.contract_budgets[0]?.allocated_pen || 0, balance_pen: c.contract_budgets[0]?.balance_pen || 0 })),
  get_unloading_history: () => [],
  get_transport_request_summaries: () => [],
  register_contract_client: (b) => { const c = { id: 'c' + (clients.length + 1), business_name: b.p_business_name || 'TRANSPORTES Y SERVICIOS NORTE S.A.C.', tax_id: b.p_ruc || b.p_tax_id || '20555555551', country_code: 'PE', country_name: 'Perú', is_active: true }; clients.push(c); return { success: true, id: c.id, business_name: c.business_name, tax_id: c.tax_id, client: c } },
  create_contract: (b) => { const p = b.p_payload; const cl = clients.find(c => c.id === p.client_id); const k = { id: 'k' + (contracts.length + 1), code: p.code, type: 'CONTRATO', status: 'ACTIVO', parent_contract_id: null, client_id: p.client_id, destination_address: p.destination_address, destination_department: p.destination_department, destination_province: p.destination_province, destination_district: p.destination_district, clients: { business_name: cl?.business_name }, contract_budgets: budget(Number(b.p_budget_pen) || 0, Number(b.p_budget_pen) || 0) }; contracts.push(k); return { success: true, id: k.id } },
  save_transport_request_full: () => ({ success: true, id: 'r9', request_number: 'RT-2026-0413' }),
  save_supplier: (b) => ({ success: true, id: 's2' }),
  get_my_notifications: () => [], notif_unread_count: () => 0,
}
const send = (res, status, body, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*', 'Access-Control-Expose-Headers': '*', ...extra }); res.end(body === undefined ? '' : JSON.stringify(body)) }
const seen = new Set()
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204)
  let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
    const url = new URL(req.url, 'http://x'); const path = url.pathname
    if (path.startsWith('/auth/v1/user')) return send(res, 200, { id: UID, aud: 'authenticated', role: 'authenticated', email: profile.email, app_metadata: {}, user_metadata: { full_name: 'Ana Torres' }, created_at: iso(now) })
    if (path.startsWith('/auth/v1/')) return send(res, 200, {})
    if (path.startsWith('/storage/')) return send(res, 200, [])
    if (path.startsWith('/rest/v1/rpc/')) {
      const fn = path.split('/').pop(); const body = raw ? JSON.parse(raw) : {}
      if (!rpc[fn] && !seen.has('rpc:' + fn)) { seen.add('rpc:' + fn); console.log('RPC sin datos:', fn) }
      return send(res, 200, rpc[fn] ? rpc[fn](body) : null)
    }
    if (path.startsWith('/rest/v1/')) {
      const table = path.split('/').pop()
      let rows = ({ profiles: [profile], clients, contracts, suppliers, transport_requests: requests, supplier_locations: suppliers.flatMap(s => s.supplier_locations), sites: [{ id: SITE, name: 'Planta Chilca', code: 'CHI', is_primary: true }], user_site_access: [{ user_id: UID, site_id: SITE }] })[table]
      if (!rows) { if (!seen.has(table)) { seen.add(table); console.log('Tabla sin datos:', table) } rows = [] }
      for (const [k, v] of url.searchParams) {
        const m = /^eq\.(.*)$/.exec(v); if (m && !['select', 'order', 'limit'].includes(k) && rows.length && k in rows[0]) rows = rows.filter(r => String(r[k]) === m[1])
      }
      const single = (req.headers.accept || '').includes('vnd.pgrst.object')
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 201, single ? {} : [])
      return send(res, 200, single ? (rows[0] || null) : rows, { 'Content-Range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` })
    }
    send(res, 404, { message: 'not found' })
  })
}).listen(PORT, () => console.log('Supabase simulado en', PORT))
