const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const Module = require('node:module')

const file = path.resolve(__dirname, '../src/lib/kpi/reportReview.ts')
const compiled = new Module(file, module)
compiled._compile(ts.transpileModule(readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, file)
const { informesDelPeriodo, revisarInforme } = compiled.exports

test('cancelar comentario o confirmación nunca guarda la revisión', async () => {
  for (const estado of ['REVISADO', 'OBSERVADO']) {
    let guardados = 0
    const result = await revisarInforme(estado, {
      prompt: () => null, confirm: () => true, guardar: async () => ++guardados,
    })
    assert.equal(result, null)
    assert.equal(guardados, 0)
  }
  let guardados = 0
  assert.equal(await revisarInforme('REVISADO', {
    prompt: () => 'Conforme', confirm: () => false, guardar: async () => ++guardados,
  }), null)
  assert.equal(guardados, 0)
})

test('aprobación explícita permite comentario vacío y guarda una sola vez', async () => {
  const comentarios = []
  assert.equal(await revisarInforme('REVISADO', {
    prompt: () => '', confirm: () => true,
    guardar: async comentario => { comentarios.push(comentario); return 'guardado' },
  }), 'guardado')
  assert.deepEqual(comentarios, [null])
})

test('observar exige comentario y conserva el motivo de corrección', async () => {
  const comentarios = []
  const acciones = {
    prompt: () => '   ', confirm: () => { throw Error('No requiere aprobación') },
    guardar: async comentario => { comentarios.push(comentario); return 'observado' },
  }
  assert.equal(await revisarInforme('OBSERVADO', acciones), null)
  acciones.prompt = () => '  Adjuntar sustento  '
  assert.equal(await revisarInforme('OBSERVADO', acciones), 'observado')
  assert.deepEqual(comentarios, ['Adjuntar sustento'])
})

test('historial excluye informes posteriores y anteriores a la ventana, incluso pendientes', () => {
  const informes = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']
    .map(periodo => ({ periodo, estado: 'ENVIADO' }))
  assert.deepEqual(informesDelPeriodo(informes, '2026-09-01').map(i => i.periodo),
    ['2026-07-01', '2026-08-01', '2026-09-01'])
  assert.equal(informes.filter(i => i.estado === 'ENVIADO').length, 5)
})

test('ventana de tres meses cruza años y acepta un día cualquiera del mes', () => {
  const informes = ['2025-10-01', '2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01'].map(periodo => ({ periodo }))
  assert.deepEqual(informesDelPeriodo(informes, '2026-01-15').map(i => i.periodo),
    ['2025-11-01', '2025-12-01', '2026-01-01'])
})
