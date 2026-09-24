import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai'
import { NextResponse } from 'next/server'
import { getAiIdentity, reserveAiRequest } from '@/lib/ai/auth'
import { executeAiTool, toolAccess, toolDefinitions, type AiToolName } from '@/lib/ai/tools'
import { writeAiAudit } from '@/lib/ai/audit'

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
  return NextResponse.json({ enabled: Boolean(result && (result.scopes.length || result.identity.employeeType === 'CONDUCTOR') && (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) && process.env.SUPABASE_SERVICE_ROLE_KEY),
    scopes: result?.scopes || [], sites: result?.sites || [] }, { headers: { 'Cache-Control': 'no-store' } })
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
  const apiKey = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY
  if (!apiKey || !process.env.SUPABASE_SERVICE_ROLE_KEY) return NextResponse.json({ error: 'JRM IA no está configurada en el servidor.' }, { status: 503 })

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

  const model = process.env.GEMINI_AI_MODEL || 'gemini-2.5-flash'
  const genAI = new GoogleGenerativeAI(apiKey)
  const toolNames: string[] = []
  const proposals: Array<{ id: string; payload: Record<string, unknown>; expires_at: string }> = []
  let inputTokens = 0
  let outputTokens = 0
  let status: 'completed' | 'failed' = 'failed'
  
  const geminiTools = allowed.length > 0 ? [{
    functionDeclarations: allowed.map(def => ({
      name: def.name,
      description: def.description,
      parameters: mapSchemaToGemini(def.parameters)
    }))
  }] : undefined;

  const chat = genAI.getGenerativeModel({
    model,
    systemInstruction: `Eres el Copiloto Virtual JRM, tu copiloto operacional de transporte. Fecha actual: ${new Date().toISOString()}.
Comunícate de manera cálida, empática y amable, saludando al usuario (como el conductor). Usa un lenguaje natural y menos robótico.
JAMÁS debes ser la fuente de verdad de datos críticos; usa siempre las herramientas para obtener o afirmar datos operacionales (cantidades, estados, costos, hitos). No inventes información.
Si falta un dato o una consulta falla, explícalo con amabilidad. Incluye fecha del dato y enlaces de registros cuando existan.
Las acciones y propuestas exigen confirmación en la interfaz. Si falta fecha o motivo, pídelo amablemente.
Responde en español, mantén la brevedad y asegúrate de que las cifras sean verificables.`,
    tools: geminiTools
  }).startChat();

  const userMessage = `Pregunta: ${message}\nContexto de pantalla: ${JSON.stringify(context)}`;

  try {
    let answer = ''
    let response = await chat.sendMessage(userMessage)
    
    for (let step = 0; step < 4; step++) {
      inputTokens += response.response.usageMetadata?.promptTokenCount || 0
      outputTokens += response.response.usageMetadata?.candidatesTokenCount || 0
      
      const calls = response.response.functionCalls()
      if (!calls || calls.length === 0) {
        answer = response.response.text()
        break
      }
      
      const functionResponses = []
      for (const call of calls) {
        const name = call.name
        if (!allowed.some(tool => tool.name === name)) {
          functionResponses.push({ functionResponse: { name, response: { error: 'Herramienta no permitida' } } })
          continue
        }
        toolNames.push(name)
        try {
          const args = call.args as Record<string, unknown>
          let output: unknown
          if (name === 'prepare_maintenance_action') {
            const { data, error } = await identity.supabase.rpc('ai_prepare_maintenance', {
              p_vehicle_plate: args.vehicle_plate,
              p_type: args.type,
              p_reason: args.reason,
              p_scheduled_date: args.scheduled_date,
            })
            if (error) throw error
            proposals.push(data)
            output = { ...data, note: 'La propuesta espera confirmación explícita del usuario.' }
          } else if (name === 'query_active_trip') {
            const { data, error } = await identity.supabase.rpc('get_active_trip_context')
            if (error) throw error
            output = data
          } else if (name === 'prepare_trip_action') {
            if (!context.dispatchId) throw new Error('No existe un viaje activo en el contexto.')
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
            output = { ...data, note: 'La propuesta espera confirmación explícita del usuario.' }
          } else {
            output = await executeAiTool(name as AiToolName, args, identity.supabase, siteIds, context)
          }
          functionResponses.push({ functionResponse: { name, response: output as object } })
        } catch {
          functionResponses.push({ functionResponse: { name, response: { error: 'Consulta no disponible' } } })
        }
      }
      response = await chat.sendMessage(functionResponses as import('@google/generative-ai').Part[])
    }
    if (!answer && proposals.length) answer = 'He preparado una propuesta para confirmar la acción. Revísala y presiona Confirmar.'
    if (!answer) throw new Error('Sin respuesta final dentro del límite de herramientas.')
    status = 'completed'
    return NextResponse.json({ answer, toolsUsed: [...new Set(toolNames)], proposals }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    console.error('JRM IA:', error)
    return NextResponse.json({ error: 'JRM IA no pudo completar la consulta.' }, { status: 502 })
  } finally {
    await writeAiAudit({
      user_id: identity.userId, scope: 'copilot', model,
      tool_names: [...new Set(toolNames)], context_refs: context,
      input_tokens: inputTokens, output_tokens: outputTokens, status,
    })
  }
}
