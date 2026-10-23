// JRM IA como orquestador (src/app/api/jrm-ai/route.ts) con un proveedor simulado (OpenAI): modelo profundo en
// preguntas de decisión con respaldo al estándar, vista integral en paralelo y preguntas de seguimiento.
// Ejecutar: node --test scripts/test-jrm-ai-orchestration.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function load(file, mocks = {}) {
  const mod = new Module(file, module)
  mod.paths = module.paths
  const normal = mod.require.bind(mod)
  mod.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : normal(name)
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
  return mod.exports
}
const scopes = { get_pending_dispatches: 'distribucion', get_cash_status: 'caja', get_compliance_alerts: 'distribucion', get_cmms_brief: 'mantenimiento' }
function endpoint() {
  const executed = []
  const identity = {
    supabase: { from: () => ({ select: () => ({ eq: async () => ({ data: [{ id: 'site1', name: 'Lima' }] }) }) }), rpc: async () => ({ data: null }) },
    userId: 'u1', employeeType: 'OFICINA', firstName: 'Ana', roleName: 'Jefe', isAdmin: false, canRead: () => true,
    canPrepareMaintenance: () => false, canUseAi: scope => scope !== 'mantenimiento',
  }
  const route = load(path.resolve(__dirname, '../src/app/api/jrm-ai/route.ts'), {
    '@/lib/ai/apt-analysis': { validateAptAnalysisFilters: () => undefined, getAptOperationalAnalysis: async () => null, formatAptAnalysisReport: () => '' },
    '@/lib/ai/auth': { getAiIdentity: async () => identity, reserveAiRequest: async () => true },
    '@/lib/ai/tools': {
      toolAccess: Object.fromEntries(Object.entries(scopes).map(([name, scope]) => [name, { scope, modules: ['m'] }])),
      toolDefinitions: Object.keys(scopes).map(name => ({ name, description: name, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } })),
      executeAiTool: async (name, args) => { executed.push({ name, args }); return { ok: name } },
    },
    '@/lib/ai/audit': { writeAiAudit: async () => {} }, '@/lib/ai/actions': {},
    '@/lib/ai/knowledge': { searchHelp: query => ({ pantallas: [{ pantalla: 'Despacho', ruta: '/despacho' }], documentos: [], query }) },
  })
  return { route, executed }
}
function fakeOpenAI(script) {
  const bodies = []
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body)
    const step = script(body, bodies.length)
    if (step.status) return new Response('modelo no disponible', { status: step.status })
    return new Response(JSON.stringify({ choices: [{ message: step }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })
  }
  return bodies
}
const ask = (route, message, extra = {}) => route.POST(new Request('http://localhost/api/jrm-ai', { method: 'POST', body: JSON.stringify({ message, context: { path: '/' }, ...extra }) }))
process.env.AI_PROVIDER = 'openai'; process.env.OPENAI_API_KEY = 'test'; delete process.env.GEMINI_API_KEY

test('pregunta de decisión: modelo profundo, vista integral en paralelo, ayuda y preguntas de seguimiento', async () => {
  const { route, executed } = endpoint()
  const bodies = fakeOpenAI((body, n) => n === 1
    ? { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'get_operations_briefing', arguments: '{}' } }, { id: 'b', function: { name: 'search_help', arguments: '{"query":"reprogramar despacho"}' } }] }
    : { role: 'assistant', content: '**Situación**\n- 3 despachos atrasados\n**Recomendación**\nPriorice /despacho\n>> ¿Qué cliente es más crítico?\n>> ¿Cuánto cuesta reprogramar?' })
  const res = await ask(route, '¿Qué me recomiendas priorizar hoy?')
  const data = await res.json()
  assert.equal(res.status, 200)
  assert.equal(bodies[0].model, 'gpt-4.1', 'decisión → modelo profundo')
  assert.ok(bodies[0].tools.some(t => t.function.name === 'search_help') && bodies[0].tools.some(t => t.function.name === 'get_operations_briefing'))
  assert.deepEqual(executed.map(e => e.name).sort(), ['get_cash_status', 'get_compliance_alerts', 'get_pending_dispatches'], 'vista integral consulta solo áreas con permiso IA')
  const toolMsgs = bodies[1].messages.filter(m => m.role === 'tool').map(m => JSON.parse(m.content))
  assert.ok(toolMsgs.some(m => m.areas && m.areas.caja), 'resultado por área')
  assert.ok(toolMsgs.some(m => m.pantallas && m.pantallas[0].ruta === '/despacho'), 'ayuda funcional')
  assert.deepEqual(data.followUps, ['¿Qué cliente es más crítico?', '¿Cuánto cuesta reprogramar?'])
  assert.doesNotMatch(data.answer, />>/)
  assert.equal(data.deep, true)
  assert.match(bodies[0].messages[0].content, /Sin permiso IA de datos en: mantenimiento/)
})

test('pregunta simple usa el modelo estándar; si el profundo falla, responde con el estándar', async () => {
  let { route } = endpoint()
  let bodies = fakeOpenAI(() => ({ role: 'assistant', content: 'Hay 2 cajas.' }))
  let data = await (await ask(route, 'cuantas cajas hay')).json()
  assert.equal(bodies[0].model, 'gpt-4.1-mini'); assert.equal(data.deep, false); assert.deepEqual(data.followUps, [])
  ;({ route } = endpoint())
  bodies = fakeOpenAI(body => body.model === 'gpt-4.1' ? { status: 404 } : { role: 'assistant', content: 'Respuesta estándar' })
  const res = await ask(route, 'hola', { deep: true })
  data = await res.json()
  assert.equal(res.status, 200); assert.equal(data.answer, 'Respuesta estándar'); assert.equal(data.deep, false)
  assert.deepEqual(bodies.map(b => b.model), ['gpt-4.1', 'gpt-4.1-mini'])
})
