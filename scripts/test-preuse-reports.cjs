const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript')
const React=require('react'),{create,act}=require('react-test-renderer')
global.IS_REACT_ACT_ENVIRONMENT=true
function load(file,mock=require,extra={}) {
 const context={exports:{},require:mock,window:{setTimeout,clearTimeout,setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){}},...extra}
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,esModuleInterop:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,context)
 return context.exports
}
const preuse=load('src/lib/preuse.ts',name=>name==='./preuse-format.json'?require('../src/lib/preuse-format.json'):require(name))
const helpers=load('src/lib/preuse-reports.ts')
const day='2026-10-15'
const rows=[
 {operation_id:'one',record_sequence:827,driver_name:'Géder Miguel Amaringo',vehicle_plate:'BDJ-943',license:'L827',inspector_name:'Auditor Álvarez',captured_at:day+'T13:28:07Z',can_operate:true,vehicle_operational:true},
 {operation_id:'two',record_sequence:828,driver_name:'José Pérez',vehicle_plate:'F3R838',license:'L828',inspector_name:'Inspector Torres',captured_at:day+'T13:36:05Z',can_operate:false,vehicle_operational:false},
].map(row=>({...row,operation_date:day,answers:preuse.blankPreuseAnswers().map(a=>({...a,response:'B'})),signature:[],observation:'',soat_expiration:'2027-01-01',technical_review_expiration:'2027-01-01',can_authorize_repeat:true}))
const filters={from:day,to:day,search:'',driver:'',plate:'',inspector:'',result:''}
const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('')
test('preuse filters normalize full-name words, accents and plate punctuation and combine exact fields',()=>{
 for(const query of [{search:'geder amaringo BDJ943'},{plate:'bdj 943',inspector:'alvarez'},{driver:'geder',result:'APTO'},{search:'827'}]) {
   assert.equal(helpers.filterPreuse(rows,{...filters,...query})[0].operation_id,'one')
 }
 assert.equal(helpers.filterPreuse(rows,{...filters,driver:'geder',plate:'F3R838'}).length,0)
 assert.equal(helpers.filterPreuse(rows,{...filters,result:'NO_APTO'})[0].operation_id,'two')
 assert.equal(helpers.sortPreuse(rows,{key:'captured_at',descending:true})[0].operation_id,'two')
 assert.equal(helpers.sortPreuse(rows,{key:'record_sequence',descending:false})[0].operation_id,'one')
 assert.equal(rows[0].operation_id,'one','sorting does not mutate cached query data')
})
function reportFixture(rpc) {
 const calls=[],exports=[]
 const client={rpc:async(name,args)=>{calls.push({name,args});return rpc?rpc(name,args):{data:rows,error:null}}}
 const {PreuseReports}=load('src/components/driver/PreuseReports.tsx',name=>{
   if(name==='@/lib/supabase/client')return{createClient:()=>client}
   if(name==='@/lib/preuse')return{...preuse,limaDay:()=>day}
   if(name==='@/lib/preuse-reports')return helpers
   if(name==='@/lib/preuse-pdf')return{exportPreusePdf:async(...args)=>exports.push(args)}
   if(name==='@/components/ui/data-table')return{DataTable:({children})=>React.createElement('table',null,children)}
   if(name==='@/components/ui/modal')return{Modal:({children})=>React.createElement('section',null,children)}
   if(name==='@/lib/caja')return{errorMessage:e=>e?.message||String(e)}
   if(name==='sonner')return{toast:{success(){},error(){}}}
   return require(name)
 })
 return{Component:PreuseReports,calls,exports}
}
async function mount(Component){let tree;await act(async()=>{tree=create(React.createElement(Component))});await act(async()=>{await new Promise(r=>setTimeout(r,20))});return tree}
test('report sorts actual rows and downloads only the selected record; changed filters disable export until applied',async()=>{
 const fixture=reportFixture(),tree=await mount(fixture.Component)
 const body=()=>tree.root.findByType('tbody')
 assert.match(text(body().findAllByType('tr')[0]),/828/)
 await act(async()=>tree.root.findAllByType('button').find(b=>text(b)==='Conductor↕').props.onClick())
 assert.match(text(body().findAllByType('tr')[0]),/827/)
 await act(async()=>body().findAllByType('tr')[0].findAllByType('button').find(b=>text(b)==='PDF').props.onClick())
 assert.equal(fixture.exports.length,1);assert.equal(fixture.exports[0][0].length,1);assert.equal(fixture.exports[0][0][0].operation_id,'one')
 assert.match(fixture.exports[0][3],/BDJ943_2026-10-15_827\.pdf/)
 await act(async()=>tree.root.findAllByType('label').find(l=>text(l)==='Placa').findByType('input').props.onChange({target:{value:'BDJ 943'}}))
 assert.equal(tree.root.findAllByType('button').find(b=>text(b)==='Exportar resultados PDF').props.disabled,true)
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 assert.equal(body().findAllByType('tr').length,1);assert.match(text(body()),/827/)
 assert.match(fixture.calls.at(-1).args.p_search,/BDJ 943/)
 await act(async()=>tree.unmount())
})
test('reinspection button sends the selected operation and explicit reason; read-only users get no authorization button',async()=>{
 const fixture=reportFixture((name)=>({data:name==='authorize_driver_preuse_repeat'?{success:true}:rows,error:null})),tree=await mount(fixture.Component)
 await act(async()=>tree.root.findAllByType('button').find(b=>text(b)==='Autorizar reinspección').props.onClick())
 await act(async()=>tree.root.findByType('textarea').props.onChange({target:{value:'Unidad reparada y revisada por mantenimiento'}}))
 await act(async()=>tree.root.findAllByType('form').at(-1).props.onSubmit({preventDefault(){}}))
 const call=fixture.calls.find(c=>c.name==='authorize_driver_preuse_repeat')
 assert.equal(call.args.p_operation,'two');assert.match(call.args.p_reason,/Unidad reparada/)
 await act(async()=>tree.unmount())
 const readonly=reportFixture(()=>({data:rows.map(row=>({...row,can_authorize_repeat:false})),error:null})),readonlyTree=await mount(readonly.Component)
 assert.equal(readonlyTree.root.findAllByType('button').some(b=>text(b)==='Autorizar reinspección'),false)
 await act(async()=>readonlyTree.unmount())
})
test('late query responses cannot replace the currently applied filters and records',async()=>{
 const pending=[];const fixture=reportFixture(()=>new Promise(resolve=>pending.push(resolve))),tree=await mount(fixture.Component)
 await act(async()=>tree.root.findAllByType('label').find(l=>text(l)==='Placa').findByType('input').props.onChange({target:{value:'BDJ943'}}))
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 await act(async()=>pending[1]({data:[rows[0]],error:null}))
 await act(async()=>pending[0]({data:[rows[1]],error:null}))
 assert.match(text(tree.root.findByType('tbody')),/827/)
 assert.doesNotMatch(text(tree.root.findByType('tbody')),/828/)
 await act(async()=>tree.unmount())
})
function appFixture({registered=true,authorized=false,queued=false}={}) { let currentDay=day; const intervals=[]
 const calls=[],context={operation_date:day,driver:{id:'driver',profile_id:'profile',name:'Geder',license:'L'},vehicles:[{plate:'BDJ943'},{plate:'F3R838'}],unit:{vehicle_plate:'BDJ943',revision:'revision',operation_date:day},latest:null,pending:false,route_plate:null,
 daily_record:registered?{...rows[0],vehicle_plate:'BDJ943'}:null,already_registered:registered&&!authorized,repeat_authorized:authorized}
 const client={rpc:async(name,args)=>{calls.push({name,args});return{data:name==='select_driver_preuse_unit'?{...context.unit,...{daily_record:context.daily_record,already_registered:context.already_registered,repeat_authorized:authorized}}:currentDay===day?context:{...context,operation_date:currentDay,unit:{...context.unit,operation_date:currentDay},daily_record:null,already_registered:false},error:null}}}
 const {default:Component}=load('src/app/app/(app)/checklist/page.tsx',name=>{
   if(name==='@/lib/supabase/client')return{createClient:()=>client}
   if(name==='@/contexts/ActiveTripContext')return{useActiveTrip:()=>({refresh:async()=>{},assigned_unit:undefined})}
   if(name==='@/lib/preuse')return{...preuse,limaDay:()=>currentDay}
   if(name==='dexie-react-hooks')return{useLiveQuery:()=>queued?[{operation_id:'pending',vehicle_plate:'BDJ943',operation_date:day}]:[]}
   if(name==='@/lib/offline/db')return{db:{preuse:{}}}
   if(name==='@/lib/offline/preuse-runtime')return{syncOwnPreuse:async()=>{}}
   if(name==='@/components/driver/PreuseSignature')return{PreuseSignature:()=>null}
   if(name==='@/lib/caja')return{errorMessage:e=>e?.message||String(e)}
   if(name==='@/lib/odometer')return{fileToDataUrl:async()=>'data:image/jpeg;base64,',formatKm:v=>`${v} km`,odometerPhotoPath:(p,o)=>`${p}/odometro/${o}.jpg`,prepareOdometerPhoto:async f=>f,uploadOdometerPhoto:async(_,path)=>path}
   if(name==='next/link')return({children})=>React.createElement('a',null,children)
   if(name==='sonner')return{toast:{success(){},warning(){},error(){}}}
   return require(name)
 },{window:{setTimeout,clearTimeout,setInterval:callback=>{intervals.push(callback);return intervals.length},clearInterval(){},addEventListener(){},removeEventListener(){}},localStorage:{getItem:()=>null,setItem(){},removeItem(){}},navigator:{onLine:true},crypto:require('node:crypto').webcrypto})
 return{Component,calls,intervals,advanceDay:next=>{currentDay=next}}
}
test('driver sees saved inspection and cannot start a second one; queued offline record also blocks a new form',async()=>{
 for(const options of [{registered:true},{registered:false,queued:true}]) {
  const f=appFixture(options),tree=await mount(f.Component)
  const button=tree.root.findAllByType('button').find(b=>/Checklist del día registrado|Checklist pendiente de sincronizar/.test(text(b)))
  assert.equal(button.props.disabled,true)
  assert.equal(tree.root.findAllByType('form').length,0)
  assert.equal(f.calls.some(c=>c.name==='submit_driver_preuse'),false)
  await act(async()=>tree.unmount())
 }
})
test('authorized driver can open a fresh inspection while retaining the existing read-only daily record',async()=>{
 const f=appFixture({registered:true,authorized:true}),tree=await mount(f.Component)
 const button=tree.root.findAllByType('button').find(b=>text(b)==='Registrar reinspección autorizada')
 assert.equal(button.props.disabled,false)
 await act(async()=>button.props.onClick())
 assert.equal(tree.root.findAllByType('form').length,1)
 assert.equal(f.calls.find(c=>c.name==='select_driver_preuse_unit').args.p_plate,'BDJ943')
 await act(async()=>tree.unmount())
})
test('offline sync distinguishes an already recorded daily inspection without retrying or counting it as a new inspection',async()=>{
 const {syncPreuseRecords}=load('src/lib/offline/preuse-sync.ts'),changes=[]
 const data={operation_id:'new-operation',profile_id:'profile',data:{original:'payload'},synced:0}
 const result=await syncPreuseRecords({pending:async()=>[data],user:async()=> 'profile',submit:async()=>({data:{success:true,already_registered:true},error:null}),update:async(id,patch)=>changes.push({id,patch})})
 assert.equal(result.duplicates,1);assert.equal(result.synced,0);assert.equal(result.pending,0)
 assert.equal(changes[0].patch.synced,1);assert.match(changes[0].patch.last_error,/No se creó/)
 assert.equal(data.data.original,'payload','local evidence is retained')
})

test('a saved checklist unlocks the new operating day when the driver leaves the page open overnight',async()=>{
 const f=appFixture(),tree=await mount(f.Component)
 assert.equal(tree.root.findAllByType('button').find(b=>text(b)==='Checklist del día registrado').props.disabled,true)
 f.advanceDay('2026-10-16')
 await act(async()=>{f.intervals.at(-1)();await new Promise(r=>setTimeout(r,10))})
 assert.ok(f.calls.filter(c=>c.name==='get_driver_preuse_context').length>=2)
 assert.equal(tree.root.findAllByType('button').find(b=>text(b)==='Confirmar unidad e iniciar inspección').props.disabled,false)
 await act(async()=>tree.unmount())
})
