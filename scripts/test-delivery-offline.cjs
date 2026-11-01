const {test} = require('node:test')
const assert = require('node:assert/strict')
const {readFileSync} = require('node:fs')
const ts = require('typescript')
const vm = require('node:vm')
const path = require('node:path')
function fixture(options={}) {
  const values=new Map(),calls=[]
  const context={exports:{},crypto:require('node:crypto').webcrypto,navigator:{onLine:options.online!==false},console:{error(){},warn(){}},Date,JSON,
    localStorage:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)},
    fetch:async()=>({blob:async()=>new Blob(['image'],{type:'image/jpeg'})}),
    require(name){
      if(name==='@/lib/native-route-tracker')return{nativeRouteTracker:null}
      if(name==='@/lib/supabase/client')return{createClient:()=>({
        auth:{getUser:async()=>({data:{user:{id:options.user||'u1'}}})},
        storage:{from:()=>({upload:async(name,_blob,settings)=>{calls.push(['upload',name,settings]);return{error:options.uploadError||null}}})},
        from:table=>({insert:async rows=>{calls.push(['insert',table,rows]);const list=Array.isArray(rows)?rows:[rows]
          const bad=list.find(r=>(options.rejectPoints||[]).includes(r.id));if(bad)return{error:{code:'P0001',message:'Los puntos deben llegar en orden'}}
          if(options.networkError)return{error:{code:'',message:'Failed to fetch'}};return{error:null}}}),
        rpc:async(name,args)=>{calls.push(['rpc',name,args]);return options.rpcError?{error:{message:options.rpcError}}:{data:{success:true,pending_review:true},error:null}}
      })}
      throw Error(name)
    }}
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(__dirname,'../src/lib/route-point-sync.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,context)
  return{api:context.exports,calls,values}
}
const payload={dispatch_id:'d1',request_id:'r1',user_id:'u1',photos_base64:['data:image/jpeg;base64,AAA','data:image/jpeg;base64,BBB'],odometer:'12345.6',odometer_photo_base64:'data:image/jpeg;base64,ODO',received_by:'Receptor',guide:'G1',note:'Firmada',captured_at:'2026-10-05T12:00:00Z'}
test('sin conexión conserva fotos y operación; nunca confirma una entrega local',async()=>{
  const {api,calls}=fixture({online:false});api.saveOfflineAction('delivery_submit_driver',payload,'op1')
  api.saveOfflineAction('delivery_submit_driver',payload,'op1')
  assert.equal(api.readActionQueue().length,1)
  await assert.rejects(api.syncOfflineActions(),/Sin conexión/)
  assert.equal(api.readActionQueue()[0].id,'op1');assert.equal(calls.length,0)
})
test('la recepción confirmada sube todas las fotos con rutas estables y conserva datos de captura',async()=>{
  const {api,calls}=fixture();api.saveOfflineAction('delivery_submit_driver',payload,'op1')
  assert.equal(await api.syncOfflineActions(),0)
  assert.equal(calls.filter(c=>c[0]==='upload').length,3)
  assert.equal(calls[0][1],'u1/d1/r1/op1-0.jpg');assert.equal(calls[0][2].upsert,false)
  assert.equal(calls[2][1],'u1/d1/r1/op1-odometer.jpg')
  const args=calls.at(-1)[2]
  assert.equal(args.p_operation_id,'op1');assert.equal(args.p_payload.captured_at,payload.captured_at)
  assert.equal(args.p_payload.received_by,'Receptor');assert.equal(args.p_payload.photos.length,2)
  assert.equal(args.p_payload.odometer,'12345.6');assert.equal(args.p_payload.odometer_photo,'u1/d1/r1/op1-odometer.jpg')
})
test('un fallo del servidor conserva la cola y muestra su motivo',async()=>{
  const {api}=fixture({rpcError:'GPS pendiente'});api.saveOfflineAction('delivery_submit_driver',payload,'op1')
  assert.equal(await api.syncOfflineActions(),1)
  assert.equal(api.readActionQueue()[0].last_error,'GPS pendiente');assert.equal(api.readActionQueue()[0].status,'error')
})
test('una foto ya subida se reutiliza sin sobrescribir; otros errores no se confunden con duplicados',async()=>{
  const {api}=fixture({uploadError:{statusCode:'409'}});api.saveOfflineAction('delivery_submit_driver',payload,'op1')
  assert.equal(await api.syncOfflineActions(),0)
  const failure=fixture({uploadError:{statusCode:'403',message:'Sin permiso'}});failure.api.saveOfflineAction('delivery_submit_driver',payload,'op2')
  assert.equal(await failure.api.syncOfflineActions(),1);assert.equal(failure.calls.some(c=>c[0]==='rpc'),false)
})
test('otra sesión no puede enviar evidencia guardada por un conductor distinto',async()=>{
  const {api,calls}=fixture({user:'other'});api.saveOfflineAction('delivery_submit_driver',payload,'op1')
  assert.equal(await api.syncOfflineActions(),1);assert.equal(calls.length,0)
  assert.match(api.readActionQueue()[0].last_error,/sesión no corresponde/)
})

const point=(id,second)=>({id,dispatch_id:'d1',driver_id:'v1',recorded_at:`2026-10-18T12:00:${String(second).padStart(2,'0')}.000Z`,latitude:-12,longitude:-77,accuracy_m:5})
test('los puntos GPS suben en lotes ordenados y la cola queda vacía',async()=>{
  const {api,calls,values}=fixture();values.set(api.routeQueueKey,JSON.stringify([point('c',30),point('a',10),point('b',20)]))
  assert.equal(await api.syncRoutePoints(),0)
  const inserts=calls.filter(c=>c[0]==='insert');assert.equal(inserts.length,1);assert.deepEqual(Array.from(inserts[0][2],p=>p.id),['a','b','c'])
  assert.equal(api.readRouteQueue().length,0);assert.deepEqual({...await api.pendingRouteSummary()},{count:0,oldest:null})
})
test('un punto rechazado no traba el lote; un corte de red conserva la cola',async()=>{
  const {api,calls,values}=fixture({rejectPoints:['b']});values.set(api.routeQueueKey,JSON.stringify([point('a',10),point('b',20),point('c',30)]))
  assert.equal(await api.syncRoutePoints(),0)
  assert.deepEqual(calls.filter(c=>c[0]==='insert'&&c[2].length===undefined).map(c=>c[2].id),['a','b','c']);assert.equal(api.readRouteQueue().length,0)
  const offline=fixture({networkError:true});offline.values.set(offline.api.routeQueueKey,JSON.stringify([point('a',10),point('b',20)]))
  await assert.rejects(offline.api.syncRoutePoints(),/Failed to fetch/)
  assert.equal(offline.api.readRouteQueue().length,2);assert.deepEqual({...await offline.api.pendingRouteSummary()},{count:2,oldest:'2026-10-18T12:00:10.000Z'})
})
