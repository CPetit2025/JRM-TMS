const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
global.document = { addEventListener() {}, removeEventListener() {} }
function load(file, mocks = {}) {
  const filename = path.resolve(__dirname, '..', file), loaded = new Module(filename, module)
  loaded.paths = module.paths
  loaded.require = name => mocks[name] ?? require(name)
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, filename)
  return loaded.exports
}
const { SearchableSelect } = load('src/components/ui/SearchableSelect.tsx')
const people = ['T010', 'T003', 'T001', 'T002', 'T10', 'T2'].map((code, i) => ({
  id: code, code, name: i === 2 ? 'José Pérez' : `Persona ${i}`, document_number: `1234567${i}`, active: true, area_id: 'a', rate_ready: true,
}))
people.push({ id: 'inactive', code: 'T000', active: false, area_id: 'a' }, { id: 'other', code: 'T000', active: true, area_id: 'b' })
const calls = []
const wrapper = ({ children, actions }) => React.createElement('div', null, actions, children)
const { RequestForm } = load('src/components/hhee/flujo/request-form.tsx', {
  '@/components/ui/SearchableSelect': { SearchableSelect },
  sonner: { toast: { success() {}, warning() {}, error() {} } },
  './context': { useFlow: () => ({ ctx: { people, areas: [{ id: 'a', can_request: true }], causes: [], caps: {} } }), Card: wrapper, Field: wrapper, Modal: wrapper },
  '@/lib/hhee/flujo': { REFERENCES: [], today: () => '2026-10-20', isPendingText: () => false, limaLocal: x => x,
    fmtHours: String, fmtMoney: String, call: async (name, args) => { calls.push({ name, args }); return { lines: args.p.lines.map(l => ({ person_id: l.person_id, minutes: 150, m25: 120, m35: 30 })) } } },
})
const pause = () => new Promise(resolve => setTimeout(resolve, 400))
test('every row searches code, name and DNI in natural order without changing hours, rest or preview', async () => {
  let renderer
  await act(async () => { renderer = create(React.createElement(RequestForm, { detail: null, onClose() {}, onSaved() {} })) })
  const add = () => renderer.root.findAllByType('button').find(b => b.children.includes(' Agregar trabajador'))
  await act(async () => { add().props.onClick(); add().props.onClick() })
  const selectors = () => renderer.root.findAllByType(SearchableSelect)
  assert.equal(selectors().length, 2)
  assert.deepEqual(selectors()[0].props.options.map(o => o.value), ['T001', 'T002', 'T2', 'T003', 'T010', 'T10'])
  const input = label => renderer.root.findByProps({ 'aria-label': label })
  await act(async () => {
    input('Inicio del trabajador 1').props.onChange({ target: { value: '19:15' } })
    input('Fin del trabajador 1').props.onChange({ target: { value: '22:00' } })
    input('Descanso del trabajador 1').props.onChange({ target: { value: '15' } })
    input('Día de descanso del trabajador 1').props.onChange({ target: { checked: true } })
  })
  const search = async (row, term, expected) => {
    await act(async () => input(`Trabajador ${row}`).props.onClick())
    await act(async () => input(`Buscar trabajador ${row}`).props.onChange({ target: { value: term } }))
    const options = renderer.root.findAllByType('button').filter(b => typeof b.children[0] === 'string' && b.children[0].includes(' · DNI'))
    assert.deepEqual(options.map(b => b.children[0].split(' · ')[0]), expected)
    return options
  }
  let options = await search(1, 'jose perez', ['T001'])
  await act(async () => options[0].props.onClick())
  options = await search(2, '12345672', ['T001'])
  assert.equal(options[0].props.disabled, true)
  await act(async () => options[0].props.onClick())
  assert.equal(selectors()[1].props.value, '')
  await act(async () => input('Buscar trabajador 2').props.onChange({ target: { value: 't003' } }))
  await act(async () => renderer.root.findAllByType('button').find(b => typeof b.children[0] === 'string' && b.children[0].startsWith('T003 ·')).props.onClick())
  await act(pause)
  const payload = calls.at(-1).args.p.lines
  assert.deepEqual(payload[0], { person_id: 'T001', start: '2026-10-20T19:15', end: '2026-10-20T22:00', break_minutes: 15, rest_day: true })
  assert.equal(payload[1].person_id, 'T003')
  assert.equal(input('Inicio del trabajador 1').props.value, '19:15')
  assert.ok(renderer.root.findByProps({ 'aria-label': 'Horas calculadas del trabajador 1' }))
  await act(async () => renderer.unmount())
})
