const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const vm = require('node:vm')
const ts = require('typescript')

const source = readFileSync('src/app/(dashboard)/contratos/servicios/page.tsx', 'utf8')
const ast = ts.createSourceFile('page.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let declaration
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'fetchData') declaration = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(declaration)

async function load(weightFailure) {
  const state = { errors: [] }
  const setters = ['Loading','RegistryContext','Services','PesoApt','PesoAptError','Contracts','CanVoidDirect','OrphanDispatches']
  const deps = Object.fromEntries(setters.map(name => ['set'+name, value => { state[name] = value }]))
  const row = { id: 'service', referral_guide: 'T001-6820' }
  const contract = { id: 'contract', contract_budgets: [{balance_pen: 1234}] }
  function query() {
    const q = { select:()=>q, gte:()=>q, eq:()=>q, order:()=>q,
      range:async()=>({data:[row],error:null}) }
    return q
  }
  Object.assign(deps, {
    filterDateFrom: '', applyPreselect:()=>{}, readCache:()=>undefined, writeCache:()=>{},
    errorMessage: e => e.message,
    toast: { error: message => state.errors.push(message) },
    allPages: async () => [contract],
    supabase: {
      from: query,
      rpc: async name => {
        if(name === 'get_service_registry_context') return {data:[{service_id:'service',guide_numbers:['T001-6820']}],error:null}
        if(name === 'get_service_registry_weight') return weightFailure
          ? {data:null,error:{message:'canceling statement due to statement timeout'}}
          : {data:[{service_id:'service',kg:11231}],error:null}
        return {data:name === 'can_void_contract_service' ? true : [],error:null}
      },
    },
  })
  const module = { exports: {} }
  const wrapper = `module.exports = async deps => { const {${Object.keys(deps).join(',')}} = deps; const ${declaration}; await fetchData(); }`
  vm.runInNewContext(ts.transpileModule(wrapper,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module})
  await module.exports(deps)
  assert.equal(state.Loading,false)
  assert.equal(state.Services[0].id,'service')
  assert.equal(state.Contracts[0].contract_budgets[0].balance_pen,1234)
  assert.equal(state.CanVoidDirect,true)
  assert.deepEqual(Array.from(state.OrphanDispatches),[])
  return state
}
async function main() {
  const failed = await load(true)
  assert.match(failed.PesoAptError,/statement timeout/)
  assert.ok(failed.errors.every(error=>!error.startsWith('Error al cargar datos')))
  assert.equal(Object.keys(failed.PesoApt).length,0)
  const success = await load(false)
  assert.equal(success.PesoAptError,null)
  assert.equal(success.PesoApt.service.kg,11231)
  assert.equal(success.errors.length,0)
  console.log('PASS: APT timeout does not prevent loading contracts, budgets, permissions or reconciliation; successful weight is retained')
}
main().catch(error=>{console.error(error);process.exitCode=1})
