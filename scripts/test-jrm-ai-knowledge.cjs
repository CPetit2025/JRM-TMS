// Base de conocimiento de JRM IA (src/lib/ai/knowledge.ts): documentación funcional y mapa de pantallas.
// Ejecutar: node --test scripts/test-jrm-ai-knowledge.cjs
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
function load(file, mocks = {}) {
  const mod = new Module(file, module)
  mod.paths = module.paths
  const normal = mod.require.bind(mod)
  mod.require = name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name]
    : name.startsWith('@/') ? load(path.join(root, 'src', name.slice(2)) + '.ts', mocks) : normal(name)
  mod._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file)
  return mod.exports
}
// Íconos del menú: no se usan en el servidor
const icons = new Proxy({}, { get: () => () => null })
const kb = load(path.join(root, 'src/lib/ai/knowledge.ts'), { 'lucide-react': icons })
const all = () => true

test('responde «cómo hago» con la documentación y la pantalla correctas', () => {
  const r = kb.searchHelp('¿Cómo reprogramo una solicitud observada por partida?', all)
  assert.ok(r.documentos.length > 0)
  assert.match(r.documentos[0].titulo, /observada por partida/i)
  assert.ok(r.pantallas.some(p => p.ruta === '/solicitudes'))
})

test('ubica la carga del ERP del Almacén APT', () => {
  const r = kb.searchHelp('cargar entradas y salidas del ERP', all)
  assert.equal(r.pantallas[0].ruta, '/apt/datos')
  assert.ok(r.documentos.some(d => /inventario/i.test(d.titulo)))
})

test('no expone documentación técnica (infraestructura, despliegue, auditorías de seguridad)', () => {
  for (const q of ['SUPABASE_SERVICE_ROLE_KEY variables de entorno', 'deploy hook vercel secretos', 'auditoría de seguridad producción']) {
    const r = kb.searchHelp(q, all)
    assert.ok(r.documentos.every(d => !/infra-connections|despliegue-automatico|configurar-openai|auditorias\//.test(d.fuente)), q)
  }
})

test('marca las pantallas sin permiso y no inventa resultados', () => {
  const r = kb.searchHelp('aprobar gastos de caja', () => false)
  assert.ok(r.pantallas.length > 0)
  assert.ok(r.pantallas.every(p => p.acceso !== 'sí' || p.ruta === '/' || p.ruta === '/seguimiento'))
  assert.equal(kb.searchHelp('de la el', all).documentos.length, 0)
})
