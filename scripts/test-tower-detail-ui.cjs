const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), ts = require('typescript'), React = require('react')
const { create, act } = require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT = true
const listeners = () => {}
global.document = { addEventListener: listeners, removeEventListener: listeners }
global.window = { setTimeout, clearTimeout }
const cache = new Map(), calls = []
let fail = false, crewPeople, closure = null, writeAllowed = true, closeResponse = null
const person = { id:'aux1',name:'Auxiliar de la ruta',code:'T-100',document_number:'12345678',position:'Auxiliar de reparto',area:'Logística',phone:'999111222',role:'AUXILIAR',active:true }
crewPeople = [person]
const client = { rpc: async (name,args) => { calls.push({name,args}); if(name==='manual_close_dispatch_operations' && closeResponse)return closeResponse(); return fail ? {data:null,error:{message:'temporarily unavailable'}} : {data:{success:true,people:crewPeople,manual_closure:closure},error:null} } }
function load(file) {
 const filename=path.resolve(__dirname,'..',file)
 if(cache.has(filename))return cache.get(filename)
 const m=new Module(filename,module);m.paths=module.paths
 m.require=name=>{
  if(name==='@/hooks/usePermissions')return {usePermissions:()=>({canWrite:()=>writeAllowed})}
  if(name==='@/lib/supabase/client')return {createClient:()=>client}
  if(name==='@/components/ui/modal')return {Modal:({isOpen,title,maxWidth,children,footer})=>isOpen?React.createElement('div',{'aria-label':title,className:maxWidth},children,footer):null}
  if(name==='@/components/ui/data-table')return {DataTable:({children,...props})=>React.createElement('table',props,children)}
  if(name==='sonner')return {toast:{error(){}}}
  if(name.startsWith('@/')||name.startsWith('.')){
   const base=name.startsWith('@/')?path.resolve(__dirname,'../src',name.slice(2)):path.resolve(path.dirname(filename),name)
   const found=['.ts','.tsx'].map(ext=>base+ext).find(fs.existsSync)
   if(found)return load(path.relative(path.resolve(__dirname,'..'),found))
  }
  return require(name)
 }
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,filename)
 cache.set(filename,m.exports);return m.exports
}
const {DeliveryTable}=load('src/components/delivery/DeliveryTable.tsx')
const {RouteCrewCards,RouteCrewDetails}=load('src/components/despacho/RouteCrewDetails.tsx')
const row=n=>({dispatch_id:`d${n}`,request_id:`s${n}`,dispatch_number:String(n),request_number:`RT-${n}`,ot_code:'16543',client_name:'Cliente',pickup_address:'Planta Chilca',delivery_address:'Destino completo',plate:'JRM-001',driver_name:'Conductor',carrier_name:null,modalidad:'PROPIA',scheduled_departure:'2026-10-28T12:00:00Z',guide_number:null,conformity:'PENDIENTE',documents_state:'NO_REQUERIDO',submission_id:null,photos_count:0,submitted_at:null,arrived_at:null,state:'PROGRAMADO',last_event_at:'2026-10-28T11:00:00Z',gps_at:null,events:[{type:'PROGRAMADO',description:'Motivo en bitácora',at:'2026-10-28T11:00:00Z'}]})
const flush=()=>new Promise(resolve=>setTimeout(resolve,15))
const open=async view=>{await act(async()=>view.root.findAllByProps({'aria-label':'Ver detalle'})[0].props.onClick());await act(flush)}

test('tower dispatch column sorts numbers and detail groups data in a wider modal',async()=>{
 calls.length=0;let view
 await act(async()=>{view=create(React.createElement(DeliveryTable,{rows:[row(10089),row(9)],onRefresh(){},showCrewDetails:true,renderManualClose:(r,close)=>React.createElement('button',{onClick:close},`Cerrar operativamente ${r.dispatch_number}`)}))})
 assert.ok(view.root.findAllByType('th').some(node=>node.children.includes('N.º despacho')))
 await act(async()=>view.root.findByType('table').props.onSortChange({column:3,direction:'ascending'}))
 assert.equal(view.root.findByType('tbody').findAllByType('tr')[0].findAllByType('td')[3].children[0],'9')
 await open(view)
 const modal=view.root.findAllByType('div').find(node=>node.props['aria-label']?.startsWith('Detalle · Despacho'))
 assert.ok(modal.props.className.includes('max-w-7xl'))
 const headings=view.root.findAllByType('h3').map(node=>node.children.join(''))
 for(const title of ['Servicio y referencias','Ruta y programación','Unidad y conductor','Documentos y conformidad','Auxiliares y tripulación','Bitácora e historial de avance'])assert.ok(headings.includes(title),title)
 assert.equal(calls.length,1)
 assert.equal(calls[0].args.p_dispatch_id,'d9')
 assert.ok(JSON.stringify(view.toJSON()).includes('12345678'))
 const close=view.root.findAllByType('button').find(node=>node.children.includes('Cerrar operativamente 9'))
 await act(async()=>close.props.onClick())
 assert.equal(view.root.findAllByType('h3').length,0)
 await act(async()=>view.unmount())
})

test('public tracking detail never requests full crew or renders internal close controls',async()=>{
 calls.length=0;let view
 await act(async()=>{view=create(React.createElement(DeliveryTable,{rows:[row(10089)],onRefresh(){}}))})
 await open(view)
 assert.equal(calls.length,0)
 assert.equal(view.root.findAllByProps({'aria-label':'Auxiliares y tripulación'}).length,0)
 assert.ok(!JSON.stringify(view.toJSON()).includes('12345678'))
 assert.ok(!JSON.stringify(view.toJSON()).includes('Cerrar operativamente'))
 await act(async()=>view.unmount())
})

test('crew cards contain operational identity and contacts without exposing the labor record',async()=>{
 let view
 await act(async()=>{view=create(React.createElement(RouteCrewCards,{people:[{...person,salary:'NEVER_SHOW',mock_password:'NEVER_SHOW'}]}))})
 const text=JSON.stringify(view.toJSON())
 for(const value of [person.name,person.code,person.document_number,person.position,person.area,person.phone])assert.ok(text.includes(value),value)
 assert.ok(!text.includes('NEVER_SHOW'))
 await act(async()=>view.unmount())
})

test('crew errors are explicit and retry loads data without claiming no auxiliaries',async()=>{
 fail=true;let view
 await act(async()=>{view=create(React.createElement(RouteCrewDetails,{dispatchId:'d-error'}))})
 await act(flush)
 assert.ok(view.root.findByProps({role:'alert'}))
 fail=false
 await act(async()=>view.root.findByType('button').props.onClick());await act(flush)
 assert.equal(view.root.findAllByProps({role:'alert'}).length,0)
 assert.ok(JSON.stringify(view.toJSON()).includes(person.name))
 await act(async()=>view.unmount())
})


test('private manual closure reason remains visible on a route without auxiliaries',async()=>{
 crewPeople=[];closure={reason:'Retorno confirmado por supervisor',actor_name:'Responsable de Transporte',closed_at:'2026-10-28T12:30:00Z',previous_status:'RETORNO'}
 let view
 await act(async()=>{view=create(React.createElement(RouteCrewDetails,{dispatchId:'without-crew'}))})
 await act(flush)
 const summary=view.root.findByProps({'aria-label':'Cierre operativo manual registrado'})
 const text=JSON.stringify(view.toJSON())
 assert.ok(summary)
 assert.ok(text.includes('Retorno confirmado por supervisor'))
 assert.ok(text.includes('Responsable de Transporte'))
 assert.ok(JSON.stringify(view.toJSON()).includes('Sin auxiliares ni tripulación adicional'))
 await act(async()=>view.unmount())
 crewPeople=[person];closure=null
})

const {ManualOperationalCloseButton}=load('src/components/despacho/ManualOperationalCloseButton.tsx')
test('manual closure requires reason, prevents duplicate submit, reports errors and retries',async()=>{
 let view,resolveRequest,closed=0
 closeResponse=()=>new Promise(resolve=>{resolveRequest=resolve})
 await act(async()=>{view=create(React.createElement(ManualOperationalCloseButton,{dispatchId:'d-close',status:'PROGRAMADO',onClosed(){closed++}}))})
 await act(async()=>view.root.findByType('button').props.onClick())
 let confirm=()=>view.root.findAllByType('button').find(node=>node.children.includes('Confirmar cierre operativo'))
 assert.equal(confirm().props.disabled,true)
 await act(async()=>view.root.findByType('textarea').props.onChange({target:{value:'Acceso cancelado por el cliente'}}))
 const submit=confirm().props.onClick
 calls.length=0
 await act(async()=>{submit();submit()})
 assert.equal(calls.length,1)
 assert.equal(calls[0].args.p_reason,'Acceso cancelado por el cliente')
 await act(async()=>resolveRequest({data:null,error:{message:'Sin permiso para cerrar esta ruta'}}))
 assert.ok(view.root.findByProps({role:'alert'}))
 assert.equal(closed,0)
 closeResponse=async()=>({data:{success:true},error:null})
 await act(async()=>confirm().props.onClick())
 assert.equal(closed,1)
 await act(async()=>view.unmount())
 closeResponse=null
 writeAllowed=false
 await act(async()=>{view=create(React.createElement(ManualOperationalCloseButton,{dispatchId:'d-close',status:'PROGRAMADO',onClosed(){}}))})
 assert.equal(view.toJSON(),null)
 await act(async()=>view.unmount())
 writeAllowed=true
 await act(async()=>{view=create(React.createElement(ManualOperationalCloseButton,{dispatchId:'d-close',status:'CIERRE_OPERATIVO',onClosed(){}}))})
 assert.equal(view.toJSON(),null)
 await act(async()=>view.unmount())
})
