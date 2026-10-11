const { test } = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const browser = { setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} }
function load(file, mock, extra = {}) {
 const context = { exports: {}, require: mock, window: browser, crypto: require('node:crypto').webcrypto, ...extra }
 vm.runInNewContext(ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, context)
 return context.exports
}
const context = { revision: 'revision-1', frontier: 1, capacity_kg: 1000, dispatch: { number: 'D-1', plate: 'AAA-111', driver: 'Conductor', status: 'EN RUTA' },
 stops: [{ id: 'current', order: 1, number: 'RT-1', ot: 'OT-1', locked: true }, { id: 'future', order: 2, number: 'RT-2', ot: 'OT-1', locked: false }],
 requests: [{ id: 'new', number: 'RT-3', type: 'RECOJO', ot: 'OT-2', origin: 'Proveedor', destination: 'Planta', required_date: '2030-01-01', weight_kg: '100' }] }
function labelText(node) { if (typeof node === 'string') return node; return (node?.children || []).map(labelText).join('') }
test('route form protects current leg, previews inserted service and reuses operation after failure', async () => {
 const calls = [], successes = []; let changes = 0, closes = 0, tree
 const { AddRouteService } = load('src/components/despacho/AddRouteService.tsx', name => {
   if (name === '@/lib/supabase/client') return { createClient: () => ({ rpc: async (name, args) => {
     if (name === 'active_route_context') return { data: context, error: null }
     calls.push(args); return calls.length === 1 ? { error: { message: 'Saldo insuficiente' } } : { error: null }
   } }) }
   if (name === '@/components/ui/modal') return { Modal: ({ children }) => React.createElement('div', null, children) }
   if (name === 'sonner') return { toast: { success: text => successes.push(text) } }
   return require(name)
 })
 await act(async () => { tree = create(React.createElement(AddRouteService, { dispatchId: 'dispatch', onClose: () => closes++, onChanged: () => changes++ })) })
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
 await act(async () => { tree.root.findAllByType('button').find(b => labelText(b) === 'Seleccionar').props.onClick() })
 const select = tree.root.findByType('select')
 assert.equal(select.findAllByType('option').length, 2, 'only future stop can be moved')
 assert.equal(select.findAllByType('option')[1].props.value, 'future')
 await act(async () => { select.props.onChange({ target: { value: 'future' } }) })
 assert.match(labelText(tree.root.findByType('ol')), /RT-1.*RT-3.*RT-2/)
 const numbers = tree.root.findAllByType('input').filter(i => i.props.type === 'number')
 for (const [i, value] of ['150', '5', '100', '500'].entries()) await act(async () => { numbers[i].props.onChange({ target: { value } }) })
 await act(async () => {
   tree.root.findAllByType('input').find(i => i.props.type === 'datetime-local').props.onChange({ target: { value: '2029-12-31T17:45' } })
   tree.root.findAllByType('input').find(i => i.props.minLength === 10).props.onChange({ target: { value: 'Recojo adicional coordinado' } })
   tree.root.findAllByType('input').find(i => i.props.type === 'checkbox').props.onChange({ target: { checked: true } })
 })
 const submit = () => tree.root.findByType('form').props.onSubmit({ preventDefault() {} })
 await act(async () => { await submit() })
 assert.match(labelText(tree.root.findByProps({ role: 'alert' })), /Saldo insuficiente/)
 assert.equal(changes, 0); assert.equal(closes, 0)
 await act(async () => { await submit() })
 assert.equal(calls.length, 2)
 assert.equal(calls[0].p_operation, calls[1].p_operation)
 assert.equal(calls[0].p_before, 'future')
 assert.equal(calls[0].p_expected_at, '2029-12-31T22:45:00.000Z', 'explicit Lima time')
 assert.equal(changes, 1); assert.equal(closes, 1); assert.equal(successes.length, 1)
 await act(async () => tree.unmount())
})
test('driver refresh announces newly added stops once, without an alert on initial loading', async () => {
 const messages = []; let stops = [{ transport_request_id: 'original' }], current, tree
 const { ActiveTripProvider, useActiveTrip } = load('src/contexts/ActiveTripContext.tsx', name => {
   if (name === '@/lib/supabase/client') return { createClient: () => ({ rpc: async name => ({ data: name === 'get_active_trip_context' ? { trip: { id: 'route', stops }, pending: {} } : {}, error: null }) }) }
   if (name === 'sonner') return { toast: { info: message => messages.push(message) } }
   return require(name)
 }, { window: { ...browser, setTimeout: () => 1, clearTimeout: () => {} } })
 function Probe() { current = useActiveTrip(); return null }
 await act(async () => { tree = create(React.createElement(ActiveTripProvider, null, React.createElement(Probe))) })
 await act(async () => { await current.refresh() })
 assert.equal(messages.length, 0)
 stops = [...stops, { transport_request_id: 'new' }]
 await act(async () => { await current.refresh() })
 assert.equal(messages.length, 1)
 await act(async () => { await current.refresh() })
 assert.equal(messages.length, 1)
 await act(async () => tree.unmount())
})
test('sidebar opens one section, closes the previous section and follows navigation', async () => {
 let pathname = '/despacho', tree
 const store = load('src/lib/nav/sidebarStore.ts', require, { localStorage: { getItem: () => null, setItem: () => {} } })
 const nav = load('src/lib/nav/navConfig.ts', name => name === 'lucide-react' ? new Proxy({}, { get: () => () => null }) : require(name))
 const { Sidebar } = load('src/components/layout/sidebar.tsx', name => {
   if (name === 'next/link') return { default: ({ children, ...props }) => React.createElement('a', props, children) }
   if (name === 'next/navigation') return { usePathname: () => pathname, useRouter: () => ({ push() {} }) }
   if (name === '@/hooks/usePermissions') return { usePermissions: () => ({ role: 'admin', hasAccess: yes }) }
   if (name === '@/lib/roles') return { roleDeniesPath: () => false }
   if (name === '@/lib/nav/sidebarStore') return store
   if (name === '@/lib/nav/navConfig') return nav
   if (name === '@/lib/nav/useMenuCounts') return { useMenuCounts: () => ({}), COUNT_STYLE: {}, countLabel: () => '' }
   if (name === 'lucide-react') return new Proxy({}, { get: () => () => null })
   return require(name)
 }, { document: { activeElement: null } })
 function yes() { return true }
 await act(async () => { tree = create(React.createElement(Sidebar)) })
 const sections = () => tree.root.findAllByType('button').filter(b => 'aria-expanded' in b.props)
 assert.equal(sections().filter(b => b.props['aria-expanded']).length, 1)
 const other = sections().find(b => !b.props['aria-expanded'])
 await act(async () => other.props.onClick())
 assert.equal(sections().filter(b => b.props['aria-expanded']).length, 1)
 await act(async () => sections().find(b => b.props['aria-expanded']).props.onClick())
 assert.equal(sections().filter(b => b.props['aria-expanded']).length, 0)
 pathname = '/apt'
 await act(async () => tree.update(React.createElement(Sidebar)))
 assert.equal(sections().filter(b => b.props['aria-expanded']).length, 1)
 assert.equal(sections().find(b => b.props['aria-expanded']).props.title, 'Estás en esta sección')
 await act(async () => tree.unmount())
})
