import { GoogleGenerativeAI, SchemaType, type Part } from '@google/generative-ai'
import { NextResponse } from 'next/server'
import { getAiIdentity, reserveAiRequest } from '@/lib/ai/auth'
import { executeAiTool, toolAccess, toolDefinitions, type AiToolName } from '@/lib/ai/tools'
import { writeAiAudit } from '@/lib/ai/audit'
import { prepareOfficeAction } from '@/lib/ai/actions'

export const runtime = 'nodejs'

async function access() {
  const identity = await getAiIdentity()
  if (!identity) return null
  const scopes: string[] = Object.values(toolAccess)
    .filter(item => identity.canUseAi(item.scope, [...item.modules]))
    .map(item => item.scope)
  const { data: sites, error } = await identity.supabase.from('sites').select('id, name').eq('is_active', true)
  if ((error || !sites?.length) && identity.employeeType !== 'CONDUCTOR') return null
  if (identity.employeeType === 'CONDUCTOR') scopes.push('viaje')
  if (identity.canPrepareMaintenance()) scopes.push('mantenimiento')
  return { identity, scopes: [...new Set(scopes)], sites: sites || [] }
}

export async function GET() {
  const result = await access()
  // Proveedor: Gemini si hay GEMINI_API_KEY (o AI_PROVIDER=openai para forzar OpenAI); si no, OpenAI.
  return NextResponse.json({ enabled: Boolean(result && (result.scopes.length || result.identity.employeeType === 'CONDUCTOR') && aiProvider() && process.env.SUPABASE_SERVICE_ROLE_KEY),
    scopes: result?.scopes || [], sites: result?.sites || [], name: result?.identity.firstName || null,
    isDriver: result?.identity.employeeType === 'CONDUCTOR' }, { headers: { 'Cache-Control': 'no-store' } })
}

// Historial breve de la conversación (lo envía el panel) en el formato de Gemini: empieza por el usuario y alterna.
function toHistory(value: unknown) {
  if (!Array.isArray(value)) return []
  const items = value.slice(-12).flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const { from, text } = item as { from?: unknown; text?: unknown }
    if ((from !== 'user' && from !== 'ai') || typeof text !== 'string' || !text.trim()) return []
    return [{ role: from === 'user' ? 'user' : 'model', text: text.trim().slice(0, 2000) }]
  })
  const history: Array<{ role: string; parts: Array<{ text: string }> }> = []
  for (const item of items) {
    if (!history.length && item.role !== 'user') continue
    const last = history[history.length - 1]
    if (last && last.role === item.role) last.parts[0].text += `\n${item.text}`
    else history.push({ role: item.role, parts: [{ text: item.text }] })
  }
  if (history.length && history[history.length - 1].role === 'user') history.pop()
  return history
}

function mapSchemaToGemini(schema: any): any {
  if (!schema) return { type: SchemaType.OBJECT }
  const geminiType = {
    'string': SchemaType.STRING,
    'integer': SchemaType.INTEGER,
    'number': SchemaType.NUMBER,
    'boolean': SchemaType.BOOLEAN,
    'object': SchemaType.OBJECT,
    'array': SchemaType.ARRAY
  }[schema.type as string] || SchemaType.OBJECT

  const result: any = { type: geminiType }
  if (schema.description) result.description = schema.description
  if (schema.enum) result.enum = schema.enum.filter((v: any) => v !== null)
  if (schema.properties) {
    result.properties = {}
    for (const key of Object.keys(schema.properties)) {
      let prop = schema.properties[key]
      if (Array.isArray(prop.type)) {
        prop = { ...prop, type: prop.type.find((t: string) => t !== 'null') || 'string' }
      }
      result.properties[key] = mapSchemaToGemini(prop)
    }
  }
  if (schema.required) result.required = schema.required
  return result
}

export async function POST(request: Request) {
  const result = await access()
  if (!result) return NextResponse.json({ error: 'Sin acceso a JRM IA o sede.' }, { status: 403 })
  const { identity, sites } = result
  const provider = aiProvider()
  if (!provider || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'JRM IA no está configurada en el servidor (falta GEMINI_API_KEY u OPENAI_API_KEY).' }, { status: 503 })

  let body: Record<string, unknown>
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 }) }
  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > 1200) return NextResponse.json({ error: 'Escribe una pregunta de hasta 1200 caracteres.' }, { status: 400 })
  const submitted = body.context && typeof body.context === 'object' ? body.context as Record<string, unknown> : {}
  const siteId = typeof submitted.siteId === 'string' && sites.some(site => site.id === submitted.siteId)
    ? submitted.siteId : null
  const siteIds = siteId ? [siteId] : sites.map(site => site.id)
  const context = {
    path: typeof submitted.path === 'string' && submitted.path.startsWith('/') ? submitted.path.slice(0, 120) : '/',
    contractId: typeof submitted.contractId === 'string' ? submitted.contractId.slice(0, 100) : undefined,
    dispatchId: typeof submitted.dispatchId === 'string' ? submitted.dispatchId.slice(0, 60) : undefined,
    vehiclePlate: typeof submitted.vehiclePlate === 'string' ? submitted.vehiclePlate.slice(0, 20) : undefined,
    status: typeof submitted.status === 'string' ? submitted.status.slice(0, 40) : undefined,
    origin: submitted.origin === 'ai_voice' ? 'ai_voice' : 'ai_chat',
    siteId,
  }
  // El app del conductor no siempre informa el viaje en pantalla: se toma su viaje activo del servidor
  if (identity.employeeType === 'CONDUCTOR' && !context.dispatchId) {
    const { data } = await identity.supabase.rpc('get_active_trip_context')
    const tripId = (data as { trip?: { id?: string } } | null)?.trip?.id
    if (tripId) context.dispatchId = tripId
  }
  const history = toHistory(body.history)
  const allowed = toolDefinitions.filter(def => {
    if (def.name === 'prepare_maintenance_action') return identity.canPrepareMaintenance()
    if (def.name === 'prepare_trip_action' || def.name === 'query_active_trip') return identity.employeeType === 'CONDUCTOR'
    const rule = toolAccess[def.name as AiToolName]
    return rule ? identity.canUseAi(rule.scope, [...rule.modules]) : false
  })
  if (!allowed.length && identity.employeeType !== 'CONDUCTOR') return NextResponse.json({ error: 'Sin permisos IA para los módulos disponibles.' }, { status: 403 })
  if (!await reserveAiRequest(identity.supabase, 'copilot')) {
    return NextResponse.json({ error: 'Límite de consultas IA alcanzado. Intenta más tarde.' }, { status: 429 })
  }

  const model = provider.name === 'gemini' ? process.env.GEMINI_AI_MODEL || 'gemini-2.5-flash' : process.env.OPENAI_AI_MODEL || 'gpt-4.1-mini'
  const toolNames: string[] = []
  const proposals: Array<{ id: string; action_type?: string; payload: Record<string, unknown>; expires_at: string }> = []
  const usage = { input: 0, output: 0 }
  let status: 'completed' | 'failed' = 'failed'

  const system = `Eres JRM IA, el copiloto operacional del TMS de JRM (transporte de carga en Perú).
Fecha y hora en Lima: ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'full', timeStyle: 'short' })}.
Usuario: ${identity.firstName || 'sin nombre'}${identity.roleName ? ` · rol ${identity.roleName}` : ''}${identity.employeeType === 'CONDUCTOR' ? ' · conductor en el app móvil' : ''}.
Cobertura según permisos: solicitudes de transporte y su costo referencial, tarifario (cotizaciones), contratos/OT y su partida, despachos (búsqueda por número o placa, pendientes, incidencias, documentos), cumplimiento documentario, Caja (cajas, gastos por aprobar, anticipos, liquidaciones), flota y mantenimiento (CMMS), inventario de repuestos, Almacén de Producto Terminado (APT: permanencia, aging, TN×días, lotes a liberar), KPI y, para conductores, su viaje activo.
Reglas:
- Los datos operativos (cantidades, estados, montos, fechas) salen SIEMPRE de las herramientas; nunca los inventes ni los estimes. Si una herramienta no está disponible o falla, dilo y sugiere el módulo donde revisarlo.
- Si la pregunta es ambigua (qué OT, qué placa, qué periodo), usa el contexto de pantalla o el historial; si aún falta, pregunta brevemente. Periodo por defecto: 7 días.
- Montos en soles (S/ 1,234.50). Indica la fecha del dato y, cuando exista, la ruta del módulo (p. ej. /solicitudes) para abrir el registro.
- El costo de una solicitud es referencial (tarifario); el costo real del flete se fija al programar el despacho. El estado LIQUIDADO de un despacho se muestra como CERRADO.
- Puedes REGISTRAR y EDITAR con prepare_office_action (gastos de OT, corregir montos, alta de contratos/OT, asignar o actualizar la partida de transporte de una OT, estado de solicitudes) y, para conductores, reportes del viaje; para mantenimiento, programar OT. Todo se prepara como propuesta que el usuario confirma con el botón Confirmar; nunca digas que ya se guardó antes de la confirmación. Si falta un dato obligatorio (OT, monto, fecha, horas), pídelo. Anular gastos no se hace desde el chat: requiere autorización en la pantalla.
- La "partida de transporte" (presupuesto) de una OT NO es un gasto: para crearla, asignarla, ampliarla o corregirla usa SET_TRANSPORT_BUDGET (contract_code y budget). Si un gasto no se puede registrar porque la OT no tiene partida o no le alcanza el saldo, ofrece asignar o ampliar la partida.
- Si no tienes una herramienta para lo que piden (p. ej. falta el permiso IA del módulo), dilo con claridad.
- Responde en español, cordial y directo: primero la respuesta, luego el detalle en viñetas cortas. Sin tablas largas.`
  const userMessage = `Pregunta: ${message}\nContexto de pantalla: ${JSON.stringify(context)}`

  // Ejecuta una herramienta autorizada; los errores vuelven al modelo como { error } para que los explique
  const runTool = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!allowed.some(tool => tool.name === name)) return { error: 'Herramienta no permitida' }
    toolNames.push(name)
    try {
      if (name === 'prepare_maintenance_action') {
        const { data, error } = await identity.supabase.rpc('ai_prepare_maintenance', {
          p_vehicle_plate: args.vehicle_plate, p_type: args.type, p_reason: args.reason, p_scheduled_date: args.scheduled_date,
        })
        if (error) throw error
        proposals.push(data)
        return { ...data, note: 'La propuesta espera confirmación explícita del usuario.' }
      }
      if (name === 'prepare_office_action') {
        const prepared = await prepareOfficeAction(args, identity.supabase)
        if ('error' in prepared) return { error: prepared.error }
        const proposal = { id: crypto.randomUUID(), action_type: 'office_action', payload: prepared.proposal as unknown as Record<string, unknown>, expires_at: '' }
        proposals.push(proposal)
        return { prepared: prepared.proposal.lines, note: 'Propuesta lista: el usuario debe presionar Confirmar para guardarla.' }
      }
      if (name === 'query_active_trip') {
        const { data, error } = await identity.supabase.rpc('get_active_trip_context')
        if (error) throw error
        return data as Record<string, unknown>
      }
      if (name === 'prepare_trip_action') {
        if (!context.dispatchId) throw new Error('No tienes un viaje activo asignado.')
        const { data, error } = await identity.supabase.rpc('ai_prepare_trip_action', {
          p_dispatch_id: context.dispatchId,
          p_action: args.action,
          p_payload: {
            description: args.description, category: args.category, amount: args.amount,
            severity: args.severity, can_continue: args.can_continue,
          },
          p_original_input: message,
          p_origin: context.origin,
          p_device: { userAgent: request.headers.get('user-agent')?.slice(0, 300) || null },
          p_idempotency_key: crypto.randomUUID(),
        })
        if (error) throw error
        proposals.push(data)
        return { ...data, note: 'La propuesta espera confirmación explícita del usuario.' }
      }
      return await executeAiTool(name as AiToolName, args, identity.supabase, siteIds, context) as Record<string, unknown>
    } catch (toolError) {
      console.error(`JRM IA herramienta ${name}:`, toolError)
      return { error: toolError instanceof Error && toolError.message ? toolError.message : 'Consulta no disponible' }
    }
  }

  try {
    let answer = provider.name === 'gemini'
      ? await runGemini(provider.key, model, system, history, userMessage, allowed, runTool, usage)
      : await runOpenAI(provider.key, model, system, history, userMessage, allowed, runTool, usage)
    if (!answer && proposals.length) answer = 'He preparado una propuesta para confirmar la acción. Revísala y presiona Confirmar.'
    if (!answer) throw new Error('Sin respuesta final dentro del límite de herramientas.')
    status = 'completed'
    return NextResponse.json({ answer, toolsUsed: [...new Set(toolNames)], proposals }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('JRM IA:', error)
    return NextResponse.json({ error: 'JRM IA no pudo completar la consulta. Intenta de nuevo en unos segundos.' }, { status: 502 })
  } finally {
    // La auditoría no debe tumbar una respuesta ya obtenida
    try {
      await writeAiAudit({
        user_id: identity.userId, scope: 'copilot', model,
        tool_names: [...new Set(toolNames)], context_refs: context,
        input_tokens: usage.input, output_tokens: usage.output, status,
      })
    } catch (auditError) { console.error('JRM IA auditoría:', auditError) }
  }
}

type ToolDef = (typeof toolDefinitions)[number]
type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
type Turn = { role: string; parts: Array<{ text: string }> }
const MAX_STEPS = 6

function aiProvider(): { name: 'gemini' | 'openai'; key: string } | null {
  const preferred = (process.env.AI_PROVIDER || '').toLowerCase()
  if (preferred === 'openai' && process.env.OPENAI_API_KEY) return { name: 'openai', key: process.env.OPENAI_API_KEY }
  if (process.env.GEMINI_API_KEY) return { name: 'gemini', key: process.env.GEMINI_API_KEY }
  if (process.env.OPENAI_API_KEY) return { name: 'openai', key: process.env.OPENAI_API_KEY }
  return null
}

async function runGemini(apiKey: string, model: string, system: string, history: Turn[], userMessage: string,
  allowed: ToolDef[], runTool: ToolRunner, usage: { input: number; output: number }) {
  const chat = new GoogleGenerativeAI(apiKey).getGenerativeModel({
    model, systemInstruction: system,
    tools: allowed.length ? [{ functionDeclarations: allowed.map(def => ({
      name: def.name, description: def.description, parameters: mapSchemaToGemini(def.parameters),
    })) }] : undefined,
  }).startChat({ history })
  let response = await chat.sendMessage(userMessage)
  for (let step = 0; step < MAX_STEPS; step++) {
    usage.input += response.response.usageMetadata?.promptTokenCount || 0
    usage.output += response.response.usageMetadata?.candidatesTokenCount || 0
    const calls = response.response.functionCalls()
    if (!calls?.length) return response.response.text()
    const parts: Part[] = []
    for (const call of calls) {
      parts.push({ functionResponse: { name: call.name, response: await runTool(call.name, (call.args || {}) as Record<string, unknown>) } })
    }
    response = await chat.sendMessage(parts)
  }
  return ''
}

async function runOpenAI(apiKey: string, model: string, system: string, history: Turn[], userMessage: string,
  allowed: ToolDef[], runTool: ToolRunner, usage: { input: number; output: number }) {
  type Msg = { role: string; content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; tool_call_id?: string }
  const messages: Msg[] = [
    { role: 'system', content: system },
    ...history.map(turn => ({ role: turn.role === 'user' ? 'user' : 'assistant', content: turn.parts[0].text })),
    { role: 'user', content: userMessage },
  ]
  const tools = allowed.map(def => ({ type: 'function', function: { name: def.name, description: def.description, parameters: def.parameters, strict: true } }))
  for (let step = 0; step < MAX_STEPS; step++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, ...(tools.length ? { tools } : {}) }),
    })
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const data = await response.json() as { choices: Array<{ message: Msg }>; usage?: { prompt_tokens?: number; completion_tokens?: number } }
    usage.input += data.usage?.prompt_tokens || 0
    usage.output += data.usage?.completion_tokens || 0
    const reply = data.choices[0]?.message
    if (!reply?.tool_calls?.length) return reply?.content || ''
    messages.push(reply)
    for (const call of reply.tool_calls) {
      let args: Record<string, unknown> = {}
      try { args = JSON.parse(call.function.arguments || '{}') } catch { /* argumentos inválidos: la herramienta responde el error */ }
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(await runTool(call.function.name, args)).slice(0, 60_000) })
    }
  }
  return ''
}
